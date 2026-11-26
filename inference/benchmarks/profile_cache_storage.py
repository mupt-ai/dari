"""Trace global KV backing addresses across real one-token forwards (not throughput).

PYTHONPATH=. .venv/bin/python -m benchmarks.profile_cache_storage --length 8192

On Apple unified memory a NumPy view of an evaluated MLX buffer exposes its
address. Retain only the integer address, never the array or a NumPy/memoryview:
a live view would itself prevent MLX from donating the buffer on update. An
address change shows replacement, not necessarily bytes transferred. Explicit
cache synchronizations make these diagnostic timings unfit for speed claims.
"""

import argparse
import json
from pathlib import Path
from time import perf_counter

import mlx.core as mx
import numpy as np
from huggingface_hub import snapshot_download
from tokenizers import Tokenizer

from benchmarks.benchmark_lock import exclusive_gpu
from benchmarks.long_context import REVISION, prompt
from dari_engine.engines.inkling.inkling_model import Model


def addr(a):
    # NumPy doesn't natively represent bf16. Bitcast, don't convert the values.
    return np.asarray(a.view(mx.uint16)).__array_interface__["data"][0]


def snapshot(cache):
    # There are 48 visits; every sixth visit is global attention in this model.
    return {
        f"{visit}.{kind}": (addr(a), a.nbytes)
        for visit, c in enumerate(cache)
        if visit % 6 == 5
        for kind, a in zip(("k", "v"), c["storage"], strict=True)
    }


def memory():
    return {
        "active_mib": round(mx.get_active_memory() / 2**20, 2),
        "free_cache_mib": round(mx.get_cache_memory() / 2**20, 2),
        "peak_active_mib": round(mx.get_peak_memory() / 2**20, 2),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--length", type=int, default=8192)
    parser.add_argument("--steps", type=int, default=8)
    args = parser.parse_args()
    if args.steps < 1:
        parser.error("positive step count required")
    lock = exclusive_gpu()
    path = Path(
        snapshot_download(
            "mlx-community/Inkling-2-Mini-4bit",
            revision=REVISION,
            allow_patterns=["*.json", "*.safetensors", "*.jinja"],
            local_files_only=True,
        )
    )
    model = Model(path)
    ids = prompt(Tokenizer.from_file(str(path / "tokenizer.json")), args.length)
    cache = [{} for _ in range(48)]
    for off in range(0, len(ids), 1024):
        logits = model(mx.array([ids[off : off + 1024]]), cache)
        mx.eval(logits)
    token = mx.argmax(logits).item()
    del logits
    previous = snapshot(cache)
    print(
        json.dumps(
            {
                "phase": "prefilled",
                "length": len(ids),
                "global_buffers": len(previous),
                "global_capacity_mib": sum(n for _, n in previous.values()) / 2**20,
                **memory(),
            }
        ),
        flush=True,
    )
    for i in range(args.steps):
        mx.reset_peak_memory()
        start = perf_counter()
        token = mx.argmax(model(mx.array([[token]]), cache)).item()
        elapsed = perf_counter() - start
        current = snapshot(cache)
        changed = [k for k in previous if previous[k][0] != current[k][0]]
        print(
            json.dumps(
                {
                    "phase": "decode",
                    "offset": len(ids) + i,
                    "token": token,
                    "sync_ms": round(1000 * elapsed, 2),
                    "relocated": changed,
                    "grown": [k for k in previous if previous[k][1] != current[k][1]],
                    "relocated_capacity_mib": sum(current[k][1] for k in changed)
                    / 2**20,
                    **memory(),
                }
            ),
            flush=True,
        )
        previous = current
    lock.close()


if __name__ == "__main__":
    main()
