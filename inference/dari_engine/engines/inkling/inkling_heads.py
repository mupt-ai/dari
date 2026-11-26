"""Independent per-head clipping and value RMS normalization in one dispatch."""

import mlx.core as mx

from .shaders import load_shader

_heads = mx.fast.metal_kernel(
    name="inkling_normalize_heads",
    input_names=["q", "r", "k", "v", "qs", "rs"],
    output_names=["qn", "rn", "kn", "vn"],
    ensure_row_contiguous=False,
    source=load_shader("normalize_heads.metal"),
)


def normalize(q, r, k, v, qs, rs):
    l = q.shape[1]
    return _heads(
        inputs=[q, r, k, v, qs, rs],
        template=[("T", q.dtype)],
        grid=(64 * 32, l, 1),
        threadgroup=(128, 1, 1),
        output_shapes=[(1, l, 24, 128), (1, l, 24, 16), (1, l, 8, 128), (1, l, 8, 128)],
        output_dtypes=[q.dtype] * 4,
    )
