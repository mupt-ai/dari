"""Opt-in model regression: compare warm predictions with full cold prefills."""

import os
import unittest
from pathlib import Path


@unittest.skipUnless(
    os.getenv("INKLING_ENGINE_SNAPSHOT"), "requires local model weights"
)
class PrefixReuse(unittest.TestCase):
    def test_tool_turn_retry_and_edit(self):
        import mlx.core as mx

        from inkling.runtime import Runtime

        mx.set_cache_limit(512 * 1024**2)
        runtime = Runtime(
            Path(os.environ["INKLING_ENGINE_SNAPSHOT"]), context_window=50_000
        )
        tools = [
            {
                "type": "function",
                "function": {"name": "read", "parameters": {"type": "object"}},
            }
        ]
        messages = [
            {"role": "user", "content": "Record: violet.\n" * 320 + "Read the note."}
        ]
        prompt = runtime.prompt(messages, tools)
        self.assertGreater(len(prompt), 1024)
        messages.extend(
            [
                {
                    "role": "assistant",
                    "tool_calls": [{"function": {"name": "read", "arguments": {}}}],
                },
                {
                    "role": "tool",
                    "name": "read",
                    "content": "The note says violet. What color?",
                },
            ]
        )
        followup = runtime.prompt(messages, tools)
        self.assertEqual(followup[: len(prompt)], prompt)

        def sample(ids, count=3):
            stream = runtime.generate(ids, count, 0)
            try:
                return [next(stream) for _ in range(count)]
            finally:
                stream.close()  # Same boundary as a cancelled or completed response.

        unrelated = runtime.tokenizer.encode(
            "Different prefix", add_special_tokens=False
        )
        cold = sample(followup)
        sample(unrelated)
        initial = sample(prompt)
        self.assertEqual(sample(followup), cold)
        self.assertGreaterEqual(runtime.cached_tokens, len(prompt))
        self.assertEqual(sample(followup), cold)
        self.assertEqual(runtime.cached_tokens, len(followup))
        sample(unrelated)
        self.assertEqual(runtime.cached_tokens, 0)
        self.assertEqual(sample(prompt), initial)
        generated = prompt + initial[:2]
        sample(generated, 1)
        self.assertEqual(runtime.cached_tokens, len(generated))
        edited = prompt[:-3] + unrelated
        warm_edit = sample(edited)
        self.assertGreaterEqual(runtime.cached_tokens, 1024)
        sample(unrelated)
        self.assertEqual(sample(edited), warm_edit)
