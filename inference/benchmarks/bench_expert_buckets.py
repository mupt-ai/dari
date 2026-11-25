"""Exact-length routing buckets: batch native GEMMs, separately handle tiny experts."""

from statistics import median
from time import perf_counter
import mlx.core as mx
from benchmarks.bench_expert_real import compute, x, idx, dense, E, w, s, g, N


def buckets(threshold):
    bounds = mx.searchsorted(idx, mx.arange(E + 1).astype(idx.dtype)).tolist()
    groups = {}
    pieces = []
    cold = []
    for i, (a, b) in enumerate(zip(bounds, bounds[1:])):
        if a == b:
            continue
        if b - a < threshold:
            cold.append((i, a, b))
            continue
        size = 1 << (b - a - 1).bit_length()
        groups.setdefault(size, []).append((i, a, b))
    for size, jobs in groups.items():
        ax = mx.stack(
            [mx.pad(x[a:b, 0], [(0, size - b + a), (0, 0)]) for _, a, b in jobs]
        ).astype(mx.float16)
        wt = mx.stack([dense[e] for e, _, _ in jobs])
        out = (ax @ wt.swapaxes(-2, -1)).astype(mx.bfloat16)
        pieces.extend((a, out[j, : b - a, None, :]) for j, (_, a, b) in enumerate(jobs))
    if cold:
        ax = mx.concatenate([x[a:b] for _, a, b in cold])
        ix = mx.concatenate([idx[a:b] for _, a, b in cold])
        y = mx.gather_qmm(
            ax,
            w,
            s,
            rhs_indices=ix,
            sorted_indices=True,
            group_size=16,
            bits=4,
            mode="nvfp4",
            global_scale=g,
        )
        off = 0
        for _, a, b in cold:
            pieces.append((a, y[off : off + b - a]))
            off += b - a
    return mx.concatenate([v for _, v in sorted(pieces, key=lambda p: p[0])])


ref = compute("packed")
mx.eval(ref)
times = {a: [] for a in (0, 16, 64, 256, 512)}
for r in range(6):
    for arm in list(times)[:: 1 if r % 2 else -1]:
        t = perf_counter()
        y = buckets(arm) if arm else compute("packed")
        mx.eval(y)
        dt = 1000 * (perf_counter() - t)
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
