"""Experts for a few tokens, reading each selected expert once.

Neighbouring tokens share many experts: an eight-token verification block
routes 64 picks to about 32 distinct experts. Per-route matvecs read a shared
expert once per token; the steel tiles pay for 8-row MMA tiles mostly empty.
"""

import mlx.core as mx

from inkling.inkling_partial_steel import headers
from inkling.inkling_short_plan import plan
from inkling.inkling_top8 import top8
from inkling.shaders import load_shader

ROWS, SIMDGROUPS = 4, 2
ONE = mx.ones((128,), mx.float32)

project = mx.fast.metal_kernel(
    name="inkling_routed_matvec",
    input_names=["a", "w", "sc", "gs", "slots", "counts", "experts"],
    output_names=["out"],
    header=headers + load_shader("routed_matvec_rows.metal"),
    source=load_shader("routed_matvec.metal"),
)


def routed(moe, x, *, return_routed=False):
    l = x.shape[1]
    assert 1 <= l <= 8 and moe.mode in ("nvfp4", "mxfp8")
    sel, coeff = top8(x.astype(mx.float32) @ moe.router.T, moe.bias)
    slots, counts = plan(
        inputs=[sel],
        template=[("L", l)],
        grid=(32, 128, 1),
        threadgroup=(32, 1, 1),
        output_shapes=[(128, l), (128,)],
        output_dtypes=[mx.uint32, mx.uint32],
    )

    # Selected experts first; at most 8 * l of them are distinct.
    experts = mx.argsort((counts == 0).astype(mx.uint32)).astype(mx.uint32)
    experts = experts[: min(128, 8 * l)]

    def proj(v, params, act):
        w, s, g = params
        n, k = w.shape[1], v.shape[-1]
        assert n % (ROWS * SIMDGROUPS) == 0 and k % 16 == 0
        return project(
            inputs=[v, w, s, ONE if g is None else g, slots, counts, experts],
            template=[
                ("K", k),
                ("N", n),
                ("L", l),
                ("ACT", act),
                ("ROWS", ROWS),
                ("SIMDGROUPS", SIMDGROUPS),
                ("FP8", moe.mode == "mxfp8"),
            ],
            grid=(32 * n // ROWS, experts.size, 1),
            threadgroup=(32 * SIMDGROUPS, 1, 1),
            output_shapes=[(l * 8, n // 2 if act else n)],
            output_dtypes=[mx.bfloat16],
        )[0]

    v = proj(proj(x.reshape(l, -1), moe.expand, True), moe.contract, False)
    if return_routed:
        return v, mx.arange(l * 8, dtype=mx.uint32), coeff
    return (
        (v.reshape(*sel.shape, x.shape[-1]).astype(mx.float32) * coeff[..., None])
        .sum(axis=-2)
        .astype(x.dtype)
    )
