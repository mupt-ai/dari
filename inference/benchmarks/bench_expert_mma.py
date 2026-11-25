"""Compare sorted-vector vs independent SIMD-matrix expert GEMMs on a single real projection."""

import json
import statistics
import time
from pathlib import Path

import mlx.core as mx
from huggingface_hub import snapshot_download

from experiments.shaders import load_shader

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
opts = {"group_size": 16, "bits": 4, "mode": "nvfp4", "global_scale": gs}
ref = mx.gather_qmm(x, w, sc, rhs_indices=idx, sorted_indices=True, **opts)
mx.eval(ref)
# Precompute exact E4M3 scale decoding; global_scale is one value per expert.
lut = mx.dequantize(
    mx.full((256, 2), 0x22222222, mx.uint32),
    mx.arange(256).astype(mx.uint8)[:, None],
    group_size=16,
    bits=4,
    mode="nvfp4",
    global_scale=mx.array(2688.0),
    dtype=mx.float32,
)[:, 0]
lut = (
    (
        lut[None, :, None]
        * (gs[:, None, None] / 2688.0)
        * mx.array([0, 0.5, 1, 1.5, 2, 3, 4, 6])[None, None, :]
    )
    .astype(mx.bfloat16)
    .astype(mx.float16)
)
source = load_shader("fp4_group_mma.metal")
kern = mx.fast.metal_kernel(
    name="inkling_fp4_group_mma",
    input_names=["x", "w", "sc", "globals", "lut", "offsets", "base", "experts"],
    output_names=["y"],
    source=source,
)
for bm, bn, bk in [
    (32, 32, 32),
    (32, 64, 32),
    (32, 64, 64),
    (64, 64, 32),
    (16, 64, 32),
]:
    count = (starts[1:] - starts[:-1] + bm - 1) // bm
    ends = mx.cumsum(count)
    base = ends - count
    nt = (n + bm - 1) // bm + E - 1
    experts = mx.searchsorted(ends, mx.arange(nt), side="right")
    mx.eval(lut, base, experts)

    def pack(t, divisor, bn=bn, bk=bk):
        return mx.contiguous(
            t.reshape(E, N // bn, bn, K // bk, bk // divisor).transpose(0, 1, 3, 2, 4)
        )

    wp, sp = pack(w, 8), pack(sc, 16)
    mx.eval(wp, sp)
    ts = []
    bs = []
    for rep in range(5):
        for arm in (0, 1) if rep % 2 else (1, 0):
            t = time.perf_counter()
            if arm:
                y = kern(
                    inputs=[x, wp, sp, gs, lut, starts, base, experts],
                    template=[("K", K), ("N", N), ("BM", bm), ("BN", bn), ("BK", bk)],
                    grid=(128 * N // bn, nt, 1),
                    threadgroup=(128, 1, 1),
                    output_shapes=[ref.shape],
                    output_dtypes=[mx.bfloat16],
                )[0]
            else:
                y = mx.gather_qmm(
                    x, w, sc, rhs_indices=idx, sorted_indices=True, **opts
                )
            mx.eval(y)
            dt = time.perf_counter() - t
            if rep:
                (ts if arm else bs).append(dt * 1000)
            if arm and rep == 0:
                err = (
                    mx.linalg.norm(y.astype(mx.float32) - ref.astype(mx.float32))
                    / mx.linalg.norm(ref.astype(mx.float32))
                ).item()
    print(
        (bm, bn, bk),
        "ms packed / MMA",
        statistics.median(bs),
        statistics.median(ts),
        "relative RMS",
        err,
        flush=True,
    )
