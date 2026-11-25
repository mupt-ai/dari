"""Experimental long-prefill dispatch: reuse histogram boundaries and avoid padded copies.

From the engine directory: PYTHONPATH=. .venv/bin/python benchmarks/ragged_dispatch.py
Use `--harness bench_independent ours` for the unmodified full-model timing protocol.
"""

import argparse
import runpy
import sys
from statistics import median
from time import perf_counter

import mlx.core as mx

from inkling.inkling_prefill_moe import PrefillMoE
from inkling.ragged_dispatch import RaggedMoE

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--harness", choices=["bench_independent", "eval_teacher", "eval_unseen"]
    )
    parser.add_argument("--split", action="store_true")
    args, extra = parser.parse_known_args()
    RaggedMoE.split = args.split
    if args.harness:
        if extra[:1] != ["ours"]:
            parser.error("use ours arm")
        from inkling import inkling_model

        inkling_model.Model.expert_class = RaggedMoE
        sys.argv = [args.harness, *extra]
        runpy.run_module("benchmarks." + args.harness, run_name="__main__")
    else:
        from copy import copy

        from benchmarks.bench_expert_real import moe, states

        candidate = copy(moe)
        candidate.__class__ = RaggedMoE
        arms = [lambda: PrefillMoE.__call__(moe, states), lambda: candidate(states)]
        ts = [[], []]
        ref = None
        for r in range(12):
            for i in [r % 2, (r + 1) % 2]:
                t = perf_counter()
                out = arms[i]()
                mx.eval(out)
                ts[i].append(1000 * (perf_counter() - t))
                if ref is None:
                    ref = out
                elif r == 0 and not mx.array_equal(ref, out).item():
                    raise ValueError("Outputs differ: do not advance")
        print(
            "median ms, default and ragged:", *[median(t[2:]) for t in ts], flush=True
        )
