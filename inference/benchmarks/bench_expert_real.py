"""Compare grouped expert expansion on actual first-visit router inputs, load offline."""

import json
import statistics
import time
from pathlib import Path

import mlx.core as mx
from huggingface_hub import snapshot_download
from tokenizers import Tokenizer
from benchmarks.benchmark_lock import exclusive_gpu
from dari_engine.engines.inkling.inkling_block import PreludeBlock, rms
from dari_engine.engines.inkling.inkling_top8 import top8

lock = exclusive_gpu()
p = Path(
    snapshot_download(
        "mlx-community/Inkling-2-Mini-4bit",
        revision="9c0e2960609ba7cb40daf92c6f7bf8ed56e1dd62",
        local_files_only=True,
        allow_patterns=["*.json", "*.jinja", "*.safetensors"],
    )
)
index = json.loads((p / "model.safetensors.index.json").read_text())["weight_map"]
keys = [
    k
    for k in index
    if any(
        k.startswith("model.language_model." + s)
        for s in ("layers.0.", "embed_tokens.", "embed_norm.")
    )
]
w = {}
for shard in {index[k] for k in keys}:
    d = mx.load(str(p / shard))
    w.update({k: d[k] for k in keys if index[k] == shard})
    del d
ids = mx.array(
    [
        Tokenizer.from_file(str(p / "tokenizer.json"))
        .encode(
            "The lake was blue and the sky was clear. " * 100
            + "Count from one to fifty in English:"
        )
        .ids
    ]
)
e = "model.language_model.embed_tokens."
x = rms(
    mx.dequantize(
        *[w[e + k][ids] for k in ("weight", "scales", "biases")], bits=4, group_size=64
    ),
    w["model.language_model.embed_norm.weight"],
)
block = PreludeBlock(w)
moe = block.moe


class Captured(Exception):
    pass


def capture(x):
    global states
    states = x
    raise Captured()


block.moe = capture
try:
    block(x, {})
except Captured:
    pass
ids, _ = top8(states.astype(mx.float32) @ moe.router.T, moe.bias)
flat = ids.flatten()
order = mx.argsort(flat)
idx = flat[order]
x = states.reshape(-1, 1, states.shape[-1])[order // 8]
w, s, g = moe.expand
E, N, _ = w.shape
K = x.shape[-1]
n = idx.size
starts = mx.searchsorted(idx, mx.arange(E + 1).astype(idx.dtype))
bounds = starts.tolist()
print(
    "expert row count range",
    min(b - a for a, b in zip(bounds, bounds[1:])),
    max(b - a for a, b in zip(bounds, bounds[1:])),
    flush=True,
)
dense = mx.stack(
    [
        mx.dequantize(
            w[i],
            s[i],
            group_size=16,
            bits=4,
            mode="nvfp4",
            global_scale=g[i],
            dtype=mx.bfloat16,
        ).astype(mx.float16)
        for i in range(E)
    ]
)
mx.eval(dense, x, idx)


def compute(arm):
    if arm == "packed":
        return mx.gather_qmm(
            x,
            w,
            s,
            rhs_indices=idx,
            sorted_indices=True,
            group_size=16,
            bits=4,
            mode="nvfp4",
            global_scale=g,
        )
    if arm == "dense":
        return mx.gather_mm(
            x.astype(mx.float16),
            dense.swapaxes(-2, -1),
            rhs_indices=idx,
            sorted_indices=True,
        ).astype(mx.bfloat16)
    if arm == "ragged":
        return mx.concatenate(
            [
                (x[a:b, 0].astype(mx.float16) @ dense[i].T)
                for i, (a, b) in enumerate(zip(bounds, bounds[1:]))
                if b > a
            ]
        )[:, None].astype(mx.bfloat16)
    t = arm
    counts = (starts[1:] - starts[:-1] + t - 1) // t
    ends = mx.cumsum(counts)
    base = ends - counts
    tids = mx.arange((n + t - 1) // t + E - 1)
    experts = mx.minimum(mx.searchsorted(ends, tids, side="right"), E - 1)
    rows = (
        starts[experts, None]
        + (tids - base[experts])[:, None] * t
        + mx.arange(t)[None, :]
    )
    a = x[mx.minimum(rows, n - 1), 0].astype(mx.float16)
    out = mx.gather_mm(a, dense.swapaxes(-2, -1), rhs_indices=experts.astype(mx.uint32))
    back = base[idx] * t + mx.arange(n) - starts[idx]
    return out.reshape(-1, 1, N)[back].astype(mx.bfloat16)


def compare():
    ref = compute("packed")
    mx.eval(ref)
    times = {k: [] for k in ["packed", "dense", "ragged", 16, 32, 64]}
    for r in range(6):
        for key in list(times)[:: 1 if r % 2 else -1]:
            t = time.perf_counter()
            y = compute(key)
            mx.eval(y)
            dt = 1000 * (time.perf_counter() - t)
            if r:
                times[key].append(dt)
            else:
                print(
                    key,
                    "relative RMS",
                    (
                        mx.linalg.norm(y.astype(mx.float32) - ref)
                        / mx.linalg.norm(ref.astype(mx.float32))
                    ).item(),
                    flush=True,
                )
    print(
        "median milliseconds",
        {k: round(statistics.median(v), 2) for k, v in times.items()},
        flush=True,
    )


if __name__ == "__main__":
    compare()
