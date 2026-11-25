"""Static causal depthwise convolution plus its rounded residual, batch one."""

import mlx.core as mx

from inkling.shaders import load_shader

_fir = mx.fast.metal_kernel(
    name="inkling_fir4",
    input_names=["z", "prior", "w"],
    output_names=["out"],
    ensure_row_contiguous=False,
    source=load_shader("fir4.metal"),
)


def static_fir(z, history, weight):
    _, length, dim = z.shape
    if history is None:
        history = mx.zeros((1, 3, dim), z.dtype)
    output = _fir(
        inputs=[z, history, weight],
        template=[("T", z.dtype), ("D", dim)],
        grid=(dim * length, 1, 1),
        threadgroup=(256, 1, 1),
        output_shapes=[z.shape],
        output_dtypes=[z.dtype],
    )[0]
    saved = (
        z[:, -3:] if length >= 3 else mx.concatenate([history[:, length:], z], axis=1)
    )
    return output, mx.contiguous(saved)


_dynamic = mx.fast.metal_kernel(
    name="inkling_dynamic_fir4",
    input_names=["z", "prior", "stat", "delta"],
    output_names=["out"],
    ensure_row_contiguous=False,
    source=load_shader("dynamic_fir4.metal"),
)


def dynamic_fir(z, history, weight, delta):
    _, length, dim = z.shape
    if history is None:
        history = mx.zeros((1, 3, dim), z.dtype)
    out = _dynamic(
        inputs=[z, history, weight, delta],
        template=[("D", dim), ("T", z.dtype)],
        grid=(length * dim, 1, 1),
        threadgroup=(256, 1, 1),
        output_shapes=[z.shape],
        output_dtypes=[z.dtype],
    )[0]
    saved = (
        z[:, -3:] if length >= 3 else mx.concatenate([history[:, length:], z], axis=1)
    )
    return out, mx.contiguous(saved)
