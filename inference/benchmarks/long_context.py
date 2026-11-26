"""From the engine directory: PYTHONPATH=. python -m benchmarks.long_context ours."""

import argparse
import hashlib
import json
import time
from pathlib import Path

import mlx.core as mx
from huggingface_hub import snapshot_download
from tokenizers import Tokenizer

from benchmarks.benchmark_lock import exclusive_gpu

REVISION = "9c0e2960609ba7cb40daf92c6f7bf8ed56e1dd62"


def prompt(tok, length):
    def encode(text):
        return tok.encode(text, add_special_tokens=False).ids

    head = encode("Observatory register. The brass key is stored in locker violet.\n")
    tail = encode(
        "\nConsult the opening note. Which locker holds the brass key? Answer:"
    )
    if length < len(head) + len(tail):
        raise ValueError("Length too small for retrieval prompt")
    i = 0
    while len(head) < length - len(tail):
        head.extend(
            encode(
                f"Night {i}: station {i * 17 % 137}, wind {i * 31 % 91}, bearing {i * 71 % 360}.\n"
            )
        )
        i += 1
    return head[: length - len(tail)] + tail


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("arm", choices=["ours", "reference"])
    parser.add_argument("--length", type=int, default=50000)
    parser.add_argument("--chunk", type=int, default=1024)
    parser.add_argument("--decode", type=int, default=63)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument(
        "--replay-reference",
        type=Path,
        metavar="LOG.jsonl",
        help="Also available as a distinct timing mode: feed a previously measured reference greedy trajectory to both engines.",
    )
    parser.add_argument(
        "--free-cache-mib",
        type=int,
        default=None,
        help="Diagnostic only: cap the MLX unused-buffer pool equally in BOTH arms. Omit for standard timings.",
    )
    parser.add_argument(
        "--snapshot", type=Path, help="Local Inkling checkpoint for both engines."
    )
    args = parser.parse_args()
    if args.free_cache_mib is not None and args.free_cache_mib < 0:
        parser.error("free-cache cap must be nonnegative")
    if min(args.chunk, args.decode, args.runs) < 1:
        parser.error("positive sizes required")
    _gpu_lock = exclusive_gpu()
    if args.free_cache_mib is not None:
        mx.set_cache_limit(args.free_cache_mib * 2**20)
    path = args.snapshot or Path(
        snapshot_download(
            "mlx-community/Inkling-2-Mini-4bit",
            revision=REVISION,
            allow_patterns=["*.json", "*.jinja", "*.safetensors"],
            local_files_only=True,
        )
    )
    tok = Tokenizer.from_file(str(path / "tokenizer.json"))
    ids = prompt(tok, args.length)
    digest = hashlib.sha256(json.dumps(ids).encode()).hexdigest()
    replay = None
    if args.replay_reference:
        with args.replay_reference.open() as f:
            traces = {
                tuple(row["output"])
                for row in map(json.loads, f)
                if row["event"] == "result"
                and row["arm"] == "reference"
                and row["run"] > 0
                and row["sha256"] == digest
                and row["chunk"] == args.chunk
                and row["decode"] == args.decode
                and not row.get("replay_sha256")
            }
        if len(traces) != 1:
            parser.error("need exactly one distinct matching warm reference trajectory")
        replay = traces.pop()
        if len(replay) != args.decode + 1 or not all(
            type(t) is int and 0 <= t < 200058 for t in replay
        ):
            parser.error("invalid reference trajectory")
    if args.arm == "ours":
        from dari_engine.engines.inkling.inkling_model import Model

        forward = Model(path)

        def cache():
            return [{} for _ in range(48)]
    else:
        from mlx_lm import load

        m, _ = load(str(path), lazy=True)
        cache = m.make_cache

        def forward(x, c):
            return m.lm_head(m.model.language_model(x, cache=c)[:, -1:])[..., :200058]

    chunks = [
        mx.array([ids[i : i + args.chunk]]) for i in range(0, len(ids), args.chunk)
    ]
    mx.eval(chunks)
    for run in range(args.runs):
        c = cache()
        samples = []
        mx.reset_peak_memory()
        tic = time.perf_counter()
        offset = 0
        for chunk in chunks:
            logits = forward(chunk, c)
            offset += chunk.shape[1]
            mx.eval(logits)
            if offset < len(ids) and (offset // args.chunk) % 8 == 0:
                # Per-chunk logits are already computed for both arms. Save identical
                # teacher-forced positions, outside the timed segment for scoring.
                samples.append((offset, logits))
            if offset % 8192 == 0:
                print(
                    json.dumps(
                        {
                            "event": "progress",
                            "arm": args.arm,
                            "run": run,
                            "offset": offset,
                        }
                    ),
                    flush=True,
                )
        first = mx.argmax(logits).item()
        prefill = time.perf_counter() - tic
        out = [first]
        tic = time.perf_counter()
        for step in range(args.decode):
            token = out[-1] if replay is None else replay[step]
            out.append(mx.argmax(forward(mx.array([[token]]), c)).item())
        decode = time.perf_counter() - tic
        quality = []
        for off, logits in samples:
            v = 30 * mx.tanh(logits.flatten().astype(mx.float32) / 30)
            quality.append(
                [off, mx.argmax(v).item(), (mx.logsumexp(v) - v[ids[off]]).item()]
            )
        print(
            json.dumps(
                dict(
                    event="result",
                    **{
                        k: v
                        for k, v in vars(args).items()
                        if k not in ("replay_reference", "snapshot")
                    },
                    replay_sha256=(
                        hashlib.sha256(json.dumps(replay).encode()).hexdigest()
                        if replay is not None
                        else None
                    ),
                    run=run,
                    sha256=digest,
                    prefill_tps=len(ids) / prefill,
                    decode_tps=args.decode / decode,
                    peak_gib=mx.get_peak_memory() / 2**30,
                    teacher=quality,
                    output=out,
                    text=tok.decode(out),
                )
            ),
            flush=True,
        )
        del c, samples, logits


if __name__ == "__main__":
    main()
