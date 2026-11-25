"""Direct warp-sized routing plan for up to 32 tokens: no expert sort or token copy."""

import mlx.core as mx

from inkling.inkling_partial_steel import headers
from inkling.inkling_top8 import top8
from inkling.shaders import load_shader

plan = mx.fast.metal_kernel(
    name="inkling_short_expert_plan",
    input_names=["ids"],
    output_names=["slots", "counts"],
    source=load_shader("short_expert_plan.metal"),
)

project = mx.fast.metal_kernel(
    name="inkling_direct_short_expert",
    input_names=["a", "w", "sc", "gs", "slots", "counts"],
    output_names=["out"],
    header=headers,
    source=load_shader("direct_short_expert.metal"),
)


def direct(moe, x, *, return_routed=False):
    l = x.shape[1]
    assert 1 <= l <= 32 and moe.mode in {"nvfp4", "mxfp8"}
    sel, coeff = top8(x.astype(mx.float32) @ moe.router.T, moe.bias)
    slots, counts = plan(
        inputs=[sel],
        template=[("L", l)],
        grid=(32, 128, 1),
        threadgroup=(32, 1, 1),
        output_shapes=[(128, l), (128,)],
        output_dtypes=[mx.uint32, mx.uint32],
    )

    def proj(v, p, act):
        w, s, g = p
        n = w.shape[1]
        k = v.shape[-1]
        return project(
            inputs=[
                v,
                w,
                s,
                g if g is not None else mx.ones((128,), mx.float32),
                slots,
                counts,
            ],
            template=[
                ("K", k),
                ("N", n),
                ("L", l),
                ("ACT", act),
                ("FP8", moe.mode == "mxfp8"),
            ],
            grid=(64 * n // 32, (l + 7) // 8, 128),
            threadgroup=(64, 1, 1),
            output_shapes=[(l * 8, n // 2 if act else n)],
            output_dtypes=[mx.bfloat16],
        )[0]

    v = proj(proj(x, moe.expand, True), moe.contract, False)
    if return_routed:
        return v, mx.arange(l * 8, dtype=mx.uint32), coeff
    return (
        (v.reshape(*sel.shape, x.shape[-1]).astype(mx.float32) * coeff[..., None])
        .sum(axis=-2)
        .astype(x.dtype)
    )
