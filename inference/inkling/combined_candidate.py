"""Independent candidate with compact projections and bounded KV growth."""

from inkling import inkling_model
from inkling.chunk_cache import append
from inkling.direct_experts import DirectExperts
from inkling.projection_storage import compact
from inkling.ragged_dispatch import RaggedMoE
from inkling.shared_decode import decode
from inkling.sparse_prefill import attention


class CandidateExperts(RaggedMoE):
    split = True


class Candidate(inkling_model.Model):
    prefill_attention = staticmethod(attention)
    expert_class = CandidateExperts
    global_prefill_store = staticmethod(append)
    long_decode_attention = staticmethod(decode)

    def __init__(self, path):
        super().__init__(path)
        compact(self)


class DirectModel(Candidate):
    """Use direct routed prefill and fused NVFP4 decode; other paths are identical."""

    expert_class = DirectExperts
