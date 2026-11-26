"""Benchmark fresh-cache prompt ingestion including the head on every chunk."""

import random
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
        allow_patterns=["*.json", "*.safetensors", "*.jinja"],
        local_files_only=True,
    )
)
m = Model(p)
tok = Tokenizer.from_file(str(p / "tokenizer.json"))
ids = tok.encode(
    "The lake was blue and the sky was clear. " * 100
    + "Count from one to fifty in English:"
).ids
for rep in range(4):
    sizes = [128, 256, 512, len(ids)]
    random.Random(1337 + rep).shuffle(sizes)
    for n in sizes:
        c = [{} for _ in range(48)]
        t = time.perf_counter()
        for off in range(0, len(ids), n):
            logits = m(mx.array([ids[off : off + n]]), c)
            mx.eval(logits)
        value = mx.argmax(logits).item()
        print(rep, n, round(len(ids) / (time.perf_counter() - t), 2), value, flush=True)
