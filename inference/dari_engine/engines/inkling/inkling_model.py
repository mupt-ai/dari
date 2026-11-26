"""Single-sequence Inkling Mini text transformer, using only MLX primitives."""

from pathlib import Path

import mlx.core as mx

from .checkpoint import load_text_weights
from .inkling_block import rms
from .inkling_conv import dynamic_fir, fir_history, static_fir
from .inkling_depth import depth
from .inkling_expert_fir import decode_expert_fir, expert_fir
from .inkling_heads import normalize
from .inkling_message import gate_input
from .inkling_norm import rms_cast
from .inkling_prefill import decode_mask, striped
from .inkling_prefill_moe import PrefillMoE


def linear(w, p, x):
    if p + ".scales" in w:
        return mx.quantized_matmul(
            x,
            w[p + ".weight"],
            w[p + ".scales"],
            w[p + ".biases"],
            bits=4,
            group_size=64,
        )
    return x @ w[p + ".weight"].T


def mix(rows, query):
    if query.size <= 3 * 2304:
        return depth(rows, query)
    return depth_mix(mx.stack(rows, axis=-2), query)


@mx.compile
def depth_mix(rows, query):
    scores = (rows @ query.reshape(-1, 2304).T) * (2304**-0.5)
    return mx.softmax(scores, axis=-2).swapaxes(-2, -1) @ rows


@mx.compile
def gate_mix(x, m, f, g):
    return (1 - mx.tanh(f)) * x + mx.tanh(g) * m


@mx.compile
def attention_gate(h, gate):
    return (h.astype(mx.float32) * mx.sigmoid(gate.astype(mx.float32))).astype(h.dtype)


def local_window(past, off, k, v):
    """Chronological keys for new rows, and the 1024-slot ring that keeps them."""
    end = off + k.shape[2]
    if past is not None:
        n = min(off, 1024)
        prev = [z[:, :, :n] for z in past]
        if off > 1024:
            prev = [mx.roll(z, -(off % 1024), axis=2) for z in prev]
        k, v = [mx.concatenate([a, b], axis=2) for a, b in zip(prev, (k, v))]
    keep = min(1024, end)
    ring = [z[:, :, -keep:] for z in (k, v)]
    if end > 1024:
        ring = [mx.roll(z, end % 1024, axis=2) for z in ring]
    ring = tuple(mx.pad(z, [(0, 0), (0, 0), (0, 1024 - keep), (0, 0)]) for z in ring)
    return k, v, ring


def rewind(cache, journal, keep):
    """Keep the first *keep* rows of a journaled forward in every visit's state.

    Global KV rows past the offset are dead and later overwritten. Local ring
    slots get back what the dropped rows replaced, and FIR histories are
    rebuilt from the state before the forward.
    """
    for state, entry in zip(cache, journal, strict=True):
        state["offset"] = entry["offset"] + keep
        for key, (history, z) in entry["fir"].items():
            state[key] = fir_history(history, z[:, :keep])
        if "ring" in entry and keep < entry["ring"][0].size:
            slots, saved = entry["ring"]
            ring = tuple(z[:] for z in state["storage"])
            for z, old in zip(ring, saved):
                z[:, :, slots[keep:]] = old[:, :, keep:]
            state["storage"] = ring


class Model:
    decode_message_mix = None
    project_linear = staticmethod(linear)
    prefill_mix = None
    message_bank_type = None
    local_prefill_heads = None
    prefill_attention = None
    global_prefill_store = None
    long_decode_attention = None
    long_rows_attention = None
    compact_message_bank = False
    expert_class = PrefillMoE

    def __init__(self, path):
        self.w = load_text_weights(Path(path))
        self.layers = [
            {
                k.removeprefix(f"model.language_model.layers.{i}."): v
                for k, v in self.w.items()
                if k.startswith(f"model.language_model.layers.{i}.")
            }
            for i in range(24)
        ]
        for i, w in enumerate(self.layers):
            fields = (
                ("weight", "scales", "biases")
                if "self_attn.q_proj.scales" in w
                else ("weight",)
            )
            for field in fields:
                w["self_attn.qrgs_proj." + field] = mx.concatenate(
                    [
                        w[f"self_attn.{name}_proj.{field}"]
                        for name in ("q", "r", "gate", "sink")
                    ]
                )
                if i % 6 != 5:
                    w["self_attn.all_proj." + field] = mx.concatenate(
                        [
                            w["self_attn.qrgs_proj." + field],
                            w["self_attn.k_proj." + field],
                            w["self_attn.v_proj." + field],
                        ]
                    )
        self.experts = [self.expert_class(self.w, i) for i in range(24)]

    def block(self, i, x, bank, cache, msg, *, last_only=False, journal=None):
        linear = self.project_linear
        w = self.layers[i]
        L = x.shape[1]
        local = i % 6 != 5
        dtype = x.dtype
        fusion = self.prefill_mix if L >= 128 else None
        fuse_local_input = fusion is not None and local and i != 0
        if fuse_local_input:
            prepared = fusion.local_input(
                x,
                bank,
                w["attention_input.query"],
                w["input_layernorm.weight"],
                final=msg is None,
                keep=i % 6 == 0,
            )
            inputs = prepared[0][..., None, :]
            norm = prepared[1] if i % 6 == 0 else None
        else:
            norm = rms(x.astype(mx.float32))
            inputs = (
                mix(bank + [norm], w["attention_input.query"]) if i else x[..., None, :]
            )

        def gate_norm(v, j, name, weight):
            if msg is None:
                return rms_cast(v, weight, dtype)
            p = name + "_message_gate."
            down_dtype = w[p + "down_proj.weight"].dtype
            implicit = fusion is not None and self.message_bank_type is not None
            if implicit:
                pair = msg.gate_input(j, v, down_dtype)
            else:
                m = msg[..., j, :]
                pair = gate_input(v, m, down_dtype)
            z = linear(w, p + "down_proj", pair)
            if L <= 8 and self.decode_message_mix is not None:
                packed = w.get(p + "packed_pair")
                if packed is not None and z.dtype == mx.bfloat16:
                    return rms_cast(
                        self.decode_message_mix(z, packed, v, m), weight, dtype
                    )
            packed = w.get(p + "packed_pair") if implicit else None
            if packed is not None and z.dtype == mx.bfloat16:
                from .packed_message_gate import fused

                return rms_cast(
                    fused(z, packed, v, msg.bank, msg.index * 4 + j), weight, dtype
                )
            z = z.astype(mx.float32)
            f = linear(w, p + "forget_gate_proj", z)
            g = linear(w, p + "message_gate_proj", z)
            if implicit:
                return msg.finish(j, v, f, g, weight, dtype)
            return rms_cast(gate_mix(v, m, f, g), weight, dtype)

        def inp(j, n):
            return gate_norm(
                inputs[..., 0 if local else j, :],
                j,
                n,
                w[("input_layernorm" if local else n + "_input_layernorm") + ".weight"],
            )

        a = prepared[0] if fuse_local_input and msg is None else inp(0, "q")
        b = a if local and msg is None else inp(1, "k")
        c = a if local and msg is None else inp(2, "v")

        def conv(p, z, context=None):
            history = cache.get(p)
            if journal is not None:
                journal["fir"][p] = history, z
            if context is None:
                out, cache[p] = static_fir(z, history, w[p + ".conv1d.weight"])
                return out
            out, cache[p] = dynamic_fir(
                z,
                history,
                w[p + ".static_weight"],
                linear(w, p + ".weight_proj", context),
            )
            return out

        def proj(n, z):
            return linear(w, "self_attn." + n + "_proj", z)

        if local and msg is None:
            q0, r0, gate, sinks, k0, v0 = mx.split(
                proj("all", a), [3072, 3456, 6528, 6552, 7576], axis=-1
            )
        else:
            q0, r0, gate, sinks = mx.split(proj("qrgs", a), [3072, 3456, 6528], axis=-1)
            k0, v0 = proj("k", b), proj("v", c)
        if local and L >= 128 and self.local_prefill_heads is not None:
            q, r, k, v = self.local_prefill_heads(
                q0,
                r0,
                k0,
                v0,
                w["self_attn.q_l2_clip.scale"],
                w["self_attn.rel_l2_clip.scale"],
                cache,
                w,
            )
        else:
            q, r, k, v = normalize(
                q0,
                r0,
                conv("self_attn.k_sconv", k0, None if local else b),
                conv("self_attn.v_sconv", v0, None if local else c),
                w["self_attn.q_l2_clip.scale"],
                w["self_attn.rel_l2_clip.scale"],
            )
        off = cache.get("offset", 0)
        cache["offset"] = off + L
        if journal is not None:
            journal["offset"] = off
        if not local and off + L > 8192:
            tau = (1 + 0.1 * mx.log(mx.maximum((mx.arange(L) + off + 1) / 8192, 1)))[
                None, :, None, None
            ]
            q = (q.astype(mx.float32) * tau).astype(dtype)
            r = (r.astype(mx.float32) * tau).astype(dtype)
        k, v = k.transpose(0, 2, 1, 3), v.transpose(0, 2, 1, 3)
        rows = None
        if journal is not None and local:
            # Attend over the ring as it was plus the block's own rows, then
            # write the rows into their ring slots, keeping what they replace.
            ring = cache.get("storage") or tuple(
                mx.zeros((1, 8, 1024, 128), dtype) for _ in range(2)
            )
            slots = (off + mx.arange(L)) % 1024
            journal["ring"] = slots, tuple(z[:, :, slots] for z in ring)
            rows = k, v
            stored = tuple(z[:] for z in ring)
            for z, new in zip(stored, rows):
                z[:, :, slots] = new
            cache["storage"] = stored
            k, v = ring
        elif L == 1 and "storage" in cache:
            store_k, store_v = cache["storage"]
            slot = off % 1024 if local else off
            if slot == store_k.shape[2]:
                store_k, store_v = [
                    mx.concatenate([t, mx.zeros((1, 8, 256, 128), dtype)], axis=2)
                    for t in (store_k, store_v)
                ]
            store_k[:, :, slot : slot + 1] = k
            store_v[:, :, slot : slot + 1] = v
            cache["storage"] = store_k, store_v
            end = min(off + 1, 1024) if local else off + 1
            k, v = store_k[:, :, :end], store_v[:, :, :end]
        elif not local and self.global_prefill_store is not None:
            k, v, cache["storage"] = self.global_prefill_store(
                cache.get("storage"), k, v, off
            )
            d = mx.arange(L)[:, None] + off - mx.arange(off + L)
        elif local:
            k, v, cache["storage"] = local_window(cache.get("storage"), off, k, v)
            d = mx.arange(L)[:, None] + k.shape[2] - L - mx.arange(k.shape[2])
        else:
            assert journal is None, "rewind needs the paged global store"
            past = cache.get("storage")
            if past is not None:
                prev = [z[:, :, :off] for z in past]
                k, v = [mx.concatenate([a, b], axis=2) for a, b in zip(prev, (k, v))]
            end = off + L
            capacity = ((end + 255) // 256) * 256
            cache["storage"] = tuple(
                mx.pad(z, [(0, 0), (0, 0), (0, capacity - end), (0, 0)]) for z in (k, v)
            )
            d = mx.arange(L)[:, None] + k.shape[2] - L - mx.arange(k.shape[2])
        use_strips = L >= 256
        if last_only and use_strips:
            # The public forward returns only the final logit. All keys, values,
            # and key/value FIR history above must still cover the entire input.
            # Keep whole attention strips containing at least seven trailing rows:
            # four outputs for the MLP FIR, each depending on four attention rows.
            keep = L % 128 or 128
            if keep < 7:
                keep += 128
            q, r, gate, sinks, x = [z[:, -keep:] for z in (q, r, gate, sinks, x)]
            bank = [z[:, -keep:] for z in bank]
            L = keep
        rel = (r @ w["self_attn.rel_logits_proj.proj"].astype(dtype)).transpose(
            0, 2, 1, 3
        )
        if use_strips:
            h = (self.prefill_attention or striped)(q, k, v, rel, sinks, local)
        elif (
            L == 1
            and not local
            and off >= 8192
            and self.long_decode_attention is not None
        ):
            h = self.long_decode_attention(q, k, v, rel, sinks, 256)
        elif journal is not None:
            h = self.long_rows_attention(q, k, v, rel, sinks, rows, off + L)
        else:
            if L == 1:
                mask = decode_mask(rel, off, k.shape[2], local)
            else:
                bias = mx.take_along_axis(rel, mx.clip(d, 0, 1023)[None, None], axis=-1)
                mask = mx.where(
                    d < 0, -mx.inf, mx.where(d < 1024, bias, -mx.inf if local else 0)
                ).astype(dtype)
            s = None
            if L == 1:
                s = sinks[0, 0]
            else:
                mask = mx.concatenate(
                    [mask, sinks.transpose(0, 2, 1)[..., None]], axis=-1
                )
                k, v = [
                    mx.concatenate([z, mx.zeros_like(z[:, :, :1])], axis=2)
                    for z in (k, v)
                ]
            if L > 1 and k.shape[2] <= 17:
                # Single 16-key tile plus the zero-valued sink. Round unnormalized
                # probabilities to fp16 for the value product, not the denominator.
                qg = q.transpose(0, 2, 1, 3).reshape(1, 8, 3, L, 128).astype(mx.float32)
                scores = (
                    qg @ k[:, :, None].swapaxes(-2, -1).astype(mx.float32)
                ) * 128**-0.5
                scores = scores + mask.reshape(1, 8, 3, L, -1).astype(mx.float32)
                prob = mx.exp(scores - scores.max(axis=-1, keepdims=True))
                num = prob.astype(mx.float16).astype(mx.float32) @ v[:, :, None].astype(
                    mx.float32
                )
                h = (
                    (num / prob.sum(axis=-1, keepdims=True))
                    .astype(dtype)
                    .reshape(1, 24, L, 128)
                    .transpose(0, 2, 1, 3)
                    .reshape(1, L, -1)
                )
            else:
                h = (
                    mx.fast.scaled_dot_product_attention(
                        q.transpose(0, 2, 1, 3),
                        k,
                        v,
                        scale=128**-0.5,
                        mask=mask,
                        sinks=s,
                    )
                    .transpose(0, 2, 1, 3)
                    .reshape(1, L, -1)
                )
        z = proj("o", attention_gate(h, gate))
        key = "post_attention_convolution"
        if i % 6 == 0:
            bank = bank + [norm]
        if fusion is not None and not last_only:
            res, h, cache[key] = fusion.post_attention(
                z,
                cache.get(key),
                w[key + ".conv1d.weight"],
                x,
                bank,
                w["mlp_input.query"],
                w["post_attention_layernorm.weight"],
                i % 6 != 0,
                msg is None,
            )
            normalized = (
                h
                if msg is None
                else gate_norm(h, 3, "mlp", w["post_attention_layernorm.weight"])
            )
        else:
            res = conv(key, z).astype(mx.float32)
            if i % 6 != 0:
                res = res + x.astype(mx.float32)
            h = mix(bank + [rms(res)], w["mlp_input.query"])[..., 0, :]
            normalized = gate_norm(h, 3, "mlp", w["post_attention_layernorm.weight"])
        if L == 1:
            key = "post_mlp_convolution"
            fused_decode = getattr(self.experts[i], "decode_with_fir", None)
            if fused_decode is not None and self.experts[i].mode == "nvfp4":
                y, cache[key] = fused_decode(
                    normalized, cache.get(key), w[key + ".conv1d.weight"], res
                )
                return y, bank
            out, _, coeff = self.experts[i](normalized, return_routed=True)
            y, cache[key] = decode_expert_fir(
                out, coeff, cache.get(key), w[key + ".conv1d.weight"], res
            )
            return y, bank
        if L >= 8 and journal is None:
            routed = self.experts[i](normalized, return_routed=True)
            key = "post_mlp_convolution"
            y, cache[key] = expert_fir(
                *routed, cache.get(key), w[key + ".conv1d.weight"], res
            )
            return y, bank
        h = self.experts[i](normalized)
        return (res + conv("post_mlp_convolution", h)).astype(dtype), bank

    def embed(self, ids):
        e = "model.language_model.embed_tokens."
        x = self.w[e + "weight"][ids]
        if e + "scales" in self.w:
            x = mx.dequantize(
                x,
                self.w[e + "scales"][ids],
                self.w[e + "biases"][ids],
                bits=4,
                group_size=64,
            )
        return rms(x, self.w["model.language_model.embed_norm.weight"])

    def __call__(self, ids, cache, *, taps=False, journal=None):
        """Logits for the last row, or for every row of a journaled forward.

        A journal (one dict per visit, see ``rewind``) records what is needed to
        keep only a prefix of the rows afterwards. With ``taps``, also return
        the draft head's features for every row: the residual entering visits
        5, 23 and 41, then the normalized final hidden state.
        """
        p = "model.language_model."
        assert journal is None or ids.shape[1] <= 8, (
            "journals cover verification blocks"
        )
        x = self.embed(ids)
        features = []
        visit = 0

        def run(i, x, bank, msg, **kw):
            nonlocal visit
            if taps and visit in (5, 23, 41):
                features.append(x)
            entry = None if journal is None else journal[visit]
            out = self.block(i, x, bank, cache[visit], msg, journal=entry, **kw)
            visit += 1
            return out

        bank = []
        for i in range(6):
            x, bank = run(i, x, bank, None)
        seed = x, bank
        messages = None
        for turn in range(3):
            if turn:
                messages = bank[len(seed[1]) + 1 :] + [rms(x.astype(mx.float32))]
                if self.compact_message_bank and x.shape[1] >= 128:
                    from .inkling_message_bank import MessageBank

                    messages = (self.message_bank_type or MessageBank)(
                        messages, self.w[p + "message_input.query"]
                    )
                else:
                    messages = mix(messages, self.w[p + "message_input.query"]).reshape(
                        1, x.shape[1], 12, 4, 2304
                    )
                x, bank = seed
            for i in range(6, 18):
                msg = (
                    None
                    if messages is None
                    else (
                        messages.group(i - 6)
                        if self.compact_message_bank and x.shape[1] >= 128
                        else messages[:, :, i - 6]
                    )
                )
                x, bank = run(i, x, bank, msg)
        for i in range(18, 23):
            x, bank = run(i, x, bank, None)
        every = taps or journal is not None
        x, bank = run(23, x, bank, None, last_only=not every)
        h = mix(bank + [rms(x.astype(mx.float32))], self.w[p + "final_input.query"])[
            ..., 0, :
        ]
        h = rms(h, self.w[p + "norm.weight"]).astype(x.dtype)
        logits = linear(self.w, "lm_head", h if journal is not None else h[:, -1:])
        logits = logits[..., :200058]
        if taps:
            return logits, mx.concatenate([*features, h], axis=-1)
        return logits
