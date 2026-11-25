"""Offline sensitivity experiment: affine recoding of NVFP4 weights is lossy."""

from statistics import median
from time import perf_counter
import mlx.core as mx
from benchmarks.bench_expert_real import x, idx, dense, compute

ref = compute("packed")
mx.eval(ref)
for bits in (8, 6, 4):
    w, s, b = mx.quantize(dense.astype(mx.bfloat16), group_size=32, bits=bits)
    mx.eval(w, s, b)
    times = [[], []]
    for r in range(8):
        for arm in (r % 2, 1 - r % 2):
            start = perf_counter()
            v = (
                mx.gather_qmm(
                    x,
                    w,
                    s,
                    b,
                    rhs_indices=idx,
                    sorted_indices=True,
                    group_size=32,
                    bits=bits,
                )
                if arm
                else compute("packed")
            )
            mx.eval(v)
            dt = (perf_counter() - start) * 1000
            if r:
                times[arm].append(dt)
            if arm and not r:
                err = (
                    mx.linalg.norm(v.astype(mx.float32) - ref)
                    / mx.linalg.norm(ref.astype(mx.float32))
                ).item()
    print(
        bits,
        "native and recoded ms",
        *[round(median(t), 2) for t in times],
        "relative RMS",
        err,
        flush=True,
    )
