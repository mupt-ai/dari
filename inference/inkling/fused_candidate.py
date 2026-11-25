"""Independent prefill fusion candidate. Decode uses the direct-route engine."""

from inkling import prefill_mix
from inkling.combined_candidate import DirectModel
from inkling.direct_experts import DirectExperts
from inkling.implicit_messages import ImplicitMessageBank
from inkling.local_head_fir import filtered


class HoistedExperts(DirectExperts):
    hoist_addresses = True


class FusedModel(DirectModel):
    prefill_mix = prefill_mix
    local_prefill_heads = staticmethod(filtered)
    compact_message_bank = True
    message_bank_type = ImplicitMessageBank
    expert_class = HoistedExperts

    @staticmethod
    def prefill_attention(q, k, v, rel, sinks, local):
        from inkling.sparse_prefill import attention

        return attention(q, k, v, rel, sinks, local, 32, 64, whole=True)

    def __init__(self, path):
        from inkling.packed_message_gate import pack

        super().__init__(path)
        for w in self.layers:
            for name in ("q", "k", "v", "mlp"):
                p = name + "_message_gate."
                if p + "forget_gate_proj.weight" in w:
                    w[p + "packed_pair"] = pack(
                        w[p + "forget_gate_proj.weight"],
                        w[p + "message_gate_proj.weight"],
                    )
