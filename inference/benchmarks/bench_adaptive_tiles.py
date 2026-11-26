"""Specialize final ragged tile shape per expert without extra GPU dispatches."""

from statistics import median
from time import perf_counter
import mlx.core as mx
from benchmarks.bench_expert_real import states, moe
from dari_engine.engines.inkling.inkling_partial_steel import kernel
from dari_engine.engines.inkling.inkling_short_steel import compact


from dari_engine.engines.inkling.inkling_adaptive_tiles import adaptive

if __name__ == "__main__":
    program = adaptive()
    arms = [None, (32, kernel), (32, program), (64, kernel), (64, program)]
    ref = moe(states)
    mx.eval(ref)
    ts = [[] for _ in arms]
    for r in range(9):
        for j in [(r + k) % len(arms) for k in range(len(arms))]:
            arm = arms[j]
            t = perf_counter()
            z = (
                moe(states)
                if arm is None
                else compact(moe, states, (arm[0], 64, 32, 2, 2), program=arm[1])
            )
            mx.eval(z)
            ts[j].append((perf_counter() - t) * 1000)
            if not r:
                print(
                    j,
                    "relative RMS",
                    (
                        mx.linalg.norm(z.astype(mx.float32) - ref)
                        / mx.linalg.norm(ref.astype(mx.float32))
                    ).item(),
                    flush=True,
                )
    print(
        "median ms native/fixed32/adaptive32/fixed64/adaptive64",
        [round(median(t[2:]), 2) for t in ts],
        flush=True,
    )
