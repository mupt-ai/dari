"""Compare fused gate/up GEMM + activation against native packed execution."""

import statistics
import time

import mlx.core as mx

from benchmarks.bench_expert_real import E, K, N, compute, g, idx, n, s, w, x
from experiments.shaders import load_shader
from inkling.inkling_moe import activate
from inkling.mlx_headers import expert_headers

kernel = mx.fast.metal_kernel(
    name="inkling_steel_fp4_epilogue",
    input_names=["a", "b", "sc", "gs", "starts", "base", "experts"],
    output_names=["y"],
    header=expert_headers(),
    source=load_shader("steel_fp4_epilogue.metal"),
)


def fused(bm, bn, bk, wm, wn):
    starts = mx.searchsorted(idx, mx.arange(E + 1).astype(idx.dtype))
    counts = (starts[1:] - starts[:-1] + bm - 1) // bm
    ends = mx.cumsum(counts)
    base = ends - counts
    nt = (n + bm - 1) // bm + E - 1
    experts = mx.searchsorted(ends, mx.arange(nt), side="right")
    a = mx.pad(x, [(0, bm), (0, 0), (0, 0)])
    return kernel(
        inputs=[a, w, s, g, starts, base, experts],
        template=[
            ("K", K),
            ("N", N),
            ("E", E),
            ("BM", bm),
            ("BN", bn),
            ("BK", bk),
            ("WM", wm),
            ("WN", wn),
        ],
        grid=(wm * wn * 32 * N // bn, nt, 1),
        threadgroup=(wm * wn * 32, 1, 1),
        output_shapes=[(n, 1, N // 2)],
        output_dtypes=[mx.bfloat16],
    )[0]


ref = activate(compute("packed"))
mx.eval(ref)
times = {
    a: []
    for a in [
        None,
        (32, 32, 32, 2, 2),
        (32, 64, 32, 2, 2),
        (16, 64, 32, 1, 4),
        (64, 32, 32, 4, 1),
        (32, 32, 64, 2, 2),
        (64, 64, 32, 2, 2),
        (32, 128, 16, 2, 2),
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
