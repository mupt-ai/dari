"""Synchronized attribution on the independent prefill, not a throughput benchmark."""

from collections import defaultdict
from pathlib import Path
from time import perf_counter
import mlx.core as mx
from tokenizers import Tokenizer
from huggingface_hub import snapshot_download
from dari_engine.engines.inkling import inkling_model as im
from benchmarks.benchmark_lock import exclusive_gpu

lock = exclusive_gpu()
path = Path(
    snapshot_download(
        "mlx-community/Inkling-2-Mini-4bit",
        revision="9c0e2960609ba7cb40daf92c6f7bf8ed56e1dd62",
        allow_patterns=["*.json", "*.jinja", "*.safetensors"],
        local_files_only=True,
    )
)
model = im.Model(path)
tok = Tokenizer.from_file(str(path / "tokenizer.json"))
ids = mx.array(
    [
        tok.encode(
            "The lake was blue and the sky was clear. " * 100
            + "Count from one to fifty in English:"
        ).ids
    ]
)
totals = defaultdict(float)


def instrument(name, fn):
    def run(*args, **kwargs):
        if name == "linear":
            ready = [args[2]]
            label = args[1]
        else:
            ready = [a for a in args if isinstance(a, mx.array)]
            ready += [
                t
                for a in args
                if isinstance(a, list)
                for t in a
                if isinstance(t, mx.array)
            ]
            label = name
        mx.eval(*ready)
        t = perf_counter()
        out = fn(*args, **kwargs)
        mx.eval(out)
        totals[label] += perf_counter() - t
        return out

    return run


for name in (
    "linear",
    "mix",
    "rms",
    "gate_input",
    "gate_mix",
    "normalize",
    "striped",
    "static_fir",
    "dynamic_fir",
):
    setattr(im, name, instrument(name, getattr(im, name)))
model.experts = [instrument("experts", f) for f in model.experts]
for r in range(3):
    totals.clear()
    c = [{} for _ in range(48)]
    t = perf_counter()
    mx.eval(model(ids, c))
    elapsed = perf_counter() - t
    print(
        r,
        "total ms",
        round(elapsed * 1000),
        "attributed ms",
        [(k, round(v * 1000)) for k, v in sorted(totals.items(), key=lambda p: -p[1])],
        flush=True,
    )
