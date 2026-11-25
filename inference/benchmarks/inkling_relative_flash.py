"""Experimental causal FlashAttention with a per-row sink and lag-relative bias."""

import mlx.core as mx

from experiments.shaders import load_shader

_kernel = mx.fast.metal_kernel(
    name="inkling_relative_flash",
    input_names=["q", "k", "v", "rel", "sinks"],
    output_names=["out"],
    ensure_row_contiguous=False,
    source=load_shader("relative_flash.metal"),
)


def flash(q, k, v, rel, sinks, local):
    l = q.shape[1]
    return _kernel(
        inputs=[q, k, v, rel, sinks],
        template=[("LOCAL", local)],
        grid=(128 * ((l + 15) // 16), 24, 1),
        threadgroup=(128, 1, 1),
        output_shapes=[(1, l, 24 * 128)],
        output_dtypes=[q.dtype],
    )[0]
