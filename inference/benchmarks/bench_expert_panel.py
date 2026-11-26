"""Compare fused gate/up GEMM + activation against native packed execution."""

import statistics
import time

import mlx.core as mx

from benchmarks.bench_expert_real import E, K, N, compute, dense, idx, n, x
from experiments.shaders import load_shader
from dari_engine.engines.inkling.inkling_moe import activate

kernel = mx.fast.metal_kernel(
    name="inkling_panel_activation",
    input_names=["a", "b", "starts", "base", "experts"],
    output_names=["y"],
    source=load_shader("panel_activation.metal"),
)


def fused(bm, bn):
    starts = mx.searchsorted(idx, mx.arange(E + 1).astype(idx.dtype))
    counts = (starts[1:] - starts[:-1] + bm - 1) // bm
    ends = mx.cumsum(counts)
    base = ends - counts
    nt = (n + bm - 1) // bm + E - 1
    experts = mx.searchsorted(ends, mx.arange(nt), side="right")
    a = mx.pad(x.astype(mx.float16), [(0, bm), (0, 0), (0, 0)])
    return kernel(
        inputs=[a, panels[bn], starts, base, experts],
        template=[("K", K), ("N", N), ("E", E), ("BM", bm), ("BN", bn)],
        grid=(128 * N // bn, nt, 1),
        threadgroup=(128, 1, 1),
        output_shapes=[(n, 1, N // 2)],
        output_dtypes=[mx.bfloat16],
    )[0]


ref = activate(compute("packed"))
mx.eval(ref)
times = {a: [] for a in [None, (16, 32), (32, 32), (32, 64), (64, 64)]}
panels = {
    bn: mx.contiguous(
        dense.reshape(E, N // bn, bn // 8, 8, K // 8, 8).transpose(0, 1, 4, 2, 5, 3)
    )
    for bn in {arm[1] for arm in times if arm}
}
mx.eval(*panels.values())
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
