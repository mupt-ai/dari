"""Prepare both normalized inputs to a cross-pass message gate in one dispatch."""

import mlx.core as mx

from .shaders import load_shader

_pair = mx.fast.metal_kernel(
    name="inkling_gate_input",
    input_names=["v", "m"],
    output_names=["out"],
    ensure_row_contiguous=False,
    source=load_shader("gate_input.metal"),
)


def gate_input(v, m, dtype):
    l = v.shape[1]
    return _pair(
        inputs=[v, m],
        template=[("T", dtype)],
        grid=(256, l, 1),
        threadgroup=(256, 1, 1),
        output_shapes=[(1, l, 4608)],
        output_dtypes=[dtype],
    )[0]
