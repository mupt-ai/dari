"""Accumulate routed rows, then apply causal depthwise FIR and residual in one pass."""

import mlx.core as mx

from inkling.shaders import load_shader

_fir = mx.fast.metal_kernel(
    name="inkling_expert_fir",
    input_names=["expert", "inv", "coeff", "prior", "w", "res"],
    output_names=["out", "history"],
    source=load_shader("expert_fir.metal"),
)


def expert_fir(expert, inv, coeff, prior, weight, res):
    _, l, d = res.shape
    if prior is None:
        prior = mx.zeros((1, 3, d), mx.bfloat16)
    assert d % 128 == 0 and l >= 3 and res.dtype == mx.float32
    return _fir(
        inputs=[expert, inv, coeff, prior, weight, res],
        template=[("DV", d // 4), ("L", l)],
        grid=(256 * (d // 128), (l + 7) // 8, 1),
        threadgroup=(256, 1, 1),
        output_shapes=[res.shape, prior.shape],
        output_dtypes=[mx.bfloat16, mx.bfloat16],
    )


_decode = mx.fast.metal_kernel(
    name="inkling_decode_expert_fir",
    input_names=["expert", "coeff", "prior", "w", "res"],
    output_names=["out", "history"],
    source=load_shader("decode_expert_fir.metal"),
)


def decode_expert_fir(expert, coeff, prior, weight, res):
    d = res.shape[-1]
    if prior is None:
        prior = mx.zeros((1, 3, d), mx.bfloat16)
    return _decode(
        inputs=[expert, coeff, prior, weight, res],
        template=[("D", d)],
        grid=(d, 1, 1),
        threadgroup=(64, 1, 1),
        output_shapes=[res.shape, prior.shape],
        output_dtypes=[mx.bfloat16, mx.bfloat16],
    )
