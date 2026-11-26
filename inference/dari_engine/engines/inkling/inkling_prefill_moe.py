"""Grouped mixed-precision prefill; single-token decode uses native packed matvecs."""

from .inkling_adaptive_tiles import adaptive
from .inkling_moe import InklingMoE
from .inkling_partial_steel import tile_body
from .inkling_short_plan import direct
from .inkling_short_steel import compact
from .routed_experts import routed

_fp4 = adaptive()
_fp8 = adaptive(tile_body("mxfp8"), name="inkling_adaptive_fp8")


class PrefillMoE(InklingMoE):
    def __call__(self, x, *, return_routed=False):
        length = x.shape[1]
        if length == 1:
            return super().__call__(x, return_routed=return_routed)
        if length <= 8:
            # Verification blocks: read each selected expert once.
            return routed(self, x, return_routed=return_routed)
        if length <= 32:
            return direct(self, x, return_routed=return_routed)
        if length < 64 and self.mode == "nvfp4":
            return compact(self, x, return_routed=return_routed)
        return compact(
            self,
            x,
            (64, 64, 32, 2, 2),
            program=_fp4 if self.mode == "nvfp4" else _fp8,
            return_routed=return_routed,
        )
