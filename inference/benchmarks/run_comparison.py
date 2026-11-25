"""Run four fresh, matched processes under one exclusive GPU lease; never overwrite a log."""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from benchmarks.benchmark_lock import INHERITED_FD, exclusive_gpu
from benchmarks.report_long_context import summarize as long_report
from benchmarks.report_short_context import summarize as short_report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("workload", choices=["short", "long"])
    p.add_argument(
        "output", type=Path, help="new raw log; partial logs are retained on failure"
    )
    p.add_argument(
        "--engine",
        choices=["default", "direct", "combined", "fused", "affine", "gated"],
        default="direct",
    )
    p.add_argument(
        "--order",
        choices=["ABBA", "BAAB"],
        default="ABBA",
        help="A = independent; B = MLX-LM",
    )
    p.add_argument("--length", type=int, help="long prompt size; defaults to 50000")
    p.add_argument(
        "--free-cache-mib",
        type=int,
        help="long only: diagnostic cap in both arms, omitted by default",
    )
    p.add_argument(
        "--replay-reference",
        type=Path,
        help="replay the same logged trajectory in both arms",
    )
    p.add_argument(
        "--snapshot", type=Path, help="Local Inkling checkpoint for both engines."
    )
    a = p.parse_args()
    long = a.workload == "long"
    harness = "long_context" if long else "bench_independent"
    opts = []
    if not long and any(x is not None for x in [a.length, a.free_cache_mib]):
        p.error("long-context options require the long workload")
    if long:
        opts = [
            "--runs",
            "2",
            "--length",
            str(a.length if a.length is not None else 50000),
        ]
        if a.free_cache_mib is not None:
            opts += ["--free-cache-mib", str(a.free_cache_mib)]
    if a.snapshot is not None:
        opts += ["--snapshot", str(a.snapshot.resolve())]
    if a.replay_reference is not None:
        opts += ["--replay-reference", str(a.replay_reference.resolve())]
    root = Path(__file__).resolve().parents[1]
    with a.output.open("x") as log, exclusive_gpu() as lease:
        fd = lease.fileno()
        env = {**os.environ, INHERITED_FD: str(fd)}
        for i, letter in enumerate(a.order, 1):
            arm = "ours" if letter == "A" else "reference"
            prefix = ["benchmarks." + harness]
            if arm == "ours" and a.engine != "default":
                prefix = [
                    "benchmarks."
                    + {
                        "direct": "direct_full",
                        "combined": "combined_candidate",
                        "fused": "fused_full",
                        "affine": "fused_full",
                        "gated": "fused_full",
                    }[a.engine],
                    harness,
                ]
            cmd = [sys.executable, "-m", *prefix, arm, *opts]
            if arm == "ours" and a.engine in {"affine", "gated"}:
                cmd.append("--" + a.engine)
            print(f"[{i}/4]", *cmd, file=sys.stderr, flush=True)
            subprocess.run(
                cmd, check=True, cwd=root, stdout=log, pass_fds=(fd,), env=env
            )
    with a.output.open() as f:
        result = long_report(map(json.loads, f)) if long else short_report(f)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
