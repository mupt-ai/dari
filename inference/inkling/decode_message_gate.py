"""Two gate dot products per channel from each row's 64-element decode state.

Eight lanes cooperate on each pair of packed BF16 weight rows. The gate
logits, nonlinearities and message blend stay FP32. Packing and its exact
representability check are shared with the prefill implementation.
"""

import mlx.core as mx

from inkling.affine_candidate import AffineModel
from inkling.shaders import load_shader

kernel = mx.fast.metal_kernel(
    name="inkling_decode_message_gate_pair",
    input_names=["gate_state", "packed_weights", "hidden", "message"],
    output_names=["output"],
    ensure_row_contiguous=False,
    source=load_shader("decode_message_gate_pair.metal"),
)


def project(z, packed, v, msg):
    return kernel(
        inputs=[mx.contiguous(z), packed, v, msg],
        grid=(2304 * 8, z.shape[1], 1),
        threadgroup=(128, 1, 1),
        output_shapes=[v.shape],
        output_dtypes=[mx.float32],
    )[0]


class GatedModel(AffineModel):
    """Use the checked BF16 gate weights for decode and verification rows as well."""

    decode_message_mix = staticmethod(project)
