"""Inkling 2 Mini sparse FFN. Input: RMS-normalized [batch, time, 2304].

Consumes the pinned MLX checkpoint tensors, not instantiated MLX-LM layers.
This module is under development and not yet used by the serving runtime.
"""

import mlx.core as mx

from .inkling_group_routes import group_routes
from .inkling_top8 import top8


@mx.compile
def activate(pair):
    gate, up = pair[..., ::2].astype(mx.float32), pair[..., 1::2].astype(mx.float32)
    return (
        (4 * mx.tanh(gate / 4) * mx.sigmoid(gate)) * (25 * mx.tanh(up / 25))
    ).astype(pair.dtype)


class InklingMoE:
    def __init__(self, tensors, layer):
        prefix = f"model.language_model.layers.{layer}.mlp."
        self.router = tensors[prefix + "gate.weight"]
        self.bias = tensors[prefix + "gate.e_score_correction_bias"]
        self.bits, self.group, self.mode = (
            (4, 16, "nvfp4") if layer < 20 else (8, 32, "mxfp8")
        )

        def projection(name):
            key = prefix + "experts." + name + "."
            return (
                tensors[key + "weight"],
                tensors[key + "scales"],
                tensors.get(key + "global_scale"),
            )

        self.expand = projection("gate_up_proj")
        self.contract = projection("down_proj")

    def __call__(self, x, *, return_routed=False):
        selected, coefficients = top8(x.astype(mx.float32) @ self.router.T, self.bias)

        grouped = selected.size >= 64
        inputs = x[..., None, None, :]
        indices = selected
        if grouped:
            order, inverse, indices = group_routes(selected)
            inputs = x.reshape(-1, 1, x.shape[-1])[order // 8]

        def project(states, params):
            weights, scales, global_scale = params
            return mx.gather_qmm(
                states,
                weights,
                scales,
                rhs_indices=indices,
                sorted_indices=grouped,
                group_size=self.group,
                bits=self.bits,
                mode=self.mode,
                global_scale=global_scale,
            )

        activation = activate(project(inputs, self.expand))
        out = project(activation, self.contract).squeeze(-2)
        if return_routed and not grouped:
            return out, None, coefficients
        if grouped:
            if return_routed:
                return out, inverse, coefficients
            out = out[inverse].reshape(*selected.shape, x.shape[-1])
        return (
            (out.astype(mx.float32) * coefficients[..., None])
            .sum(axis=-2)
            .astype(x.dtype)
        )
