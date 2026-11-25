"""Official Inkling text shards and optimized runtime. List/show never load Metal."""

import json
from pathlib import Path

from huggingface_hub import snapshot_download

FAMILY = "inkling"
ENGINE = "Dari Metal"
WEIGHT_FORMAT = "safetensors"


def max_context(snapshot):
    return json.loads((snapshot / "config.json").read_text())["text_config"][
        "model_max_length"
    ]


def load(snapshot, context_window):
    import mlx.core as mx

    from inkling.runtime import Runtime

    mx.set_cache_limit(512 * 1024**2)
    return Runtime(snapshot, context_window)


def resolve_snapshot(model, install):
    def fetch(patterns):
        return Path(
            snapshot_download(
                model.repository,
                revision=model.revision,
                allow_patterns=patterns,
                local_files_only=not install,
            )
        )

    # The engine only needs the text shards, not auxiliary model heads.
    metadata = [
        "config.json",
        "model.safetensors.index.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "chat_template.jinja",
    ]
    root = fetch(metadata)
    for name in metadata:
        if not (root / name).is_file():
            raise FileNotFoundError(name)
    weights = json.loads((root / "model.safetensors.index.json").read_text())[
        "weight_map"
    ]
    if "model.llm.embed.weight" not in weights:
        raise ValueError("Expected the official Inkling text checkpoint")
    shards = sorted({v for k, v in weights.items() if k.startswith("model.llm.")})
    if install:
        fetch(shards)
    for name in shards:
        if not (root / name).is_file():
            raise FileNotFoundError(name)
    return root
