"""Use BF16 matrix operands only when F32 checkpoint gate matrices round-trip exactly.

Keep FP32 accumulation and nonlinear blending. Generate the implicit message
from its two bank rows at writeout; no BF16 rounding of the gate logits.
"""

import mlx.core as mx

from .inkling_partial_steel import headers
from .shaders import load_shader

kernel = mx.fast.metal_kernel(
    name="inkling_lossless_gate_pair",
    input_names=["z", "w", "v", "a", "b", "s", "slot"],
    output_names=["y"],
    ensure_row_contiguous=False,
    header=headers,
    source=load_shader("lossless_gate_pair.metal"),
)


def fused(z, w, v, bank, slot, shape=(32, 128, 2, 4)):
    l = v.shape[1]
    bm, bn, wm, wn = shape
    return kernel(
        inputs=[
            z.astype(mx.bfloat16),
            w,
            v,
            bank.a,
            bank.b,
            bank.scores,
            mx.array(slot, mx.uint32),
        ],
        template=[("L", l), ("BM", bm), ("BN", bn), ("WM", wm), ("WN", wn)],
        grid=(32 * wm * wn * 4608 // bn, (l + bm - 1) // bm, 1),
        threadgroup=(32 * wm * wn, 1, 1),
        output_shapes=[v.shape],
        output_dtypes=[mx.float32],
    )[0]


def pack(forget, message):
    """None selects the original float32 path for nonrepresentable weights."""
    pair = mx.stack([forget, message], axis=1).reshape(-1, 64)
    packed = pair.astype(mx.bfloat16)
    return packed if mx.array_equal(pair, packed.astype(mx.float32)).item() else None
