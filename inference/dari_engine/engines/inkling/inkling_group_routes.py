"""Stable counting sort for Inkling's fixed 128-expert vocabulary."""

import mlx.core as mx

from .shaders import load_shader

_hist = mx.fast.metal_kernel(
    name="inkling_route_hist",
    input_names=["ids"],
    output_names=["counts"],
    source=load_shader("route_hist.metal"),
)
_scatter = mx.fast.metal_kernel(
    name="inkling_route_scatter",
    input_names=["ids", "ends", "counts"],
    output_names=["order", "inverse", "sorted_ids"],
    source=load_shader("route_scatter.metal"),
)


def group_routes(selected):
    n = selected.size
    b = (n + 255) // 256
    opts = [("N", n), ("B", b)]
    counts = _hist(
        inputs=[selected],
        template=opts,
        grid=(256 * b, 1, 1),
        threadgroup=(256, 1, 1),
        output_shapes=[(128 * b,)],
        output_dtypes=[mx.uint32],
    )[0]
    return _scatter(
        inputs=[selected, mx.cumsum(counts), counts],
        template=opts,
        grid=(256 * b, 128, 1),
        threadgroup=(256, 1, 1),
        output_shapes=[(n,)] * 3,
        output_dtypes=[mx.uint32] * 3,
    )
