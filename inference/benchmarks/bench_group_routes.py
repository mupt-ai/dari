from statistics import median
from time import perf_counter
import mlx.core as mx
from benchmarks.bench_expert_real import ids
from dari_engine.engines.inkling.inkling_group_routes import group_routes


def standard(s):
    s = s.flatten()
    order = mx.argsort(s)
    return order, mx.argsort(order), s[order]


for n in (16, 257, 1008):
    s = ids[:, :n]
    a = standard(s)
    b = group_routes(s)
    assert all(mx.array_equal(x, y).item() for x, y in zip(a, b))
    times = [[], []]
    for r in range(30):
        for j in (r % 2, 1 - r % 2):
            t = perf_counter()
            mx.eval(*(standard, group_routes)[j](s))
            times[j].append((perf_counter() - t) * 1e6)
    print(
        n,
        "microseconds sorted / histogram",
        *[round(median(t[2:]), 2) for t in times],
        flush=True,
    )
