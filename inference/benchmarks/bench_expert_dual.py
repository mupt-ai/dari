"""Concurrent, contiguous range offload: avoid copying all other expert inputs."""

from benchmarks.bench_expert_real import x, idx, w, s, g, dense, compute, E, N
import mlx.core as mx
import time
from statistics import median


def split(mode):
    # Use full live-recomputed routing boundaries, not a calibration list.
    bounds = mx.searchsorted(idx, mx.arange(E + 1).astype(idx.dtype)).tolist()
    e = max(range(E), key=lambda i: bounds[i + 1] - bounds[i])
    lo, hi = bounds[e : e + 2]

    def q(a, b):
        return mx.gather_qmm(
            x[a:b],
            w,
            s,
            rhs_indices=idx[a:b],
            sorted_indices=True,
            group_size=16,
            bits=4,
            mode="nvfp4",
            global_scale=g,
        )

    prefix = q(0, lo) if lo else None
    suffix = q(hi, x.shape[0]) if hi < x.shape[0] else None
    sides = [v for v in (prefix, suffix) if v is not None]
    mx.async_eval(*sides)
    dev = mx.cpu if mode == "cpu" else mx.gpu
    hot = mx.matmul(
        x[lo:hi, 0].astype(mx.float16, stream=dev), dense[e].T, stream=dev
    ).astype(mx.bfloat16, stream=dev)[:, None, :]
    return mx.concatenate([v for v in (prefix, hot, suffix) if v is not None])


ref = compute("packed")
mx.eval(ref)
times = {a: [] for a in ("packed", "cpu", "gpu")}
for r in range(9):
    for arm in list(times)[r % 3 :] + list(times)[: r % 3]:
        t = time.perf_counter()
        y = compute("packed") if arm == "packed" else split(arm)
        mx.eval(y)
        dt = 1000 * (time.perf_counter() - t)
        if r:
            times[arm].append(dt)
        else:
            print(
                arm,
                "relative RMS",
                (
                    mx.linalg.norm(y.astype(mx.float32) - ref)
                    / mx.linalg.norm(ref.astype(mx.float32))
                ).item(),
                flush=True,
            )
print(
    "median milliseconds",
    {a: round(median(ts), 2) for a, ts in times.items()},
    flush=True,
)
