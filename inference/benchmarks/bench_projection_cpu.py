"""Split affine projection across CPU and GPU with independent array streams."""

from statistics import median
from time import perf_counter
import mlx.core as mx
from benchmarks.bench_expert_real import states, block

w, s, b = block.packed
parts = [0, 512, 1024, 2048, 3072]
dense = {
    p: mx.contiguous(
        mx.dequantize(w[:p], s[:p], b[:p], group_size=64, bits=4).astype(mx.float16).T
    )
    for p in parts
    if p
}
mx.eval(dense)


def run(p):
    other = mx.quantized_matmul(states, w[p:], s[p:], b[p:], group_size=64, bits=4)
    if not p:
        return other
    first = mx.matmul(
        states.astype(mx.float16, stream=mx.cpu), dense[p], stream=mx.cpu
    ).astype(states.dtype, stream=mx.cpu)
    return mx.concatenate([first, other], axis=-1)


ref = run(0)
mx.eval(ref)
ts = {p: [] for p in parts}
for r in range(10):
    for p in parts[r % len(parts) :] + parts[: r % len(parts)]:
        t = perf_counter()
        v = run(p)
        mx.eval(v)
        ts[p].append((perf_counter() - t) * 1000)
        if not r:
            print(
                p,
                "relative RMS",
                (
                    mx.linalg.norm(v.astype(mx.float32) - ref)
                    / mx.linalg.norm(ref.astype(mx.float32))
                ).item(),
                flush=True,
            )
print("ms", {p: round(median(t[2:]), 3) for p, t in ts.items()}, flush=True)
