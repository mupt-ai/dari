"""Experiment: keep one packed backing tensor per attention projection group.

Run with the worktree venv: python benchmarks/projection_storage.py --audit
or: python benchmarks/projection_storage.py {bench_independent,eval_teacher,eval_unseen,long_context} ours [options].
The audit reads only safetensor headers; it reports nominal tensor bytes, not RAM
or throughput. The experiment never changes the default model or reference arm.
"""

import argparse
import json
import runpy
import struct
import sys
from pathlib import Path

from inkling.projection_storage import compact

REV = "9c0e2960609ba7cb40daf92c6f7bf8ed56e1dd62"
PARTS = ("q", "r", "gate", "sink")
FIELDS = ("weight", "scales", "biases")


def audit():
    from huggingface_hub import snapshot_download

    path = Path(
        snapshot_download(
            "mlx-community/Inkling-2-Mini-4bit",
            revision=REV,
            allow_patterns=["*.safetensors"],
            local_files_only=True,
        )
    )
    sizes = {}
    for shard in path.glob("*.safetensors"):
        with shard.open("rb") as f:
            (size,) = struct.unpack("<Q", f.read(8))
            for k, v in json.loads(f.read(size)).items():
                if "data_offsets" in v:
                    a, b = v["data_offsets"]
                    sizes[k] = b - a
    # Only count buffers actually consumed in steady state. Non-recurrent local
    # layers use all_proj only: their intermediate qrgs may be released by MLX.
    saved = 0
    for i in range(24):

        def n(names, i=i):
            return sum(
                sizes[f"model.language_model.layers.{i}.self_attn.{p}_proj.{s}"]
                for p in names
                for s in FIELDS
            )

        saved += n(PARTS) if i % 6 == 5 else n((*PARTS, "k", "v"))
        if 6 <= i < 18 and i % 6 != 5:
            saved += n(PARTS)
    return {"nominal_redundant_bytes_if_materialized": saved, "MiB": saved / 2**20}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit", action="store_true")
    parser.add_argument(
        "harness",
        nargs="?",
        choices=("bench_independent", "eval_teacher", "eval_unseen", "long_context"),
    )
    args, more = parser.parse_known_args()
    if args.audit:
        print(json.dumps(audit(), indent=2))
        sys.exit()
    if not args.harness or more[:1] != ["ours"]:
        parser.error("select a harness and the ours arm")
    from inkling import inkling_model

    class CompactModel(inkling_model.Model):
        def __init__(self, path):
            super().__init__(path)
            compact(self)

    inkling_model.Model = CompactModel
    sys.argv = [args.harness, *more]
    runpy.run_module("benchmarks." + args.harness, run_name="__main__")
