"""Single-request Inkling runtime with prefix reuse across requests."""

import json
import time
from itertools import pairwise

import mlx.core as mx
from mlx_lm.utils import load_tokenizer

from inkling.chat_protocol import assistant_events
from inkling.decode_message_gate import GatedModel
from inkling.draft import Draft
from inkling.inkling_model import rewind
from inkling.prefix_cache import Cursor, PrefixCache
from inkling.speculation import Depth


class Runtime:
    CHUNK = 2048  # Prompt tokens per prefill forward.
    BLOCK = 1024  # Most prompt tokens after the last prefix checkpoint.
    # The draft head sees about this many trailing prompt tokens; earlier
    # chunks skip the target's full final layer that its context needs.
    DRAFT_CONTEXT = 4096

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
        self.draft = Draft(snapshot, self.model)
        self.depth = None  # Fixed draft depth, or None to adapt.
        self.depths = Depth(Draft.BLOCK - 1)
        self.warm()

    def warm(self):
        """Compile every block shape now, so first-use compiles never skew the
        depth costs or a client's first response."""
        cursor = Cursor([], [{} for _ in range(48)])
        _, features = self.model(
            mx.array([list(range(1000, 1016))]), cursor.layers, taps=True
        )
        self.draft.extend(cursor.draft, features)
        for rows in range(1, Draft.BLOCK + 1):
            state = cursor.checkpoint()
            journal = [{"fir": {}} for _ in state.layers] if rows > 1 else None
            ids = mx.array([list(range(2000, 2000 + rows))])
            out = self.model(ids, state.layers, taps=True, journal=journal)
            if rows > 1:
                out = out, self.draft.propose(cursor.draft, 2000, rows - 1)[0]
            mx.eval(out)
        self.drafted = self.accepted = 0

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

    def sample(self, logits, temperature):
        """Sample each row of *logits*; also return their distributions."""
        if not temperature:
            return mx.argmax(logits, axis=-1), None
        scores = mx.tanh(logits.astype(mx.float32) / self.softcap) * (
            self.softcap / temperature
        )
        return mx.random.categorical(scores), mx.softmax(scores, axis=-1)

    def generate(self, ids, limit, temperature):
        cursor = self.cache.resume(ids)
        self.cached_tokens = len(cursor.tokens)
        # Large chunks prefill faster, but the last one stays within a block so
        # an edit near the end of the prompt can resume from the checkpoint.
        bounds = []
        if self.cached_tokens < len(ids):
            tail = len(ids) - (len(ids) - self.cached_tokens - 1) % self.BLOCK - 1
            bounds = [*range(self.cached_tokens, tail, self.CHUNK), tail, len(ids)]
        for offset, end in pairwise(bounds):
            if offset >= end:
                continue
            chunk = ids[offset:end]
            if len(ids) - offset > self.DRAFT_CONTEXT:
                cursor.logits = self.model(mx.array([chunk]), cursor.layers)
                self.draft.skip(cursor.draft, len(chunk))
                mx.eval(cursor.logits)
            else:
                cursor.logits, features = self.model(
                    mx.array([chunk]), cursor.layers, taps=True
                )
                self.draft.extend(cursor.draft, features)
                mx.eval(cursor.logits, cursor.draft["kv"], cursor.draft["feature"])
            cursor.tokens.extend(chunk)
            if 0 < len(ids) - len(cursor.tokens) <= self.BLOCK:
                self.cache.block = cursor.checkpoint()
        self.cache.prompt = cursor.checkpoint()
        token = self.sample(cursor.logits[0, -1], temperature)[0].item()
        produced, rounds, proposal = 0, [], None
        while produced < limit:
            # Only publish evaluated state. The yielded token itself is not
            # cached until generation resumes and the model consumes it.
            self.cache.tip = cursor
            yield token
            self.cache.tip = None
            produced += 1
            if produced == limit:
                self.cache.tip = cursor
                return
            depth, drafted, q = proposal or self.plan(
                cursor, token, limit - produced, temperature, rounds
            )
            proposal = None
            if not depth:
                logits, features = self.model(
                    mx.array([[token]]), cursor.layers, taps=True
                )
                self.draft.extend(cursor.draft, features)
                cursor.tokens.append(token)
                cursor.logits = logits
                token = self.sample(logits[0, -1], temperature)[0].item()
                continue
            # Verify the drafted block in one forward, then keep the agreed
            # prefix and the target's next token.
            block = mx.concatenate([mx.array([token]), drafted])
            journal = [{"fir": {}} for _ in cursor.layers]
            logits, features = self.model(
                block[None], cursor.layers, taps=True, journal=journal
            )
            accepted, token = self.verify(logits[0], drafted, q, temperature)
            block = block.tolist()
            self.drafted += depth
            self.accepted += accepted
            rounds[-1][1] = accepted
            # Settle and start drafting the next round before handing out this
            # round's tokens, so the GPU works while the client consumes them.
            undo = dict(cursor.draft), len(cursor.tokens)
            self.settle(cursor, journal, block, logits, features, accepted + 1)
            if produced + accepted + 1 < limit:
                proposal = self.plan(
                    cursor, token, limit - produced - accepted - 1, temperature, rounds
                )
            for i in range(1, accepted + 1):
                try:
                    yield block[i]
                except GeneratorExit:
                    # Keep only what precedes the token the client stopped at.
                    cursor.draft.clear()
                    cursor.draft.update(undo[0])
                    del cursor.tokens[undo[1] :]
                    self.settle(cursor, journal, block, logits, features, i)
                    self.cache.tip = cursor
                    raise
                produced += 1
        self.cache.tip = cursor

    def plan(self, cursor, token, budget, temperature, rounds):
        """Choose this round's depth and start drafting it on the GPU.

        *rounds* holds [depth, accepted, start] per round of this request; the
        first round also pays for copying the prompt checkpoint on first
        write, so it stays out of the depth costs.
        """
        now = time.perf_counter()
        if len(rounds) > 1:
            depth, accepted, start = rounds[-1]
            self.depths.observe(depth, accepted, 1000 * (now - start))
        depth = self.depths.next() if self.depth is None else self.depth
        depth = min(depth, budget)
        rounds.append([depth, 0, now])
        if not depth:
            return 0, None, None
        drafted, q = self.draft.propose(cursor.draft, token, depth, temperature)
        mx.async_eval(drafted)
        return depth, drafted, q

    def settle(self, cursor, journal, block, logits, features, keep):
        """Consume the first *keep* rows of a verified block."""
        rewind(cursor.layers, journal, keep)
        self.draft.extend(cursor.draft, features[:, :keep])
        cursor.tokens.extend(block[:keep])
        cursor.logits = logits[:, keep - 1 : keep]

    def verify(self, logits, drafted, q, temperature):
        """Count the accepted drafts and choose the token after them.

        Greedy decoding accepts a draft equal to the target's argmax. Sampling
        accepts with probability min(1, p/q) and corrects a rejection from the
        normalized excess max(0, p - q), which keeps the target distribution.
        """
        depth = drafted.shape[0]
        choice, p = self.sample(logits, temperature)
        if not temperature:
            choice = choice.tolist()
            drafted = drafted.tolist()
            accepted = 0
            while accepted < depth and choice[accepted] == drafted[accepted]:
                accepted += 1
            return accepted, choice[accepted]
        rows = mx.arange(depth)
        ratio = p[rows, drafted] / q[rows, drafted]
        keep = (mx.random.uniform(shape=(depth,)) < ratio).tolist()
        accepted = keep.index(False) if False in keep else depth
        if accepted == depth:
            return accepted, choice[depth].item()
        excess = mx.maximum(p[accepted] - q[accepted], 0)
        return accepted, mx.random.categorical(mx.log(excess)).item()

    def events(self, ids, limit, temperature, tool_names):
        return assistant_events(
            self.tokenizer, self.generate(ids, limit, temperature), tool_names, limit
        )

    def encode_raw(self, prompt):
        return self.tokenizer.encode(prompt, add_special_tokens=False)
