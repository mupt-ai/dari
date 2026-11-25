"""Run in separate processes: python -m benchmarks.bench_independent {ours,reference}."""

import argparse
import hashlib
import json
import time
from pathlib import Path

import mlx.core as mx
from huggingface_hub import snapshot_download
from tokenizers import Tokenizer

from benchmarks.benchmark_lock import exclusive_gpu
from inkling.inkling_model import Model

parser = argparse.ArgumentParser()
parser.add_argument("backend", choices=["ours", "reference"])
parser.add_argument(
    "--replay-reference",
    type=Path,
    help="complete greedy short log to source fixed decode inputs",
)
parser.add_argument(
    "--snapshot", type=Path, help="Local Inkling checkpoint for both engines."
)
args = parser.parse_args()
replays = {}
if args.replay_reference:
    from benchmarks.report_short_context import summarize

    records = args.replay_reference.read_text().splitlines()
    if summarize(records)["decode_mode"] != "greedy":
        parser.error("replay must originate from a greedy comparison")
    for record in records:
        arm, run, n, _, _, tokens = record.split(maxsplit=5)
        if arm == "reference" and int(run) > 0:
            seq = json.loads(tokens)
            if replays.setdefault(int(n), seq) != seq:
                parser.error("ambiguous reference trajectory")
    print(
        "# fixed_reference_inputs",
        hashlib.sha256(json.dumps(replays, sort_keys=True).encode()).hexdigest(),
        flush=True,
    )
_gpu_lock = exclusive_gpu()
p = args.snapshot or Path(
    snapshot_download(
        "mlx-community/Inkling-2-Mini-4bit",
        revision="9c0e2960609ba7cb40daf92c6f7bf8ed56e1dd62",
        allow_patterns=["*.json", "*.safetensors", "*.jinja"],
        local_files_only=True,
    )
)
tok = Tokenizer.from_file(str(p / "tokenizer.json"))
if args.backend == "ours":
    forward = Model(p)
    make_cache = lambda: [{} for _ in range(48)]
else:
    from mlx_lm import load

    model, _ = load(str(p), lazy=True)
    make_cache = model.make_cache

    def forward(x, c):
        return model.lm_head(model.model.language_model(x, cache=c)[:, -1:])[
            ..., :200058
        ]


for run in range(3):
    for prompt in [
        "The lake was blue and the sky was clear. " * 100
        + "Count from one to fifty in English:",
        "Explain how a database recovers from a crash using its write-ahead log:",
    ]:
        ids = tok.encode(prompt).ids
        x = mx.array([ids])
        c = make_cache()
        replay = replays[len(ids)] if replays else None
        start = time.perf_counter()
        out = []
        for i in range(64):
            v = mx.argmax(forward(x, c)).item()
            out.append(v)
            x = mx.array([[v if replay is None else replay[i]]])
            if i == 0:
                first = time.perf_counter()
        print(
            args.backend,
            run,
            len(ids),
            round(len(ids) / (first - start), 1),
            round(63 / (time.perf_counter() - first), 1),
            out,
            flush=True,
        )
