"""Batched one-level Strassen against actual local attention weights and real rows."""

from statistics import median
from time import perf_counter
import mlx.core as mx
from benchmarks.bench_expert_real import states, block

x = states[0]
w, s, b = block.packed
l, k = x.shape
n = w.shape[0]
wt = mx.dequantize(w, s, b, group_size=64, bits=4).astype(mx.float16)
wt = mx.pad(wt, [(0, (-n) % 64), (0, 0)])
a, b2 = mx.split(wt, 2, axis=0)
b11, b21 = mx.split(a, 2, axis=1)
b12, b22 = mx.split(b2, 2, axis=1)
weight = mx.contiguous(
    mx.stack([b11 + b22, b11, b12 - b22, b21 - b11, b22, b11 + b12, b21 + b22])
)
mx.eval(wt, weight, x)


@mx.compile
def expand(x):
    a, b = mx.split(x.astype(mx.float16), 2, axis=0)
    p, q = mx.split(a, 2, axis=1)
    r, s = mx.split(b, 2, axis=1)
    return mx.stack([p + s, r + s, p, s, p + q, r - p, q - s])


@mx.compile
def combine(m):
    a, b, c, d, e, f, g = [m[i].astype(mx.float32) for i in range(7)]
    return mx.concatenate(
        [
            mx.concatenate([a + d - e + g, c + e], axis=1),
            mx.concatenate([b + d, a - b + c + f], axis=1),
        ]
    ).astype(mx.bfloat16)


def run(a):
    if a == "packed":
        return mx.quantized_matmul(x, w, s, b, group_size=64, bits=4)
    if a == "dense":
        return (x.astype(mx.float16) @ wt.T).astype(mx.bfloat16)[:, :n]
    return combine(expand(x) @ weight.swapaxes(-2, -1))[:, :n]


ref = run("packed")
mx.eval(ref)
times = {a: [] for a in ("packed", "dense", "strassen")}
for r in range(10):
    for a in list(times)[r % 3 :] + list(times)[: r % 3]:
        t = perf_counter()
        v = run(a)
        mx.eval(v)
        dt = 1000 * (perf_counter() - t)
        if r > 1:
            times[a].append(dt)
        if r == 0:
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
