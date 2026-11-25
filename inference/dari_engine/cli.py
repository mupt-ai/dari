"""Local model management. Only an explicit install or pull can download weights."""

import argparse
import os
from pathlib import Path

from huggingface_hub.errors import LocalEntryNotFoundError

from dari_engine.catalog import DEFAULT_MODEL, MODELS


def main():
    parser = argparse.ArgumentParser(
        prog="dari-inference", description="Serve a Dari-optimized model offline."
    )
    parser.add_argument(
        "action",
        nargs="?",
        default="serve",
        choices=[*MODELS, "install", "serve", "run", "pull", "list", "show"],
    )
    parser.add_argument("model", nargs="?", choices=MODELS)
    parser.add_argument(
        "--snapshot", type=Path, help="Serve an existing local checkpoint"
    )
    parser.add_argument("--port", type=int, default=8081)
    parser.add_argument(
        "--context-window",
        type=int,
        default=os.getenv("DARI_CONTEXT_LENGTH"),
        help="Combined input and output budget (default: model-specific)",
    )
    args = parser.parse_args()
    if args.action in ("run", "pull", "show") and not args.model:
        parser.error(f"{args.action} requires a model name")
    if args.model and args.action not in ("run", "install", "pull", "show"):
        parser.error(f"Unexpected model argument for {args.action}")
    if args.snapshot and args.action in ("install", "pull", "list", "show"):
        parser.error("--snapshot is for serving existing weights")
    if args.action == "list":
        print("NAME")
        for name, model in MODELS.items():
            try:
                model.backend.resolve_snapshot(model, install=False)
            except (LocalEntryNotFoundError, FileNotFoundError):
                continue
            print(name)
        return
    name = args.model or (args.action if args.action in MODELS else DEFAULT_MODEL)
    model = MODELS[name]
    install = args.action in ("install", "pull")
    try:
        snapshot = args.snapshot or model.backend.resolve_snapshot(
            model, install=install
        )
    except (LocalEntryNotFoundError, FileNotFoundError) as exc:
        if install:
            parser.exit(1, f"Installation incomplete: {exc}\n")
        parser.exit(
            1, f"Model not installed: {name}. Run: dari-inference pull {name}\n"
        )
    if install:
        print(f"Ready: {name} at {snapshot}")
    elif args.action == "show":
        print(
            f"Model: {name}\nEngine: {model.backend.ENGINE}\nWeights: {model.repository}@{model.revision}\nModel context limit: {model.backend.max_context(snapshot):,} tokens"
        )
    else:
        from dari_engine.server import serve

        window = (
            model.context_window if args.context_window is None else args.context_window
        )
        serve(name, model, snapshot, args.port, window)


if __name__ == "__main__":
    main()
