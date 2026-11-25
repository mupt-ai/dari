"""Compare both engines on identical teacher-forced prompts, weighting tokens equally.

Input is concatenated JSONL from eval_teacher.py and/or eval_unseen.py for
both arms. The expected prompt and position counts guard against accidentally
reporting a partial run as the entire corpus.
"""

import argparse
import json
import math
from pathlib import Path
from statistics import mean


def summarize(rows, prompts, positions):
    arms = {"ours": {}, "reference": {}}
    for r in rows:
        arm = arms[r["backend"]]
        key = r["prompt"]
        top = r["top1"]
        nll = r["nll"]
        if key in arm or not key or not top or len(top) != len(nll):
            raise ValueError("duplicate prompt or missing positions")
        if not all(type(t) is int and 0 <= t < 200058 for t in top) or not all(
            math.isfinite(x) for x in nll
        ):
            raise ValueError("invalid prediction or target NLL")
        arm[key] = r
    a, b = arms.values()
    if a.keys() != b.keys() or len(a) != prompts:
        raise ValueError("unmatched or incomplete prompts")
    delta = []
    correct = 0
    for key, r in a.items():
        ref = b[key]
        if (
            "prompt_tokens" in ref
            and "prompt_tokens" in r
            and ref["prompt_tokens"] != r["prompt_tokens"]
        ):
            raise ValueError("inconsistent prompt token counts")
        if r.get("target_tokens") != ref.get("target_tokens"):
            raise ValueError("inconsistent supplied target tokens")
        correct += sum(x == y for x, y in zip(r["top1"], ref["top1"], strict=True))
        delta.extend(x - y for x, y in zip(r["nll"], ref["nll"], strict=True))
    if len(delta) != positions:
        raise ValueError("incomplete target positions")
    return {
        "prompts": prompts,
        "positions": positions,
        "matching_reference_top1": correct,
        "mean_target_nll_delta": mean(delta),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompts", type=int, required=True)
    parser.add_argument("--positions", type=int, required=True)
    parser.add_argument("logs", nargs="+", type=Path)
    args = parser.parse_args()
    rows = []
    try:
        for log in args.logs:
            with log.open() as f:
                rows.extend(map(json.loads, f))
        print(json.dumps(summarize(rows, args.prompts, args.positions), indent=2))
    except (KeyError, ValueError) as exc:
        parser.exit(1, f"Cannot report comparison: {exc}\n")
