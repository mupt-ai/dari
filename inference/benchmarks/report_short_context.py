"""Validate and summarize a complete bench_independent.py four-process log.

Each process prints 1008 then 16 tokens in three successive runs. Run zero is
cold. Rows contain a synchronous greedy trajectory, not held-out test labels.
"""

import argparse
import json
import math
import re
from pathlib import Path
from statistics import median


def summarize(lines):
    rows = []
    markers = []
    for line in lines:
        if line.startswith("# fixed_reference_inputs "):
            digest = line.split()[-1]
            if not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise ValueError("invalid replay digest")
            markers.append((len(rows), digest))
            continue
        arm, run, length, prefill, decode, tokens = line.split(maxsplit=5)
        tokens = json.loads(tokens)
        if (
            not isinstance(tokens, list)
            or len(tokens) != 64
            or not all(type(t) is int and 0 <= t < 200058 for t in tokens)
        ):
            raise ValueError("incomplete or invalid greedy trajectory")
        rates = (float(prefill), float(decode))
        if not all(math.isfinite(v) and v > 0 for v in rates):
            raise ValueError("invalid timing")
        rows.append((arm, int(run), int(length), *rates, tokens))
    if len(rows) != 24:
        raise ValueError(f"expected exactly 24 measurements, found {len(rows)}")
    if markers and (
        len({d for _, d in markers}) != 1 or [n for n, _ in markers] != [0, 6, 12, 18]
    ):
        raise ValueError("cannot mix decode modes or reference trajectories")
    order = [rows[start][0] for start in range(0, 24, 6)]
    if order not in (
        ["ours", "reference", "reference", "ours"],
        ["reference", "ours", "ours", "reference"],
    ):
        raise ValueError("expected ABBA or BAAB process order")
    expected = [(a, r, n) for a in order for r in range(3) for n in (1008, 16)]
    if [r[:3] for r in rows] != expected:
        raise ValueError("missing or out-of-order measurement")
    summary = {}
    for length in (16, 1008):
        result = {
            arm: {
                metric: median(
                    r[i] for r in rows if r[0] == arm and r[1] > 0 and r[2] == length
                )
                for i, metric in enumerate(("prefill_tps", "decode_tps"), 3)
            }
            for arm in ("ours", "reference")
        }
        result["gain_percent"] = {
            k: 100 * (v / result["reference"][k] - 1) for k, v in result["ours"].items()
        }
        # Pair warm repetitions in process order; report the first divergence,
        # not the number of coincidental matches after the trajectories split.
        # Repetitions of one prompt are not independent accuracy examples.
        warm = {
            arm: [r[5] for r in rows if r[0] == arm and r[1] > 0 and r[2] == length]
            for arm in ("ours", "reference")
        }
        result[
            "first_prediction_difference_per_pair"
            if markers
            else "first_greedy_difference_per_pair"
        ] = [
            next((i for i, (x, y) in enumerate(zip(a, b, strict=True)) if x != y), None)
            for a, b in zip(warm["ours"], warm["reference"], strict=True)
        ]
        summary[length] = result
    return {
        "process_order": order,
        "decode_mode": "fixed_reference_inputs" if markers else "greedy",
        "replay_sha256": markers[0][1] if markers else None,
        "warm_samples_per_arm_per_length": 4,
        "lengths": summary,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", type=Path)
    args = parser.parse_args()
    try:
        with args.log.open() as f:
            print(json.dumps(summarize(f), indent=2))
    except ValueError as exc:
        parser.exit(1, f"Cannot report comparison: {exc}\n")
