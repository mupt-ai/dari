"""Global decode: share each chronological KV read among its three query heads."""

import mlx.core as mx

from .shaders import load_shader

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


rows_partial = mx.fast.metal_kernel(
    name="inkling_shared_kv_rows_parts",
    input_names=["q", "k", "v", "nk", "nv", "rel", "extent"],
    output_names=["part", "stats"],
    ensure_row_contiguous=False,
    source=load_shader("shared_kv_rows_parts.metal"),
)
rows_merge = mx.fast.metal_kernel(
    name="inkling_shared_kv_rows_merge",
    input_names=["part", "stats", "sinks"],
    output_names=["out"],
    source=load_shader("shared_kv_rows_merge.metal"),
)


def decode_rows(q, k, v, rel, sinks, new=None, length=None, full=False):
    """Attention for a few consecutive query rows, reading each KV block once.

    Global layers pass their chronological cache, new rows included. Local
    layers pass their 1024-slot ring of earlier keys and the *new* rows, with
    *length* the position after the last row. *full* rows see every key with
    no relative bias, as a bidirectional draft block does.
    """
    rows = q.shape[1]
    local = new is not None
    if not local:
        length = k.shape[2]
        new = k[:, :, :1], v[:, :, :1]
    parts = 64
    out = rows_partial(
        inputs=[
            mx.contiguous(q),
            k,
            v,
            *(mx.contiguous(z) for z in new),
            rel,
            mx.array([length], mx.uint32),
        ],
        template=[("PARTS", parts), ("L", rows), ("LOCAL", local), ("FULL", full)],
        grid=(32 * rows * parts, 8, 1),
        threadgroup=(32 * rows, 1, 1),
        output_shapes=[(rows * 24 * parts, 128), (rows * 24 * parts, 2)],
        output_dtypes=[mx.float32, mx.float32],
    )
    return rows_merge(
        inputs=[*out, mx.contiguous(sinks)],
        template=[("PARTS", parts)],
        grid=(32, 24, rows),
        threadgroup=(32, 1, 1),
        output_shapes=[(1, rows, 3072)],
        output_dtypes=[mx.bfloat16],
    )[0]
