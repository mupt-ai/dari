"""Read each recurrent message from its two weighted source rows inside each gate."""

import mlx.core as mx

from .inkling_message_bank import MessageBank
from .shaders import load_shader

# One threadgroup handles a token. Each of its 256 threads owns nine channels.
_GATE_HEADER = load_shader("inverse_rms.metal")

_GATE_INPUTS = ["source_a", "source_b", "scores", "slot", "hidden"]
# Slice each source with its own stride: a cached bank row need not be contiguous.
_TOKEN_ROWS = load_shader("message_source_rows.metal")

_normalize_gate_inputs = mx.fast.metal_kernel(
    name="inkling_message_load_norm",
    input_names=_GATE_INPUTS,
    output_names=["output"],
    ensure_row_contiguous=False,
    header=_GATE_HEADER,
    source=_TOKEN_ROWS + load_shader("message_load_norm.metal"),
)

_finish_gate = mx.fast.metal_kernel(
    name="inkling_implicit_gate_rms",
    input_names=_GATE_INPUTS + ["forget_logits", "message_logits", "norm_weight"],
    output_names=["output"],
    ensure_row_contiguous=False,
    header=_GATE_HEADER,
    source=_TOKEN_ROWS + load_shader("implicit_gate_rms.metal"),
)


class ImplicitMessageBank(MessageBank):
    """Store two source rows and 48 score pairs; materialize only at use."""

    def group(self, index):
        return MessageGroup(self, index)


class MessageGroup:
    def __init__(self, bank, index):
        self.bank, self.index = bank, index

    def _apply(self, kernel, slot, v, extra, dtype, width):
        bank = self.bank
        return kernel(
            inputs=[
                bank.a,
                bank.b,
                bank.scores,
                mx.array(self.index * 4 + slot, mx.uint32),
                v,
                *extra,
            ],
            template=[("T", dtype)],
            grid=(256, v.shape[1], 1),
            threadgroup=(256, 1, 1),
            output_shapes=[(1, v.shape[1], width)],
            output_dtypes=[dtype],
        )[0]

    def gate_input(self, slot, v, dtype):
        return self._apply(_normalize_gate_inputs, slot, v, [], dtype, 4608)

    def finish(self, slot, v, f, g, weight, dtype):
        return self._apply(_finish_gate, slot, v, [f, g, weight], dtype, 2304)
