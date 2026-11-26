"""Opt-in model regression: speculative decoding keeps the target's state and output."""

import os
import unittest
from pathlib import Path


@unittest.skipUnless(
    os.getenv("INKLING_ENGINE_SNAPSHOT"), "requires local model weights"
)
class Speculative(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import mlx.core as mx

        from dari_engine.engines.inkling.runtime import Runtime

        mx.set_cache_limit(512 * 1024**2)
        cls.runtime = Runtime(
            Path(os.environ["INKLING_ENGINE_SNAPSHOT"]), context_window=50_000
        )

    def test_rewind_matches_a_shorter_forward(self):
        import mlx.core as mx

        from dari_engine.engines.inkling.inkling_model import rewind
        from dari_engine.engines.inkling.prefix_cache import Cursor

        model = self.runtime.model
        # Cross the 1024-token local window so the ring has wrapped.
        prompt = self.runtime.tokenizer.encode("Count: " + " one" * 1100)
        cursor = Cursor([], [{} for _ in range(48)])
        for start in range(0, len(prompt), 1024):
            model(mx.array([prompt[start : start + 1024]]), cursor.layers)
        block = mx.array([[11, 22, 33, 44, 55, 66]])
        # Compare with a batched forward of the kept rows. Batches of different
        # lengths round differently, so bound the difference by how much one
        # row's logits move between the long and the short batch.

        def journal():
            return [{"fir": {}} for _ in range(48)]

        for keep in (2, 4, 6):
            long = model(block, cursor.checkpoint().layers, journal=journal())
            short = model(
                block[:, :keep], cursor.checkpoint().layers, journal=journal()
            )
            noise = mx.abs(long[0, keep - 1] - short[0, keep - 1]).max().item()
            spec = cursor.checkpoint()
            record = journal()
            model(block, spec.layers, journal=record)
            rewind(spec.layers, record, keep)
            plain = cursor.checkpoint()
            model(block[:, :keep], plain.layers, journal=journal())
            self.assertEqual(spec.layers[0]["offset"], len(prompt) + keep)
            probe = mx.array([[77, 88]])
            got = model(probe, spec.layers)
            want = model(probe, plain.layers)
            self.assertEqual(got.argmax().item(), want.argmax().item())
            self.assertLessEqual(mx.abs(got - want).max().item(), noise + 0.05, keep)

    def test_greedy_output_matches_plain_decoding(self):
        runtime = self.runtime
        ids = runtime.prompt(
            [{"role": "user", "content": "List the first twenty prime numbers."}], []
        )

        def generate(depth):
            runtime.depth = depth
            runtime.cache.tip = runtime.cache.prompt = runtime.cache.block = None
            return list(runtime.generate(ids, 96, 0))

        plain = generate(0)
        runtime.drafted = runtime.accepted = 0
        speculative = generate(7)
        self.assertGreater(runtime.accepted, 0)
        # Batched verification and single-token decode round differently, so
        # allow a late near-tie; the prefix must agree.
        same = next(
            (i for i, (a, b) in enumerate(zip(plain, speculative)) if a != b), 96
        )
        self.assertGreaterEqual(same, 64)

    def test_stopping_mid_block_publishes_a_consistent_tip(self):
        runtime = self.runtime
        runtime.depth = 7
        ids = runtime.prompt([{"role": "user", "content": "Count to forty."}], [])
        runtime.cache.tip = runtime.cache.prompt = runtime.cache.block = None
        stream = runtime.generate(ids, 64, 0)
        out = [next(stream) for _ in range(5)]
        stream.close()
        tip = runtime.cache.tip
        consumed = ids + out[:-1]
        self.assertEqual(tip.tokens, consumed)
        self.assertEqual(tip.draft["offset"], len(consumed))
        self.assertEqual(tip.layers[0]["offset"], len(consumed))
        # Resuming from the tip continues exactly like a cold request.
        follow = ids + out
        warm = list(runtime.generate(follow, 8, 0))
        self.assertEqual(runtime.cached_tokens, len(consumed))
        runtime.cache.tip = runtime.cache.prompt = runtime.cache.block = None
        cold = list(runtime.generate(follow, 8, 0))
        self.assertEqual(warm[:4], cold[:4])

    def test_exact_cache_hit_skips_prefill(self):
        runtime = self.runtime
        runtime.depth = 0
        ids = runtime.tokenizer.encode("Count: " + " one" * 1500)
        runtime.cache.tip = runtime.cache.prompt = runtime.cache.block = None
        cold = list(runtime.generate(ids, 8, 0))
        retry = list(runtime.generate(ids, 8, 0))
        self.assertEqual(runtime.cached_tokens, len(ids))
        self.assertEqual(runtime.cache.prompt.layers[0]["offset"], len(ids))
        self.assertEqual(retry, cold)

    def test_long_prompt_drafts_from_its_final_stretch(self):
        runtime = self.runtime
        runtime.depth = 7
        ids = runtime.tokenizer.encode("Count: " + " one two three" * 3000)
        self.assertGreater(len(ids), runtime.DRAFT_CONTEXT + runtime.CHUNK)
        runtime.cache.tip = runtime.cache.prompt = runtime.cache.block = None
        runtime.drafted = runtime.accepted = 0
        list(runtime.generate(ids, 32, 0))
        tip = runtime.cache.tip
        self.assertEqual(tip.tokens[: len(ids)], ids)
        self.assertEqual(tip.draft["offset"], len(tip.tokens))
        draft = tip.draft
        # The skipped chunks leave the draft context starting at a chunk edge.
        self.assertGreater(draft["base"], 0)
        self.assertEqual(draft["base"] % runtime.CHUNK, 0)
        self.assertGreater(runtime.accepted, 0)


if __name__ == "__main__":
    unittest.main()
