"""Evaluate the short-row kernel in the unchanged end-to-end harness."""

import runpy
import sys
from pathlib import Path
from dari_engine.engines.inkling.inkling_moe import InklingMoE
from dari_engine.engines.inkling.inkling_short_steel import compact

from dari_engine.engines.inkling.inkling_adaptive_tiles import adaptive
from dari_engine.engines.inkling.inkling_short_plan import direct

program = adaptive()
baseline = InklingMoE.__call__


def forward(self, x, *, return_routed=False):
    if self.mode == "nvfp4" and x.shape[1] >= 64:
        return compact(
            self, x, (64, 64, 32, 2, 2), program=program, return_routed=return_routed
        )
    if self.mode == "nvfp4" and 8 <= x.shape[1] <= 32:
        return direct(self, x, return_routed=return_routed)
    if self.mode == "nvfp4" and 8 <= x.shape[1] < 64:
        return compact(self, x, return_routed=return_routed)
    return baseline(self, x, return_routed=return_routed)


if __name__ == "__main__":
    harness = sys.argv.pop(1)
    if (
        harness not in {"bench_independent", "eval_teacher", "eval_unseen"}
        or sys.argv[1] != "ours"
    ):
        raise SystemExit("Expected harness and ours arm.")
    from dari_engine.engines.inkling.inkling_model import Model

    Model.expert_class = InklingMoE
    InklingMoE.__call__ = forward
    runpy.run_path(str(Path(__file__).with_name(harness + ".py")), run_name="__main__")
