"""Independent Mini prelude block 0, batch one, with per-request local state."""

import math
import mlx.core as mx
from .inkling_moe import InklingMoE


def rms(x, w=None):
    return mx.fast.rms_norm(x, w, 1e-6)


@mx.compile
def clip(x, scale, bound):
    y = x.astype(mx.float32) * scale
    return (
        y
        * mx.minimum(
            1.0, bound / (mx.sqrt(mx.sum(y * y, axis=-1, keepdims=True)) + 1e-6)
        )
    ).astype(x.dtype)


class PreludeBlock:
    def __init__(self, tensors):
        prefix = "model.language_model.layers.0."
        self.w = {
            k[len(prefix) :]: v for k, v in tensors.items() if k.startswith(prefix)
        }
        self.moe = InklingMoE(tensors, 0)
        names = ("q_proj", "k_proj", "v_proj", "r_proj", "gate_proj", "sink_proj")
        self.packed = tuple(
            mx.concatenate([self.w["self_attn." + n + "." + s] for n in names])
            for s in ("weight", "scales", "biases")
        )
        mx.eval(*self.packed)

    def __call__(self, x, state):
        w = self.w

        def linear(name, a):
            p = "self_attn." + name
            return mx.quantized_matmul(
                a,
                w[p + ".weight"],
                w[p + ".scales"],
                w[p + ".biases"],
                group_size=64,
                bits=4,
            )

        def conv(name, a):
            weight = w[name + ".conv1d.weight"]
            history = state.get(name)
            if history is None:
                history = mx.zeros((1, 3, a.shape[-1]), a.dtype)
            window = mx.concatenate([history, a], axis=1)
            state[name] = mx.contiguous(window[:, -3:])
            y = mx.conv1d(window.astype(weight.dtype), weight, groups=a.shape[-1])
            return (
                (y.astype(mx.float32) + a.astype(mx.float32)) / math.sqrt(5)
            ).astype(a.dtype)

        a = rms(x, w["input_layernorm.weight"]).astype(x.dtype)
        L = a.shape[1]
        qp, kp, vp, rp, gate, sinks = mx.split(
            mx.quantized_matmul(a, *self.packed, group_size=64, bits=4),
            [3072, 4096, 5120, 5504, 8576],
            axis=-1,
        )
        q = clip(
            qp.reshape(1, L, 24, 128), w["self_attn.q_l2_clip.scale"], math.sqrt(512)
        )
        k = clip(
            conv("self_attn.k_sconv", kp).reshape(1, L, 8, 128), 1.0, math.sqrt(512)
        )
        v = rms(
            conv("self_attn.v_sconv", vp).reshape(1, L, 8, 128).astype(mx.float32)
        ).astype(x.dtype)
        r = clip(rp.reshape(1, L, 24, 16), w["self_attn.rel_l2_clip.scale"], 8.0)
        bias = r @ w["self_attn.rel_logits_proj.proj"].astype(r.dtype)
        k, v = k.transpose(0, 2, 1, 3), v.transpose(0, 2, 1, 3)
        if "kv" in state:
            k, v = [
                mx.concatenate([past, new], axis=2)
                for past, new in zip(state["kv"], (k, v))
            ]
        state["kv"] = (mx.contiguous(k[:, :, -1023:]), mx.contiguous(v[:, :, -1023:]))
        d = mx.arange(L)[:, None] + k.shape[2] - L - mx.arange(k.shape[2])[None, :]
        mask = mx.take_along_axis(
            bias.transpose(0, 2, 1, 3), mx.clip(d, 0, 1023)[None, None], axis=-1
        )
        mask = mx.where((d >= 0) & (d < 1024), mask, -mx.inf)
        # Sink logits vary by query. Append a zero-valued virtual key rather
        # than using SDPA's per-head constant sink parameter.
        head_sinks = None
        if L == 1:
            head_sinks = sinks[0, 0]
        else:
            mask = mx.concatenate([mask, sinks.transpose(0, 2, 1)[..., None]], axis=-1)
            k, v = [
                mx.concatenate([z, mx.zeros_like(z[:, :, :1])], axis=2) for z in (k, v)
            ]
        h = (
            mx.fast.scaled_dot_product_attention(
                q.transpose(0, 2, 1, 3),
                k,
                v,
                scale=128**-0.5,
                mask=mask,
                sinks=head_sinks,
            )
            .transpose(0, 2, 1, 3)
            .reshape(1, L, -1)
        )
        h = linear(
            "o_proj",
            (h.astype(mx.float32) * mx.sigmoid(gate.astype(mx.float32))).astype(
                x.dtype
            ),
        )
        residual = conv("post_attention_convolution", h).astype(mx.float32)
        bank = rms(x.astype(mx.float32))
        rows = mx.stack([bank, rms(residual)], axis=-2)
        weights = mx.softmax((rows @ w["mlp_input.query"]) / math.sqrt(2304), axis=-1)
        mlp_input = rms(
            (rows * weights[..., None]).sum(axis=-2),
            w["post_attention_layernorm.weight"],
        ).astype(x.dtype)
        return (
            residual
            + conv("post_mlp_convolution", self.moe(mlp_input)).astype(mx.float32)
        ).astype(x.dtype), bank[None]
