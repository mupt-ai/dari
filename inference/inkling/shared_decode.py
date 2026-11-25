"""Global decode: share each chronological KV read among its three query heads."""

import mlx.core as mx

from inkling.shaders import load_shader

partial = mx.fast.metal_kernel(
    name="inkling_shared_kv_parts",
    input_names=["q", "k", "v", "rel"],
    output_names=["part", "stats"],
    ensure_row_contiguous=False,
    source=load_shader("shared_kv_parts.metal"),
)
merge = mx.fast.metal_kernel(
    name="inkling_shared_kv_merge",
    input_names=["part", "stats", "sinks"],
    output_names=["out"],
    source=load_shader("shared_kv_merge.metal"),
)


def decode(q, k, v, rel, sinks, block=128):
    n = (k.shape[2] + block - 1) // block
    parts = partial(
        inputs=[q, k, v, rel],
        template=[("BLOCK", block)],
        grid=(256 * n, 8, 1),
        threadgroup=(256, 1, 1),
        output_shapes=[(n, 24, 128), (n, 24, 2)],
        output_dtypes=[mx.float32, mx.float32],
    )
    return merge(
        inputs=[*parts, sinks],
        template=[("NP", n)],
        grid=(32, 24, 1),
        threadgroup=(32, 1, 1),
        output_shapes=[(1, 1, 3072)],
        output_dtypes=[mx.bfloat16],
    )[0]
