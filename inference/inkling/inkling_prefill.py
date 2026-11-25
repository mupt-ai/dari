"""Striped relative attention. No all-pairs causal mask or synthetic future keys."""

import mlx.core as mx

from inkling.shaders import load_shader

_mask = mx.fast.metal_kernel(
    name="inkling_relative_strip",
    input_names=["rel", "sinks", "params"],
    output_names=["mask"],
    source=load_shader("relative_strip.metal"),
)


def striped(q, k, v, rel, sinks, local, rows=128):
    # All keys are chronological on the multi-token path (including cached prefixes).
    _, length, heads, dim = q.shape
    source = k.shape[2]
    past = source - length
    padded = [mx.concatenate([mx.zeros_like(z[:, :, :1]), z], axis=2) for z in (k, v)]
    chunks = []
    for i in range(0, length, rows):
        j = min(i + rows, length)
        end = past + j
        lo = max(0, past + i - 1023) if local else 0
        width = end - lo + 1
        b = _mask(
            inputs=[
                rel.transpose(0, 2, 1, 3),
                sinks,
                mx.array([i, width, j - i, past, lo], mx.int32),
            ],
            template=[("LOCAL", local), ("T", q.dtype)],
            grid=(width, j - i, heads),
            threadgroup=(32, 4, 1),
            output_shapes=[(1, heads, j - i, width)],
            output_dtypes=[q.dtype],
        )[0]
        if lo == 0:
            ks, vs = [z[:, :, : end + 1] for z in padded]
        else:
            ks, vs = [
                mx.concatenate([mx.zeros_like(z[:, :, :1]), z[:, :, lo:end]], axis=2)
                for z in (k, v)
            ]
        out = mx.fast.scaled_dot_product_attention(
            q[:, i:j].transpose(0, 2, 1, 3), ks, vs, scale=dim**-0.5, mask=b
        )
        chunks.append(out.transpose(0, 2, 1, 3).reshape(1, j - i, heads * dim))
    return mx.concatenate(chunks, axis=1)


_decode_mask = mx.fast.metal_kernel(
    name="inkling_decode_relative_mask",
    input_names=["rel", "offset"],
    output_names=["mask"],
    source=load_shader("decode_relative_mask.metal"),
)


def decode_mask(rel, off, width, local):
    return _decode_mask(
        inputs=[rel, mx.array(off, mx.uint32)],
        template=[("LOCAL", local), ("T", rel.dtype)],
        grid=(width, 24, 1),
        threadgroup=(32, 1, 1),
        output_shapes=[(1, 24, 1, width)],
        output_dtypes=[rel.dtype],
    )[0]
