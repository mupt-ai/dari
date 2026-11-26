"""Independent candidate with compact projections and bounded KV growth."""

from . import inkling_model
from .chunk_cache import append
from .direct_experts import DirectExperts
from .projection_storage import compact
from .ragged_dispatch import RaggedMoE
from .shared_decode import decode, decode_rows
from .sparse_prefill import attention


class CandidateExperts(RaggedMoE):
    split = True


class Candidate(inkling_model.Model):
    prefill_attention = staticmethod(attention)
    expert_class = CandidateExperts
    global_prefill_store = staticmethod(append)
    long_decode_attention = staticmethod(decode)
    long_rows_attention = staticmethod(decode_rows)

    def __init__(self, path):
        super().__init__(path)
        compact(self)


class DirectModel(Candidate):
    """Use direct routed prefill and fused NVFP4 decode; other paths are identical."""

    expert_class = DirectExperts
