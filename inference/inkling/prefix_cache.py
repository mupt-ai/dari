"""Bounded, in-memory prefix checkpoints for a single serialized model server."""

from dataclasses import dataclass, field

import mlx.core as mx


@dataclass
class Cursor:
    tokens: list[int]
    layers: list[dict]
    logits: mx.array | None = None  # Next-token logits after consuming *tokens*.
    draft: dict = field(default_factory=dict)  # Draft head context for *tokens*.

    def checkpoint(self):
        # FIR histories are replaced, but KV buffers use MLX indexed assignment.
        # A distinct MLX view preserves the old value when the cursor writes a slot
        # (including when local attention wraps its ring). A dict copy alone doesn't.
        layers = []
        for layer in self.layers:
            saved = layer.copy()
            if "storage" in saved:
                saved["storage"] = tuple(buffer[:] for buffer in saved["storage"])
            layers.append(saved)
        draft = dict(self.draft)
        if "kv" in draft:
            draft["kv"] = [tuple(z[:] for z in pair) for pair in draft["kv"]]
        return Cursor(self.tokens.copy(), layers, self.logits, draft)


class PrefixCache:
    def __init__(self):
        self.block = self.prompt = self.tip = None

    def resume(self, tokens):
        # Prefer decoded history, fall back to the original prompt (tool calls
        # can be reserialized), then to a block before the end of that prompt.
        for cursor in (self.tip, self.prompt, self.block):
            if cursor is not None and tokens[: len(cursor.tokens)] == cursor.tokens:
                break
        else:
            cursor = Cursor([], [{} for _ in range(48)])
        # Transfer ownership before any model call. A failed forward must never
        # publish a partially advanced cursor or reuse another branch's state.
        if cursor is self.block or not cursor.tokens:
            self.block = None
        self.tip = self.prompt = None
        return cursor
