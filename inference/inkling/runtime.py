"""Single-request Inkling runtime with prefix reuse across requests."""

import json

import mlx.core as mx
from mlx_lm.utils import load_tokenizer

from inkling.chat_protocol import assistant_events
from inkling.decode_message_gate import GatedModel
from inkling.prefix_cache import PrefixCache


class Runtime:
    def __init__(self, snapshot, context_window):
        self.cache = PrefixCache()
        config = json.loads((snapshot / "config.json").read_text())
        maximum = config["text_config"]["model_max_length"]
        if not 1 <= context_window <= maximum:
            raise SystemExit(
                f"--context-window must be between 1 and {maximum:,} tokens"
            )
        self.model_max_length = maximum
        self.context_window = context_window
        self.softcap = config["text_config"]["final_logit_softcapping"]
        self.tokenizer = load_tokenizer(
            snapshot, eos_token_ids=[config["eos_token_id"]]
        )
        self.model = GatedModel(snapshot)

    def prompt(self, messages, tools):
        ids = self.tokenizer.apply_chat_template(
            messages,
            tools=tools or None,
            return_dict=False,
            tokenize=True,
            add_generation_prompt=False,
            reasoning_effort="low" if tools else "none",
        )
        # With tools, let the model select text or a named invocation.
        return ids + self.tokenizer.encode(
            "<|message_model|>" + ("" if tools else "<|content_text|>"),
            add_special_tokens=False,
        )

    def generate(self, ids, limit, temperature):
        cursor = self.cache.resume(ids)
        self.cached_tokens = len(cursor.tokens)
        for offset in range(self.cached_tokens, len(ids), 1024):
            chunk = ids[offset : offset + 1024]
            cursor.logits = self.model(mx.array([chunk]), cursor.layers)
            mx.eval(cursor.logits)
            cursor.tokens.extend(chunk)
            if 0 < len(ids) - len(cursor.tokens) <= 1024:
                self.cache.block = cursor.checkpoint()
        self.cache.prompt = cursor.checkpoint()
        for _ in range(limit):
            scores = cursor.logits.reshape(-1)
            if temperature:
                scores = mx.tanh(scores.astype(mx.float32) / self.softcap) * (
                    self.softcap / temperature
                )
                token = mx.random.categorical(scores).item()
            else:
                token = mx.argmax(scores).item()
            # Only publish evaluated state. The yielded token itself is not
            # cached until generation resumes and the model consumes it.
            self.cache.tip = cursor
            yield token
            self.cache.tip = None
            cursor.logits = self.model(mx.array([[token]]), cursor.layers)
            cursor.tokens.append(token)

    def events(self, ids, limit, temperature, tool_names):
        return assistant_events(
            self.tokenizer, self.generate(ids, limit, temperature), tool_names, limit
        )

    def encode_raw(self, prompt):
        return self.tokenizer.encode(prompt, add_special_tokens=False)
