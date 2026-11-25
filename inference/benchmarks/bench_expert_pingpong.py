"""Alternate two threadgroup panels to reduce inner product synchronization."""

from experiments.shaders import load_shader
from inkling.inkling_adaptive_tiles import adaptive
from inkling.inkling_partial_steel import tile_body
from inkling.shaders import render


def double_buffer(early):
    load = load_shader("pingpong_load.metal")
    mma = load_shader("pingpong_mma.metal")
    loop = render(
        load_shader("pingpong_loop.metal"),
        FIRST=load if early else mma,
        SECOND=mma if early else load,
    )
    return adaptive(
        tile_body(REDUCTION_LOOP=loop),
        f"inkling_steel_pingpong_{int(early)}",
        buffers=2,
    )


if __name__ == "__main__":
    from statistics import median
    from time import perf_counter

    import mlx.core as mx

    from benchmarks.bench_expert_real import moe, states
    from inkling.inkling_short_steel import compact

    arms = [
        (bm, k)
        for bm in (32, 64)
        for k in (adaptive(), double_buffer(False), double_buffer(True))
    ]
    ref = moe(states)
    mx.eval(ref)
    ts = [[] for _ in arms]
    for r in range(9):
        for j in [(r + i) % len(arms) for i in range(len(arms))]:
            bm, k = arms[j]
            t = perf_counter()
            v = compact(moe, states, (bm, 64, 32, 2, 2), program=k)
            mx.eval(v)
            ts[j].append((perf_counter() - t) * 1000)
            if not r:
                print(
                    j,
                    "relative RMS",
                    (
                        mx.linalg.norm(v.astype(mx.float32) - ref)
                        / mx.linalg.norm(ref.astype(mx.float32))
                    ).item(),
                    flush=True,
                )
    print(
        "ms (single / late / early) for BM32 and BM64",
        [round(median(t[2:]), 3) for t in ts],
        flush=True,
    )
