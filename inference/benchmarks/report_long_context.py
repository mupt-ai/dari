"""Summarize one serial four-process long_context.py log; reject incomplete/mixed runs."""

import argparse
import json
import math
from collections import Counter
from pathlib import Path
from statistics import mean, median


def summarize(rows):
    groups = []
    for row in rows:
        if row["event"] != "result":
            continue
        if row["run"] == 0:
            groups.append([])
        if not groups or row["run"] != len(groups[-1]):
            raise ValueError("Missing or out-of-order runs within a process")
        groups[-1].append(row)
    arms = [g[0]["arm"] for g in groups]
    if arms not in (
        ["ours", "reference", "reference", "ours"],
        ["reference", "ours", "ours", "reference"],
    ):
        raise ValueError(f"Expected four completed ABBA or BAAB processes; saw {arms}")
    config = groups[0][0]
    for group in groups:
        if len(group) != config["runs"] or len(group) < 2:
            raise ValueError("Missing cold or warm runs")
        for row in group:
            if (
                row.get("free_cache_mib") != config.get("free_cache_mib")
                or row.get("replay_sha256") != config.get("replay_sha256")
                or row["arm"] != group[0]["arm"]
                or any(
                    row[k] != config[k]
                    for k in ("length", "chunk", "decode", "runs", "sha256")
                )
            ):
                raise ValueError(
                    "Arms do not share a single benchmark configuration and prompt"
                )
            if (
                not all(
                    math.isfinite(row[k]) and row[k] > 0
                    for k in ("prefill_tps", "decode_tps", "peak_gib")
                )
                or not isinstance(row["output"], list)
                or len(row["output"]) != 1 + row["decode"]
                or not all(type(t) is int and 0 <= t < 200058 for t in row["output"])
            ):
                raise ValueError("Incomplete timing or decode record")
    warm = {
        arm: [row for group in groups if group[0]["arm"] == arm for row in group[1:]]
        for arm in ("ours", "reference")
    }
    metrics = {
        arm: {
            k: median(row[k] for row in runs)
            for k in ("prefill_tps", "decode_tps", "peak_gib")
        }
        for arm, runs in warm.items()
    }
    # Repetitions measure performance, not additional independent correctness cases.
    quality = []
    for engine, ref in zip(warm["ours"], warm["reference"], strict=True):
        a, b = engine["teacher"], ref["teacher"]
        expected = list(
            range(8 * config["chunk"], config["length"], 8 * config["chunk"])
        )
        if not a or any(
            [t[0] for t in records] != expected
            or not all(math.isfinite(t[2]) for t in records)
            for records in (a, b)
        ):
            raise ValueError("Missing or mismatched teacher-forced positions")
        difference_key = (
            "first_prediction_difference"
            if config.get("replay_sha256")
            else "first_greedy_difference"
        )
        quality.append(
            {
                "top1_matches": sum(x[1] == y[1] for x, y in zip(a, b)),
                "positions": len(a),
                "mean_nll_delta": mean(x[2] - y[2] for x, y in zip(a, b)),
                difference_key: next(
                    (
                        i
                        for i, (x, y) in enumerate(
                            zip(engine["output"], ref["output"], strict=True)
                        )
                        if x != y
                    ),
                    None,
                ),
            }
        )
    return {
        "length": config["length"],
        "chunk": config["chunk"],
        "sha256": config["sha256"],
        "decode_mode": "fixed_reference_inputs"
        if config.get("replay_sha256")
        else "greedy",
        "free_cache_mib": config.get("free_cache_mib"),
        "process_order": arms,
        "warm_samples": dict(
            Counter(row["arm"] for runs in warm.values() for row in runs)
        ),
        # Show each process separately: a single median can hide paging or
        # thermal variation. Never pool cold rows, cache caps or replay modes.
        "warm_processes": [
            {
                "arm": group[0]["arm"],
                **{
                    k: median(row[k] for row in group[1:])
                    for k in ("prefill_tps", "decode_tps", "peak_gib")
                },
            }
            for group in groups
        ],
        "median": metrics,
        "throughput_gain_percent": {
            k: 100 * (metrics["ours"][k] / metrics["reference"][k] - 1)
            for k in ("prefill_tps", "decode_tps")
        },
        "quality_per_pair": quality,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", type=Path)
    args = parser.parse_args()
    try:
        with args.log.open() as f:
            result = summarize(map(json.loads, f))
    except (ValueError, KeyError) as exc:
        parser.exit(1, f"Cannot report comparison: {exc}\n")
    print(json.dumps(result, indent=2))
