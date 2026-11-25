"""Normalize a strided float residual row and write the projection input dtype."""

import mlx.core as mx

from inkling.shaders import load_shader

_norm = mx.fast.metal_kernel(
    name="inkling_weighted_rms_cast",
    input_names=["x", "w"],
    output_names=["out"],
    ensure_row_contiguous=False,
    source=load_shader("weighted_rms_cast.metal"),
)


def rms_cast(x, w, dtype):
    assert x.ndim == 3 and x.shape[0] == 1 and x.shape[-1] == 2304
    return _norm(
        inputs=[x, w],
        template=[("T", dtype)],
        grid=(256, x.shape[1], 1),
        threadgroup=(256, 1, 1),
        output_shapes=[x.shape],
        output_dtypes=[dtype],
    )[0]
