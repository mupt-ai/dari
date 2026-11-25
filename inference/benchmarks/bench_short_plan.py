from statistics import median
from time import perf_counter
import mlx.core as mx
from benchmarks.bench_expert_real import states, moe
from inkling.inkling_short_steel import compact
from inkling.inkling_short_plan import direct

for n in (8, 16, 31, 32):
    x = states[:, :n]
    ref = moe(x)
    mx.eval(ref)
    ts = [[], [], []]
    for r in range(13):
        for j in ((r + i) % 3 for i in range(3)):
            t = perf_counter()
            z = [lambda: moe(x), lambda: compact(moe, x), lambda: direct(moe, x)][j]()
            mx.eval(z)
            ts[j].append((perf_counter() - t) * 1000)
            if not r:
                print(
                    n,
                    j,
                    "relative RMS",
                    (
                        mx.linalg.norm(z.astype(mx.float32) - ref)
                        / mx.linalg.norm(ref.astype(mx.float32))
                    ).item(),
                    flush=True,
                )
    print(
        n,
        "ms native / steel / direct",
        [round(median(t[2:]), 3) for t in ts],
        flush=True,
    )
