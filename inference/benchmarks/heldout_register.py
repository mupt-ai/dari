"""Independent long-context quality case: two dated corrections at different depths.

This is not a speed benchmark. Each arm gets fresh caches and identical token
IDs in 1,024-token chunks; use the same free allocator cache limit for both.
The specified answer is scored under teacher forcing (not
as free generation). Prints target top-1 and NLL in the eval_teacher schema.
"""

import argparse
import hashlib
import json
from pathlib import Path

import mlx.core as mx
from huggingface_hub import snapshot_download
from tokenizers import Tokenizer

from benchmarks.benchmark_lock import exclusive_gpu
from benchmarks.long_context import REVISION


def fixture(tok, length):
    def ids(s):
        return tok.encode(s, add_special_tokens=False).ids

    rows = ids(
        "Maintenance ledger. A later signed amendment supersedes an earlier assignment.\n"
    )
    tail = ids(
        "\nFor order AZ-417, give the final depot and the original depot, in that order.\nFinal and original:"
    )
    i = 0
    for position, entry in (
        (length // 4, "\nOrder AZ-417: signed assignment, depot Cedar.\n"),
        (
            3 * length // 4,
            "\nOrder AZ-417: signed amendment, move the order to depot Amber.\n",
        ),
        (length - len(tail), None),
    ):
        if len(rows) > position:
            raise ValueError("length too small for case")
        while len(rows) < position:
            rows.extend(
                ids(
                    f"Inventory B-{i}: {i * 37 % 991} amber lamps; {i * 73 % 353} cedar pegs; shelf {i % 131}.\n"
                )
            )
            i += 1
        del rows[position:]
        if entry:
            rows.extend(ids(entry))
    return rows + tail, ids(" Amber, Cedar.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("arm", choices=["ours", "reference"])
    parser.add_argument("--length", type=int, required=True)
    parser.add_argument(
        "--snapshot", type=Path, help="Local Inkling checkpoint for both engines."
    )
    args = parser.parse_args()
    _lock = exclusive_gpu()
    mx.set_cache_limit(512 * 2**20)
    path = args.snapshot or Path(
        snapshot_download(
            "mlx-community/Inkling-2-Mini-4bit",
            revision=REVISION,
            local_files_only=True,
            allow_patterns=["*.json", "*.jinja", "*.safetensors"],
        )
    )
    tok = Tokenizer.from_file(str(path / "tokenizer.json"))
    ids, answer = fixture(tok, args.length)
    if args.arm == "ours":
        from dari_engine.engines.inkling.inkling_model import Model

        model = Model(path)
        cache = [{} for _ in range(48)]

        def forward(x):
            return 30 * mx.tanh(model(x, cache).astype(mx.float32) / 30)
    else:
        from mlx_lm import load

        model, _ = load(str(path), lazy=True)
        cache = model.make_cache()

        def forward(x):
            return model(x, cache=cache)[:, -1:]

    for i in range(0, len(ids), 1024):
        logits = forward(mx.array([ids[i : i + 1024]]))
        mx.eval(logits)
    nll = []
    tops = []
    for i, t in enumerate(answer):
        if i:
            logits = forward(mx.array([[answer[i - 1]]]))
        y = logits.astype(mx.float32).flatten()
        nll.append((mx.logsumexp(y) - y[t]).item())
        tops.append(mx.argmax(y).item())
    digest = hashlib.sha256(json.dumps(ids).encode()).hexdigest()
    print(
        json.dumps(
            {
                "prompt": f"AZ-417/{len(ids)}/{digest}",
                "prompt_tokens": len(ids),
                "backend": args.arm,
                "target_tokens": answer,
                "top1": tops,
                "nll": nll,
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
