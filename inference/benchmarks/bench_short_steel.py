"""Small row tiles for short prefill, measured on both expert projections."""

from statistics import median
from time import perf_counter
import mlx.core as mx
from benchmarks.bench_expert_real import states, moe
from inkling.inkling_short_steel import compact

arms = [
    None,
    (8, 32, 32, 1, 2),
    (8, 64, 32, 1, 4),
    (16, 64, 32, 1, 4),
    (32, 64, 32, 2, 2),
]
for n in (16, 32, 64):
    x = states[:, :n]
    ref = moe(x)
    mx.eval(ref)
    times = {a: [] for a in arms}
    for r in range(8):
        for shape in arms[r % len(arms) :] + arms[: r % len(arms)]:
            t = perf_counter()
            z = compact(moe, x, shape) if shape else moe(x)
            mx.eval(z)
            times[shape].append((perf_counter() - t) * 1000)
            if not r:
                print(
                    n,
                    shape,
                    "relative RMS",
                    (
                        mx.linalg.norm(z.astype(mx.float32) - ref)
                        / mx.linalg.norm(ref.astype(mx.float32))
                    ).item(),
                    flush=True,
                )
    print(
        n, "ms", {str(a): round(median(t[2:]), 3) for a, t in times.items()}, flush=True
    )
