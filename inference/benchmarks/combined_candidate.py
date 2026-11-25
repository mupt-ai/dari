"""End-to-end test of independent candidate changes together; default model untouched.

From the engine directory, PYTHONPATH=. python benchmarks/combined_candidate.py
{bench_independent,eval_teacher,eval_unseen,long_context} ours [harness options].
"""

import argparse
import runpy
import sys

from inkling import inkling_model
from inkling.combined_candidate import Candidate

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "harness",
        choices=["bench_independent", "eval_teacher", "eval_unseen", "long_context"],
    )
    args, extra = parser.parse_known_args()
    if extra[:1] != ["ours"]:
        parser.error("expected ours arm")
    inkling_model.Model = Candidate
    sys.argv = [args.harness, *extra]
    runpy.run_module("benchmarks." + args.harness, run_name="__main__")
