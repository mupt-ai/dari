"""Measure whether CPU AMX can offload part of a live-routed expert expansion."""

import time
from statistics import median
import mlx.core as mx
from benchmarks.bench_expert_real import compute, x, idx, dense, w, s, g, E, N


# Vary the fraction sent to the CPU; no predictions or hidden states reused.
def hybrid(cap):
    bounds = mx.searchsorted(idx, mx.arange(E + 1).astype(idx.dtype)).tolist()
    jobs = [
        (b - a, i, a, b) for i, (a, b) in enumerate(zip(bounds, bounds[1:])) if b > a
    ]
    hot = []
    rows = 0
    for count, i, a, b in sorted(jobs, reverse=True):
        if rows + count <= x.shape[0] * cap:
            hot.append((i, a, b))
            rows += count
    hot.sort()
    spans = []
    pos = 0
    for _, a, b in hot:
        if a > pos:
            spans.append((pos, a))
        pos = b
    if pos < x.shape[0]:
        spans.append((pos, x.shape[0]))
    ax = mx.concatenate([x[a:b] for a, b in spans])
    ix = mx.concatenate([idx[a:b] for a, b in spans])
    gpu = mx.gather_qmm(
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
    mx.async_eval(gpu)
    merged = []
    pos = 0
    for a, b in spans:
        merged.append((a, gpu[pos : pos + b - a]))
        pos += b - a
    for i, a, b in hot:
        z = mx.matmul(
            x[a:b, 0].astype(mx.float16, stream=mx.cpu), dense[i].T, stream=mx.cpu
        ).astype(mx.bfloat16, stream=mx.cpu)
        merged.append((a, z[:, None, :]))
    return mx.concatenate([v for _, v in sorted(merged, key=lambda p: p[0])])


ref = compute("packed")
mx.eval(ref)
times = {a: [] for a in (0, 0.10, 0.18, 0.25, 0.35, 0.5)}
for r in range(6):
    for arm in list(times)[:: 1 if r % 2 else -1]:
        t = time.perf_counter()
        v = hybrid(arm) if arm else compute("packed")
        mx.eval(v)
        dt = 1000 * (time.perf_counter() - t)
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
    {a: round(median(ts), 2) for a, ts in times.items()},
    flush=True,
)
