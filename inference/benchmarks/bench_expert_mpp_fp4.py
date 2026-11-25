"""Compare fused gate/up GEMM + activation against native packed execution."""

import statistics
import time

import mlx.core as mx

from benchmarks.bench_expert_real import E, K, N, compute, g, idx, n, s, w, x
from experiments.shaders import load_shader
from inkling.inkling_moe import activate

kernel = mx.fast.metal_kernel(
    name="inkling_fp4_mpp_activation",
    input_names=["a", "b", "sc", "lut", "starts", "base", "experts"],
    output_names=["y"],
    header=load_shader("mpp_headers.metal"),
    source=load_shader("fp4_mpp_activation.metal"),
)


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
        * (g[:, None, None] / 2688.0)
        * mx.array([0, 0.5, 1, 1.5, 2, 3, 4, 6])[None, None, :]
    )
    .astype(mx.bfloat16)
    .astype(mx.float16)
)
mx.eval(lut)


def fused(bm, bn, bk):
    starts = mx.searchsorted(idx, mx.arange(E + 1).astype(idx.dtype))
    counts = (starts[1:] - starts[:-1] + bm - 1) // bm
    ends = mx.cumsum(counts)
    base = ends - counts
    nt = (n + bm - 1) // bm + E - 1
    experts = mx.searchsorted(ends, mx.arange(nt), side="right")
    a = mx.pad(x.astype(mx.float16), [(0, bm), (0, 0), (0, 0)])
    return kernel(
        inputs=[a, w, s, lut, starts, base, experts],
        template=[("K", K), ("N", N), ("E", E), ("BM", bm), ("BN", bn), ("BK", bk)],
        grid=(128 * N // bn, nt, 1),
        threadgroup=(128, 1, 1),
        output_shapes=[(n, 1, N // 2)],
        output_dtypes=[mx.bfloat16],
    )[0]


ref = activate(compute("packed"))
mx.eval(ref)
times = {
    a: []
    for a in [
        None,
        (32, 32, 64),
        (32, 64, 64),
        (32, 64, 128),
        (32, 32, 128),
        (64, 32, 128),
        (32, 128, 64),
    ]
}
for r in range(6):
    for arm in list(times)[:: 1 if r % 2 else -1]:
        t = time.perf_counter()
        v = activate(compute("packed")) if arm is None else fused(*arm)
        mx.eval(v)
        dt = (time.perf_counter() - t) * 1000
        if r:
            times[arm].append(dt)
        else:
            print(
                arm,
                "relative RMS",
                (
                    mx.linalg.norm(v.astype(mx.float32) - ref)
                    / mx.linalg.norm(ref.astype(mx.float32))
                ).item(),
                flush=True,
            )
print(
    "median milliseconds",
    {a: round(statistics.median(ts), 2) for a, ts in times.items()},
    flush=True,
)
