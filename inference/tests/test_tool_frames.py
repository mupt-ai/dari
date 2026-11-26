"""Real-tokenizer protocol tests (set INKLING_SNAPSHOT to a local snapshot)."""

import json
import os
import unittest
from pathlib import Path

from dari_engine.protocol import InvalidGeneration, prepare
from dari_engine.engines.inkling.chat_protocol import assistant_events


@unittest.skipUnless(
    os.environ.get("INKLING_SNAPSHOT"), "requires local Inkling tokenizer"
)
class ToolFrames(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from mlx_lm.utils import load_tokenizer

        path = Path(os.environ["INKLING_SNAPSHOT"])
        eos = json.loads((path / "config.json").read_text())["eos_token_id"]
        cls.tokenizer = load_tokenizer(path, eos_token_ids=[eos])

    def events(self, native, *, limit=None):
        ids = self.tokenizer.encode(native, add_special_tokens=False)
        return list(assistant_events(self.tokenizer, ids, {"read"}, limit or len(ids)))

    def test_hidden_then_multiple_complete_calls(self):
        native = "<|content_thinking|>private<|end_message|>"
        for path in ["one.py", "two.py"]:
            native += (
                "<|message_model|>read<|content_invoke_tool_json|>"
                + json.dumps({"name": "read", "args": {"path": path}})
                + "<|end_message|>"
            )
        events = self.events(native + "<|content_model_end_sampling|>")
        self.assertEqual(events[-1][1], "tool_calls")
        self.assertFalse(any("content" in delta for delta, _, _ in events))
        calls = events[0][0]["tool_calls"]
        self.assertEqual(
            [json.loads(call["function"]["arguments"]) for call in calls],
            [{"path": "one.py"}, {"path": "two.py"}],
        )
        self.assertNotEqual(calls[0]["id"], calls[1]["id"])
        history = [
            {"role": "assistant", "content": None, "tool_calls": calls},
            {"role": "tool", "tool_call_id": calls[1]["id"], "content": "a result"},
        ]
        normalized, _ = prepare({"messages": history})
        self.assertEqual(normalized[-1]["name"], "read")

    def test_never_dispatch_partial_or_undeclared_call(self):
        prefix = "read<|content_invoke_tool_json|>"
        closed = self.events(prefix + '{"name":"read","args":{}}<|end_message|>')
        self.assertEqual(closed[-1][1], "tool_calls")
        self.assertEqual(closed[0][0]["tool_calls"][0]["function"]["name"], "read")
        for body in ["{", '{"name":"read","args":{}}']:
            events = self.events(prefix + body)
            self.assertEqual(events[-1][1], "length")
            self.assertFalse(any("tool_calls" in delta for delta, _, _ in events))
        for body in ["{", '{"name":"bash","args":{}}']:
            with self.assertRaises(InvalidGeneration):
                self.events(prefix + body + "<|end_message|>")
