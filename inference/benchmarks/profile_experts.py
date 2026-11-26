"""Isolate expert latency on real layer inputs (synchronization adds overhead)."""

import time
from pathlib import Path

import mlx.core as mx
from huggingface_hub import snapshot_download
from tokenizers import Tokenizer

from dari_engine.engines.inkling.inkling_model import Model

p = Path(
    snapshot_download(
        "mlx-community/Inkling-2-Mini-4bit",
        revision="9c0e2960609ba7cb40daf92c6f7bf8ed56e1dd62",
        local_files_only=True,
        allow_patterns=["*.json", "*.jinja", "*.safetensors"],
    )
)
tok = Tokenizer.from_file(str(p / "tokenizer.json"))
m = Model(p)
samples = []


def wrap(i, expert):
    def call(x):
        mx.eval(x)
        t = time.perf_counter()
        y = expert(x)
        mx.eval(y)
        samples.append((i, time.perf_counter() - t))
        return y

    return call


m.experts = [wrap(i, e) for i, e in enumerate(m.experts)]
for run in range(3):
    ids = tok.encode(
        "The lake was blue and the sky was clear. " * 100
        + "Count from one to fifty in English:"
    ).ids
    x = mx.array([ids])
    c = [{} for _ in range(48)]
    for step in range(3):
        samples.clear()
        start = time.perf_counter()
        v = mx.argmax(m(x, c)).item()
        x = mx.array([[v]])
        total = time.perf_counter() - start
        print(
            run,
            step,
            "total, nvfp4 experts, mxfp8 experts (ms)",
            *[
                round(1000 * s, 1)
                for s in (
                    total,
                    sum(t for i, t in samples if i < 20),
                    sum(t for i, t in samples if i >= 20),
                )
            ],
            flush=True,
        )
