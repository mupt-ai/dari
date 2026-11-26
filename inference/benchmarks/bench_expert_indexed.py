from statistics import median
from time import perf_counter
import mlx.core as mx
from benchmarks.bench_expert_real import states, moe
from dari_engine.engines.inkling.inkling_adaptive_tiles import adaptive
from benchmarks.inkling_indexed_tiles import indexed_kernel
from dari_engine.engines.inkling.inkling_short_steel import compact

arms = [(False, adaptive()), (True, indexed_kernel())]
for l in (32, 256, 1008):
    x = states[:, :l]
    ref = moe(x)
    mx.eval(ref)
    ts = [[], []]
    base = None
    for r in range(12):
        for j in (r % 2, 1 - r % 2):
            indexed, k = arms[j]
            t = perf_counter()
            v = compact(moe, x, (64, 64, 32, 2, 2), program=k, indexed=indexed)
            mx.eval(v)
            ts[j].append((perf_counter() - t) * 1000)
            if not r:
                if base is None:
                    base = v
                else:
                    print(
                        l, "exact vs staged", mx.array_equal(base, v).item(), flush=True
                    )
    print(l, "ms staged/indexed", [round(median(t[2:]), 3) for t in ts], flush=True)
