"""Experimental global KV append for prefill; no prefix reuse across requests.

Grow the head-major backing in bounded pages rather than concatenate all prior
keys and values on every multi-token append. Attention always sees only live
positions. Test with PYTHONPATH=. python benchmarks/chunk_cache.py HARNESS ours.
"""

import argparse
import runpy
import sys

from dari_engine.engines.inkling.chunk_cache import append

if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "harness",
        choices=("long_context", "eval_teacher", "eval_unseen", "bench_independent"),
    )
    args, extra = p.parse_known_args()
    if extra[:1] != ["ours"]:
        p.error("expected ours arm")
    from dari_engine.engines.inkling.inkling_model import Model

    Model.global_prefill_store = staticmethod(append)
    sys.argv = [args.harness, *extra]
    runpy.run_module("benchmarks." + args.harness, run_name="__main__")
