"""Select eight of 128 experts and normalize their unbiased routing weights."""

import mlx.core as mx

from .shaders import load_shader

_kernel = mx.fast.metal_kernel(
    name="inkling_top8",
    input_names=["logits", "bias"],
    output_names=["ids", "coeff"],
    source=load_shader("top8.metal"),
)


def top8(logits, bias):
    shape = (*logits.shape[:-1], 8)
    n = logits.size // 128
    return _kernel(
        inputs=[logits, bias],
        grid=(32, n, 1),
        threadgroup=(32, 1, 1),
        output_shapes=[shape, shape],
        output_dtypes=[mx.uint32, mx.float32],
    )
