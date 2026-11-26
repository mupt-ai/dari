"""Inkling's official block draft head (``mtp.safetensors``) for speculative decoding.

One forward proposes up to seven tokens. The block is the next token plus seven
learned mask rows, which attend bidirectionally to each other and to context
keys built from the target's features at every committed position. A small
recurrent head then corrects each row's vocabulary scores given the token
chosen before it.
"""

import json

import mlx.core as mx

from .chunk_cache import append
from .shared_decode import decode_rows

WIDTH = 2304
HEADS, KV_HEADS, HEAD_DIM = 24, 8, 128
VOCAB = 200058
SOFTCAP = 30.0
NO_BIAS = mx.zeros((1, HEADS, 1, 1), mx.bfloat16)
NO_SINK = mx.full((1, 8, HEADS), -mx.inf, mx.bfloat16)


def norm(x, weight):
    return mx.fast.rms_norm(x.astype(mx.float32), weight, 1e-6).astype(mx.bfloat16)


def heads(x, n, weight=None):
    x = x.reshape(1, x.shape[1], n, HEAD_DIM)
    if weight is not None:
        x = norm(x, weight)
    return x.transpose(0, 2, 1, 3)


def rope(x, offset):
    return mx.fast.rope(
        x, HEAD_DIM, traditional=False, base=1e6, scale=1.0, offset=offset
    )


def dense(w, bits):
    """A projection from [out, in] weights, affine-quantized when *bits* is set."""
    if not bits:
        return (mx.contiguous(w.T),)
    return (*mx.quantize(w, group_size=64, bits=bits), bits)


def apply(x, p):
    if len(p) == 1:
        return x @ p[0]
    w, scales, biases, bits = p
    return mx.quantized_matmul(
        x, w, scales, biases, transpose=True, group_size=64, bits=bits
    )


def residual(x, update):
    # The reference rounds the running residual to BF16 before each addition.
    return x.astype(mx.bfloat16).astype(mx.float32) + update.astype(mx.float32)


class Draft:
    BLOCK = 8
    # Proposals only steer verification, which keeps the target's output, so
    # the draft reads narrower weights: 8-bit projections and folded head, and
    # its own 4-bit copy of the vocabulary head. Zero keeps the BF16 weights.
    BITS, VOCAB_BITS = 8, 4
    CANDIDATES = 64

    def __init__(self, snapshot, target):
        config = json.loads((snapshot / "config.json").read_text())["mtp_config"]
        assert config["block_size"] == self.BLOCK
        assert config["target_layer_ids"] == [5, 23, 41, 48]
        self.target = target
        self.local = set(config["local_layer_ids"])
        self.window = config["sliding_window_size"]
        w = mx.load(str(snapshot / "mtp.safetensors"))
        for k in w:
            if "norm" in k:
                w[k] = w[k].astype(mx.float32)

        def stack(*names):
            return dense(mx.concatenate([w[n] for n in names]), self.BITS)

        self.layers = []
        for i in range(config["num_hidden_layers"]):
            p = f"layers.{i}."
            a = p + "self_attn."
            self.layers.append(
                {
                    "input": w[p + "input_layernorm.weight"],
                    "post": w[p + "post_attention_layernorm.weight"],
                    "context": w[p + "dflare_norm.weight"],
                    "q_norm": w[a + "q_norm.weight"],
                    "k_norm": w[a + "k_norm.weight"],
                    "ck_norm": w[a + "k_norm_ctx.weight"],
                    "qkv": stack(*(a + n + "_proj.weight" for n in "qkv")),
                    "ckv": stack(a + "k_proj_ctx.weight", a + "v_proj_ctx.weight"),
                    "o": stack(a + "o_proj.weight"),
                    "gate_up": stack(
                        p + "mlp.gate_proj.weight", p + "mlp.up_proj.weight"
                    ),
                    "down": stack(p + "mlp.down_proj.weight"),
                }
            )
        # Each draft layer, then the proposal head, reads its own softmax
        # mixture of the four target taps.
        fuse = mx.softmax(w["fuse_weight"].astype(mx.float32), axis=-1)
        self.fuse = fuse.astype(mx.bfloat16).astype(mx.float32)
        self.mask = w["mask_embed"]
        self.norm = w["norm.weight"]
        m = "markov_head."
        self.head_norm = w[m + "dflare_norm.weight"]
        self.previous = w[m + "markov_w1.weight"]
        # The recurrent gates read [state, previous token, row, feature]. Only
        # the first two change between steps, so split the projection.
        recurrent = w[m + "rnn_proj.weight"].astype(mx.float32).T
        state = recurrent.shape[1] // 3
        self.step = recurrent[: 2 * state]
        self.static = recurrent[2 * state :], w[m + "rnn_proj.bias"].astype(mx.float32)
        # Fold the latent projection into the shared vocabulary head once:
        # lm_head(h + hidden_out(z)) = lm_head(h) + z @ folded + folded_bias.
        head = target.w["lm_head.weight"][:VOCAB]
        self.vocabulary = dense(head, self.VOCAB_BITS)
        self.folded = head @ w[m + "hidden_out.weight"]
        self.folded_bias = head @ w[m + "hidden_out.bias"]
        mx.eval(self.__dict__)
        # One compiled graph per depth for the sequential greedy proposals.
        self.greedy = mx.compile(self.chain)

    def recur(self, s, last, context):
        """Advance the recurrent proposal state past *last*; return its latent."""
        previous = self.previous[last].astype(mx.float32)
        gates = mx.concatenate([s, previous], axis=-1) @ self.step + context
        keep, update, latent = mx.split(gates, 3, axis=-1)
        keep = mx.sigmoid(keep)
        s = keep * s + (1 - keep) * mx.tanh(update)
        return s, mx.tanh(latent).astype(mx.bfloat16)

    def chain(self, token, context, base, candidates):
        """Greedy proposals: each row's best candidate given the previous one.

        The softcap is monotonic, so greedy selection skips it.
        """
        s = mx.zeros((1, self.step.shape[0] // 2), mx.float32)
        last, tokens = token, []
        for i in range(base.shape[0]):
            s, latent = self.recur(s, last, context[i])
            scores = base[i] + (latent @ self.folded[candidates[i]].T)[0]
            last = candidates[i, mx.argmax(scores)].reshape(1)
            tokens.append(last)
        return mx.concatenate(tokens)

    def extend(self, state, features):
        """Append context rows for the next committed positions to *state*.

        ``state`` holds the committed position count, each layer's context keys
        (normed and rotated) and values, and the proposal head's latest feature.
        Local layers keep only the trailing window; the global layer pages from
        ``base``, the first position with context rows.
        """
        n = features.shape[1]
        start = state.get("offset", 0)
        base = state.setdefault("base", start)
        mixed = self.fuse @ features.reshape(1, n, 4, WIDTH).astype(mx.float32)
        kv = state.get("kv") or [None] * len(self.layers)
        state["kv"] = kv = list(kv)
        for i, layer in enumerate(self.layers):
            c = norm(mixed[:, :, i], layer["context"])
            k, v = mx.split(apply(c, layer["ckv"]), 2, axis=-1)
            k = rope(heads(k, KV_HEADS, layer["ck_norm"]), start)
            v = heads(v, KV_HEADS)
            if i not in self.local:
                kv[i] = append(kv[i], k, v, start - base)[2]
                continue
            if kv[i] is not None:
                k, v = [mx.concatenate([a, b], axis=2) for a, b in zip(kv[i], (k, v))]
            kv[i] = k[:, :, -self.window :], v[:, :, -self.window :]
        state["feature"] = norm(mixed[:, -1:, 3], self.head_norm)[0]
        state["offset"] = start + n

    def skip(self, state, n):
        """Advance past *n* positions without context rows.

        Long prompts give the draft only their final stretch: its context then
        starts after the skipped positions, which saves the target's full final
        layer over most of the prompt. Earlier rows would leave a gap, so drop them.
        """
        offset = state.get("offset", 0) + n
        state.clear()
        state["offset"] = offset

    def propose(self, state, token, depth, temperature=0.0):
        """Draft *depth* tokens after *token*, the not-yet-consumed next token.

        Returns the drafted ids and, when sampling, each row's distribution.
        """
        position = state["offset"]
        x = mx.concatenate(
            [
                self.target.embed(mx.array([[token]])),
                mx.broadcast_to(self.mask, (1, self.BLOCK - 1, WIDTH)),
            ],
            axis=1,
        )
        for i, layer in enumerate(self.layers):
            h = norm(x, layer["input"])
            q, k, v = mx.split(
                apply(h, layer["qkv"]), [HEADS * HEAD_DIM, 4096], axis=-1
            )
            q = rope(heads(q, HEADS, layer["q_norm"]), position)
            k = rope(heads(k, KV_HEADS, layer["k_norm"]), position)
            v = heads(v, KV_HEADS)
            if i in self.local:
                ck, cv = state["kv"][i]
                k, v = mx.concatenate([ck, k], axis=2), mx.concatenate([cv, v], axis=2)
                a = mx.fast.scaled_dot_product_attention(q, k, v, scale=HEAD_DIM**-0.5)
                a = a.transpose(0, 2, 1, 3).reshape(1, self.BLOCK, HEADS * HEAD_DIM)
            else:
                # Write the block past the committed rows instead of copying the
                # whole context; the next extend overwrites it.
                at = position - state["base"]
                k, v, state["kv"][i] = append(state["kv"][i], k, v, at)
                a = decode_rows(
                    q.transpose(0, 2, 1, 3), k, v, NO_BIAS, NO_SINK, full=True
                )
            x = residual(x, apply(a, layer["o"]))
            g, u = mx.split(apply(norm(x, layer["post"]), layer["gate_up"]), 2, axis=-1)
            x = residual(x, apply(g * mx.sigmoid(g) * u, layer["down"]))
        # Row zero is the anchor; row i predicts the token at its own position.
        rows = norm(x[:, 1 : depth + 1], self.norm)[0]
        base = apply(rows, self.vocabulary) + self.folded_bias
        # The recurrent correction only reorders likely tokens, so score each
        # row's top candidates rather than the whole vocabulary. Verification
        # still decides against the target's full distribution.
        candidates = mx.argpartition(-base, self.CANDIDATES - 1, axis=-1)
        candidates = candidates[:, : self.CANDIDATES]
        base = mx.take_along_axis(base, candidates, axis=-1).astype(mx.float32)
        weight, bias = self.static
        context = mx.concatenate(
            [rows, mx.broadcast_to(state["feature"], rows.shape)], axis=-1
        )
        context = context.astype(mx.float32) @ weight + bias
        if not temperature:
            return self.greedy(mx.array([token]), context, base, candidates), None
        s = mx.zeros((1, self.step.shape[0] // 2), mx.float32)
        last = mx.array([token])
        tokens, probs = [], []
        for i in range(depth):
            s, latent = self.recur(s, last, context[i])
            scores = base[i] + (latent @ self.folded[candidates[i]].T)[0]
            scores = mx.tanh(scores.astype(mx.float32) / SOFTCAP) * (
                SOFTCAP / temperature
            )
            pick = mx.random.categorical(scores)
            p = mx.zeros((VOCAB,), mx.float32)
            probs.append(p.at[candidates[i]].add(mx.softmax(scores)))
            last = candidates[i, pick].reshape(1)
            tokens.append(last)
        return mx.concatenate(tokens), mx.stack(probs) if probs else None
