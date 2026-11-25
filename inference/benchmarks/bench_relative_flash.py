"""Compare fused and striped causal attention, including cached and partial tiles."""

import time
from statistics import median
import mlx.core as mx
from benchmarks.benchmark_lock import exclusive_gpu
from benchmarks.inkling_relative_flash import flash
from inkling.inkling_prefill import striped

lock = exclusive_gpu()
mx.random.seed(318)
for l, past in [(257, 73), (1008, 0), (1366, 0)]:

    def arr(shape):
        return mx.random.normal(shape).astype(mx.bfloat16)

    q = arr((1, l, 24, 128))
    k = arr((1, l + past, 8, 128)).transpose(0, 2, 1, 3)
    v = arr((1, l + past, 8, 128)).transpose(0, 2, 1, 3)
    rel = arr((1, l, 24, 1024)).transpose(0, 2, 1, 3)
    s = arr((1, l, 24))
    mx.eval(q, k, v, rel, s)
    for local in (False, True):
        inputs = (q, k, v, rel, s, local)
        ref = striped(*inputs)
        mx.eval(ref)
        times = [[], []]
        for r in range(8):
            for a in (r % 2, 1 - r % 2):
                t = time.perf_counter()
                y = (striped, flash)[a](*inputs)
                mx.eval(y)
                dt = 1000 * (time.perf_counter() - t)
                if r > 1:
                    times[a].append(dt)
                if not r and a:
                    err = (
                        mx.linalg.norm(y.astype(mx.float32) - ref)
                        / mx.linalg.norm(ref.astype(mx.float32))
                    ).item()
        print(
            "length",
            l,
            "prefix",
            past,
            "local",
            local,
            "striped/fused ms",
            *[round(median(ts), 3) for ts in times],
            "relative RMS",
            err,
            flush=True,
        )
