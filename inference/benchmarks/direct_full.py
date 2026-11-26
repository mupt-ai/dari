"""Screen direct routed I/O together with compact storage and sparse attention."""

import argparse
import runpy
import sys

from dari_engine.engines.inkling import inkling_model
from dari_engine.engines.inkling.combined_candidate import DirectModel

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
    a, extra = p.parse_known_args()
    if extra[:1] != ["ours"]:
        p.error("expected ours arm")
    inkling_model.Model = DirectModel
    sys.argv = [a.harness, *extra]
    runpy.run_module("benchmarks." + a.harness, run_name="__main__")
