"""Screen fused prefill with whole-head attention and losslessly packed gate weights."""

import argparse
import runpy
import sys

from inkling import inkling_model
from inkling.fused_candidate import FusedModel

if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "harness",
        choices=(
            "bench_independent",
            "eval_teacher",
            "eval_unseen",
            "long_context",
            "heldout_register",
        ),
    )
    p.add_argument(
        "--affine",
        action="store_true",
        help="Use 64×64 tiles for wide affine attention projections",
    )
    p.add_argument(
        "--gated",
        action="store_true",
        help="Also use the single-token paired gate projection",
    )
    a, extra = p.parse_known_args()
    if extra[:1] != ["ours"]:
        p.error("expected ours arm")
    if a.gated and a.affine:
        p.error("select just one engine variant")
    if a.gated:
        from inkling.decode_message_gate import GatedModel

        inkling_model.Model = GatedModel
    elif a.affine:
        from inkling.affine_candidate import AffineModel

        inkling_model.Model = AffineModel
    else:
        inkling_model.Model = FusedModel
    sys.argv = [a.harness, *extra]
    runpy.run_module("benchmarks." + a.harness, run_name="__main__")
