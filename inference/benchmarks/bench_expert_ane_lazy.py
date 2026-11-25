"""Dynamic-weight hybrid benchmark, includes all activation and weight transfers."""

from statistics import median
from time import perf_counter
import os, sys

if "INKLING_COREML_SITE" in os.environ:
    sys.path.append(os.environ["INKLING_COREML_SITE"])
import mlx.core as mx
from benchmarks.bench_expert_real import states, moe
from benchmarks.inkling_lazy_hybrid import LazyHybrid as Hybrid

ref = moe(states)
mx.eval(ref)
arms = {0: moe, 1: Hybrid(moe, 1), 2: Hybrid(moe, 2), 3: Hybrid(moe, 3)}
times = {a: [] for a in arms}
for r in range(8):
    for a in list(arms)[r % 4 :] + list(arms)[: r % 4]:
        t = perf_counter()
        v = arms[a](states)
        mx.eval(v)
        dt = 1000 * (perf_counter() - t)
        if r > 1:
            times[a].append(dt)
        if not r:
            print(
                a,
                "relative RMS",
                (
                    mx.linalg.norm(v.astype(mx.float32) - ref)
                    / mx.linalg.norm(ref.astype(mx.float32))
                ).item(),
                flush=True,
            )
print(
    "median milliseconds",
    {a: round(median(ts), 2) for a, ts in times.items()},
    flush=True,
)
