"""Compare real hidden states across all visits, loading one model at a time."""

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

import mlx.core as mx
import numpy as np
from huggingface_hub import snapshot_download
from tokenizers import Tokenizer

PROMPT = "Explain how a database recovers from a crash using its write-ahead log:"


def trace(backend, path, prompt):
    p = Path(
        snapshot_download(
            "mlx-community/Inkling-2-Mini-4bit",
            revision="9c0e2960609ba7cb40daf92c6f7bf8ed56e1dd62",
            allow_patterns=["*.json", "*.safetensors", "*.jinja"],
            local_files_only=True,
        )
    )
    ids = Tokenizer.from_file(str(p / "tokenizer.json")).encode(prompt).ids
    snapshots = {}

    visited = 0

    def record(x):
        nonlocal visited
        visited += 1
        snapshots[f"step_{(visited - 1) // 48}_visit_{(visited - 1) % 48:02}"] = (
            np.array(x.astype(mx.float32))
        )

    if backend == "reference":
        from mlx_lm import load
        from mlx_lm.models.inkling2.layers import DecoderLayer

        model, _ = load(str(p), lazy=True)
        original = DecoderLayer.__call__

        def observe(layer, *args, **kwargs):
            x, bank = original(layer, *args, **kwargs)
            record(x)
            return x, bank

        DecoderLayer.__call__ = observe
        cache = model.make_cache()

        def forward(x):
            return model.lm_head(model.model.language_model(x, cache=cache)[:, -1:])[
                ..., :200058
            ]
    else:
        from dari_engine.engines.inkling.inkling_model import Model

        model = Model(p)
        original = model.block

        def observe(*args, **kwargs):
            x, bank = original(*args, **kwargs)
            record(x)
            return x, bank

        model.block = observe
        cache = [{} for _ in range(48)]

        def forward(x):
            return model(x, cache)

    # Identical forced decode input, even when prefill predictions disagree.
    for step, chunk in enumerate((ids, [ids[-1]])):
        logits = forward(mx.array([chunk]))
        snapshots[f"logits_{step}"] = np.array(logits.astype(mx.float32))
    np.savez(path, **snapshots)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt", default=PROMPT)
    parser.add_argument("--capture", choices=["reference", "ours"])
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.capture:
        trace(args.capture, args.output, args.prompt)
    else:
        with tempfile.TemporaryDirectory() as tmp:
            files = []
            for arm in ("reference", "ours"):
                path = Path(tmp) / (arm + ".npz")
                subprocess.run(
                    [
                        sys.executable,
                        "-m",
                        "benchmarks.compare_visits",
                        "--capture",
                        arm,
                        "--output",
                        str(path),
                        "--prompt",
                        args.prompt,
                    ],
                    check=True,
                )
                files.append(np.load(path))
            a, b = files
            assert a.files == b.files and len(a.files) == 98
            for k in a.files:
                x, y = a[k], b[k]
                if k == "step_0_visit_47" and x.shape != y.shape:
                    x = x[:, -y.shape[1]:]
                print(
                    k,
                    "relative RMS",
                    f"{np.linalg.norm(x - y) / np.linalg.norm(x):.5f}",
                    "top1 " + str((int(x.argmax()), int(y.argmax())))
                    if k.startswith("logits")
                    else "",
                )
