"""Measure real-routed MoE stage costs over all 48 visits on a fresh prompt."""

from collections import defaultdict
from time import perf_counter
import mlx.core as mx
from dari_engine.engines.inkling.inkling_top8 import top8
from dari_engine.engines.inkling.inkling_moe import activate
from benchmarks.benchmark_lock import exclusive_gpu
from pathlib import Path
from huggingface_hub import snapshot_download
from tokenizers import Tokenizer

lock = exclusive_gpu()
path = Path(
    snapshot_download(
        "mlx-community/Inkling-2-Mini-4bit",
        revision="9c0e2960609ba7cb40daf92c6f7bf8ed56e1dd62",
        allow_patterns=["*.json", "*.jinja", "*.safetensors"],
        local_files_only=True,
    )
)
ids = mx.array(
    [
        Tokenizer.from_file(str(path / "tokenizer.json"))
        .encode(
            "The lake was blue and the sky was clear. " * 100
            + "Count from one to fifty in English:"
        )
        .ids
    ]
)
from dari_engine.engines.inkling.inkling_model import Model

totals = defaultdict(float)


def stage(label, fn):
    start = perf_counter()
    value = fn()
    mx.eval(value)
    totals[label] += perf_counter() - start
    return value


def wrap(expert):
    def call(x):
        mx.eval(x)
        sel, c = stage(
            "route", lambda: top8(x.astype(mx.float32) @ expert.router.T, expert.bias)
        )
        flat = sel.flatten()
        order, inv, idx, inp = stage("sort and gather", lambda: perm(flat, x))

        def proj(x, w):
            return mx.gather_qmm(
                x,
                *w[:2],
                global_scale=w[2],
                rhs_indices=idx,
                sorted_indices=True,
                group_size=expert.group,
                bits=expert.bits,
                mode=expert.mode,
            )

        y = stage("expand " + expert.mode, lambda: proj(inp, expert.expand))
        a = stage("activate", lambda: activate(y))
        o = stage("down " + expert.mode, lambda: proj(a, expert.contract))
        return stage(
            "reweight and sum",
            lambda: (
                (
                    o.squeeze(-2)[inv]
                    .reshape(*sel.shape, x.shape[-1])
                    .astype(mx.float32)
                    * c[..., None]
                )
                .sum(axis=-2)
                .astype(x.dtype)
            ),
        )

    return call


def perm(flat, x):
    o = mx.argsort(flat)
    return o, mx.argsort(o), flat[o], x.reshape(-1, 1, x.shape[-1])[o // 8]


model = Model(path)
model.experts = [wrap(f) for f in model.experts]
for i in range(3):
    totals.clear()
    mx.eval(model(ids, [{} for _ in range(48)]))
    print(
        "expert stages", i, {k: round(t * 1000) for k, t in totals.items()}, flush=True
    )
