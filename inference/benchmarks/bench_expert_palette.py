"""Lossless expert-local byte indices into the actual checkpoint's bf16 weight values."""

from copy import copy

import mlx.core as mx
import numpy as np

from experiments.shaders import load_shader
from dari_engine.engines.inkling.inkling_adaptive_tiles import adaptive
from dari_engine.engines.inkling.inkling_partial_steel import tile_body
from dari_engine.engines.inkling.inkling_short_steel import compact

encode = mx.fast.metal_kernel(
    name="inkling_encode_palette",
    input_names=["w", "sc", "map"],
    output_names=["out"],
    source=load_shader("encode_palette.metal"),
)


def pack(params):
    w, s, g = params
    e, n, kp = w.shape
    k = kp * 8
    # Build once from all scales in the weight tensor, never from observed routes.
    mag = mx.array([0, 0.5, 1, 1.5, 2, 3, 4, 6])
    sg = mx.dequantize(
        mx.full((256, 2), 0x22222222, mx.uint32),
        mx.arange(256).astype(mx.uint8)[:, None],
        bits=4,
        group_size=16,
        mode="nvfp4",
        global_scale=mx.array(2688.0),
        dtype=mx.float32,
    )[:, 0]
    values = np.asarray(
        ((sg[None, :, None] * (g[:, None, None] / 2688)) * mag)
        .astype(mx.bfloat16)
        .view(mx.uint16)
    )
    scale = np.asarray(s)
    tables = np.zeros((e, 256), np.uint16)
    lookup = np.zeros((e, 256, 8), np.uint8)
    for i in range(e):
        used = np.flatnonzero(np.bincount(scale[i].ravel(), minlength=256))
        pos = np.unique(values[i, used])
        if len(pos) > 128:
            raise ValueError(f"Expert {i} requires {len(pos)} unsigned palette entries")
        lookup[i, used] = np.searchsorted(pos, values[i, used])
        tables[i, : len(pos)] = pos
        tables[i, 128 : 128 + len(pos)] = pos | 0x8000
    raw = encode(
        inputs=[w, s, mx.array(lookup)],
        template=[("WORDS", n * kp)],
        grid=(w.size, 1, 1),
        threadgroup=(256, 1, 1),
        output_shapes=[(e, n, k)],
        output_dtypes=[mx.uint8],
    )[0]
    return raw, mx.array(tables).view(mx.bfloat16), g


def palette_program():
    body = tile_body(
        SETUP=load_shader("palette_setup.metal"),
        WEIGHT_LOADER="",
        WEIGHT_LOAD=load_shader("palette_load.metal"),
        NEXT_WEIGHT="",
    )
    return adaptive(body, name="inkling_palette8")


if __name__ == "__main__":
    from statistics import median
    from time import perf_counter

    from benchmarks.bench_expert_real import moe, states

    alt = copy(moe)
    alt.expand = pack(moe.expand)
    alt.contract = pack(moe.contract)
    mx.eval(alt.expand, alt.contract)
    shape = (64, 64, 32, 2, 2)
    a = adaptive()
    b = palette_program()
    ref = moe(states)
    mx.eval(ref)
    ts = [[], [], []]
    for r in range(9):
        for j in [(r + i) % 3 for i in range(3)]:
            t = perf_counter()
            v = (
                moe(states)
                if j == 0
                else compact(
                    moe if j == 1 else alt, states, shape, program=a if j == 1 else b
                )
            )
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
        "ms packed / adaptive / palette",
        [round(median(t[2:]), 3) for t in ts],
        flush=True,
    )
