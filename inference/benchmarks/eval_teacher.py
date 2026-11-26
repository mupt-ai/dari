"""Fixed teacher-forced smoke corpus, independent of the timing prompts."""

import argparse
import json
from pathlib import Path

import mlx.core as mx
from huggingface_hub import snapshot_download
from tokenizers import Tokenizer

from benchmarks.benchmark_lock import exclusive_gpu

CASES = [
    (
        "A baker puts three trays in the oven. Each tray holds eight rolls. How many rolls are there?",
        " There are twenty-four rolls in total.",
    ),
    (
        'def clamp(value, lower, upper):\n    """Return value bounded by lower and upper."""\n',
        "    return max(lower, min(value, upper))",
    ),
    (
        "Translate this sentence into French: The train leaves the station at noon.",
        " Le train quitte la gare à midi.",
    ),
    (
        "While indexing the field notes, the archivist found a folded map. On its back someone had written:",
        " Follow the river until you reach the old bridge.",
    ),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backend", choices=["ours", "reference"])
    parser.add_argument(
        "--snapshot",
        type=Path,
        help="Use this local Inkling checkpoint for either arm.",
    )
    corpus = parser.add_mutually_exclusive_group()
    corpus.add_argument(
        "--cases", type=Path, help="JSON array of [prompt, completion] pairs"
    )
    corpus.add_argument(
        "--long",
        action="store_true",
        help="Exercise long prefill and the local KV wrap boundary.",
    )
    args = parser.parse_args()
    _gpu_lock = exclusive_gpu()
    p = args.snapshot or Path(
        snapshot_download(
            "mlx-community/Inkling-2-Mini-4bit",
            revision="9c0e2960609ba7cb40daf92c6f7bf8ed56e1dd62",
            local_files_only=True,
            allow_patterns=["*.json", "*.jinja", "*.safetensors"],
        )
    )
    tok = Tokenizer.from_file(str(p / "tokenizer.json"))
    if args.backend == "ours":
        from dari_engine.engines.inkling.inkling_model import Model

        m = Model(p)

        def cache():
            return [{} for _ in range(48)]

        def logits(x, c):
            return 30 * mx.tanh(m(x, c).astype(mx.float32) / 30)
    else:
        from mlx_lm import load

        m, _ = load(str(p), lazy=True)
        cache = m.make_cache

        def logits(x, c):
            return m(x, cache=c)[:, -1:]

    cases = json.loads(args.cases.read_text()) if args.cases else CASES
    if args.long:
        # Out-of-benchmark prompts, neither tuned on nor in the warmup corpus.
        cases = [
            (
                "Inventory sheet, aisle C.\n"
                + "\n".join(
                    f"Bin {i}: {7 * i % 23} spare washers and {11 * i % 13} brackets."
                    for i in range(1, 91)
                )
                + "\nWhat is stored in bin 17?",
                " Bin 17 contains four spare washers and five brackets.",
            ),
            (
                "Telemetry records:\n"
                + "\n".join(
                    f"Sample {i}: temperature {17 + i % 4} C, pressure {1000 + i % 7} hPa."
                    for i in range(35)
                )
                + "\nSummarize the range of measured temperatures.",
                " The temperatures range from 17 to 20 degrees Celsius.",
            ),
        ]
    for prompt, completion in cases:
        ids = tok.encode(prompt, add_special_tokens=False).ids
        joined = tok.encode(prompt + completion, add_special_tokens=False).ids
        assert joined[: len(ids)] == ids
        x = mx.array([ids])
        c = cache()
        nll = []
        greedy = []
        for t in joined[len(ids) :]:
            y = logits(x, c).flatten()
            nll.append((mx.logsumexp(y) - y[t]).item())
            greedy.append(mx.argmax(y).item())
            x = mx.array([[t]])
        print(
            json.dumps(
                {
                    "prompt_tokens": len(ids),
                    "prompt": prompt,
                    "backend": args.backend,
                    "nll": nll,
                    "top1": greedy,
                }
            ),
            flush=True,
        )


if __name__ == "__main__":
    main()
