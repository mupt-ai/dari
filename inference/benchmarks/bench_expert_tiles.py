"""Compare sorted-vector vs tiled quantized expert GEMMs on a single real projection."""

import json
import statistics
import time
from pathlib import Path

import mlx.core as mx
from huggingface_hub import snapshot_download

p = Path(
    snapshot_download(
        "mlx-community/Inkling-2-Mini-4bit",
        revision="9c0e2960609ba7cb40daf92c6f7bf8ed56e1dd62",
        allow_patterns=["*.json", "*.safetensors", "*.jinja"],
        local_files_only=True,
    )
)
index = json.loads((p / "model.safetensors.index.json").read_text())["weight_map"]
prefix = "model.language_model.layers.0.mlp.experts.gate_up_proj."


def get(k):
    key = prefix + k
    return mx.load(str(p / index[key]))[key]


w, sc, gs = [get(k) for k in ("weight", "scales", "global_scale")]
E, N, _ = w.shape
K = w.shape[-1] * 8
mx.random.seed(19)
n = 8064
x = mx.random.normal((n, 1, K)).astype(mx.bfloat16)
idx = mx.sort(mx.random.randint(0, E, (n,))).astype(mx.uint32)
mx.eval(x, idx, w, sc, gs)
starts = mx.searchsorted(idx, mx.arange(E + 1).astype(idx.dtype))
mx.eval(starts)
opts = dict(group_size=16, bits=4, mode="nvfp4", global_scale=gs)
ref = mx.gather_qmm(x, w, sc, rhs_indices=idx, sorted_indices=True, **opts)
mx.eval(ref)
for tile in (1, "ragged", 8, 16, 32, 64):
    times = []
    for rep in range(6):
        t = time.perf_counter()
        if tile == 1:
            y = mx.gather_qmm(x, w, sc, rhs_indices=idx, sorted_indices=True, **opts)
        elif tile == "ragged":
            boundaries = starts.tolist()
            pieces = []
            for e, (lo, hi) in enumerate(zip(boundaries, boundaries[1:])):
                if hi > lo:
                    pieces.append(
                        mx.gather_qmm(
                            x[lo:hi, 0],
                            w[e : e + 1],
                            sc[e : e + 1],
                            group_size=16,
                            bits=4,
                            mode="nvfp4",
                            global_scale=gs[e : e + 1],
                            rhs_indices=mx.array([0], mx.uint32),
                        )
                    )
            y = mx.concatenate([v.reshape(-1, N) for v in pieces])[:, None]
        else:
            # Upper bound on the sum of individually rounded expert counts.
            nt = (n + tile - 1) // tile + E - 1
            ends = mx.cumsum((starts[1:] - starts[:-1] + tile - 1) // tile)
            bases = ends - (starts[1:] - starts[:-1] + tile - 1) // tile
            tids = mx.arange(nt)
            e = mx.minimum(mx.searchsorted(ends, tids, side="right"), E - 1)
            rid = (
                starts[e, None]
                + (tids - bases[e])[:, None] * tile
                + mx.arange(tile)[None, :]
            )
            inputs = x[mx.minimum(rid, n - 1), 0]
            out = mx.gather_qmm(inputs, w, sc, rhs_indices=e.astype(mx.uint32), **opts)
            back = bases[idx] * tile + mx.arange(n) - starts[idx]
            y = out.reshape(-1, 1, N)[back]
        mx.eval(y)
        elapsed = time.perf_counter() - t
        if rep:
            times.append(elapsed * 1000)
    err = mx.linalg.norm(
        y.astype(mx.float32) - ref.astype(mx.float32)
    ) / mx.linalg.norm(ref.astype(mx.float32))
    print(
        tile,
        "ms",
        round(statistics.median(times), 3),
        "relative RMS",
        err.item(),
        flush=True,
    )
