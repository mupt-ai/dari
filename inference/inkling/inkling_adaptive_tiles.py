"""Ragged FP4 expert tiles specialize the amount of math in the tail."""

import re

import mlx.core as mx

from inkling.inkling_partial_steel import headers, prefix
from inkling.inkling_partial_steel import tile_body as default_tile
from inkling.shaders import load_shader, render


def adaptive(
    tile_body=None,
    name="inkling_steel_variable_tile",
    buffers=1,
    simds=4,
    tile_prefix=prefix,
):
    body = render(default_tile() if tile_body is None else tile_body, SCRATCH="")

    def branch(bm, wm, wn):
        # Reuse the main tile scratch across mutually exclusive specializations.
        return re.sub(
            r"\b(BM|WM|WN)\b", lambda m: str({"BM": bm, "WM": wm, "WN": wn}[m[0]]), body
        )

    src = tile_prefix + load_shader("expert_adaptive_scratch.metal").replace(
        "BUFFER_COUNT", str(buffers)
    )
    for limit, bm, wm, wn in [
        (8, 8, 1, simds),
        (16, 16, 1, simds),
        (32, 32, 2, simds // 2),
    ]:
        src += render(
            load_shader("expert_tail_dispatch.metal"),
            LIMIT=str(limit),
            TILE_BODY=branch(bm, wm, wn),
        )
    src += body
    return mx.fast.metal_kernel(
        name=name,
        input_names=["a", "b", "sc", "gs", "starts", "base", "experts", "hot"],
        output_names=["y"],
        header=headers,
        source=src,
    )
