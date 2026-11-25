"""Load text weights from either the publisher's checkpoint or the MLX conversion."""

import json

import mlx.core as mx

PREFIX = "model.language_model."
ATTENTION = {
    "wq_du": "q_proj",
    "wr_du": "r_proj",
    "wk_dv": "k_proj",
    "wv_dv": "v_proj",
    "wo_ud": "o_proj",
    "gate_attn": "gate_proj",
    "attn_sink_proj": "sink_proj",
}
CONTROLLER = {
    "down_weight": "down_proj.weight",
    "forget_weight": "forget_gate_proj.weight",
    "gain_weight": "message_gate_proj.weight",
}


def layer_weight(name, tensor):
    """Translate a layer-relative key, preserving dense projection precision."""
    parts = name.split(".")
    if parts[0] == "controllers":
        _, gate, field = parts
        gate = "q" if gate == "attn" else gate
        if field != "down_weight":
            tensor = tensor.astype(mx.float32)
        return f"{gate}_message_gate.{CONTROLLER[field]}", tensor
    if parts[0] == "attn":
        parts[0] = "self_attn"
        parts[1] = ATTENTION.get(parts[1], parts[1])
    elif parts[0] in ("attn_sconv", "mlp_sconv"):
        parts[0] = {
            "attn_sconv": "post_attention_convolution",
            "mlp_sconv": "post_mlp_convolution",
        }[parts[0]]
    elif parts[0] in ("attn_norm", "mlp_norm"):
        parts[0] = {
            "attn_norm": "input_layernorm",
            "mlp_norm": "post_attention_layernorm",
        }[parts[0]]
    elif parts[0] in ("q_input_norm", "k_input_norm", "v_input_norm"):
        parts[0] = parts[0].replace("_norm", "_layernorm")
    elif name == "mlp.gate.weight":
        tensor = tensor.astype(mx.float32)
    elif name == "mlp.gate.bias":
        parts[-1] = "e_score_correction_bias"

    if parts[-2].endswith(("sconv", "convolution")):
        if parts[-1] == "weight":
            parts.insert(-1, "conv1d")
            tensor = tensor.swapaxes(1, 2)
        elif parts[-1] == "static_w":
            parts[-1] = "static_weight"
        elif parts[-1] == "weight_proj":
            parts.append("weight")
    return ".".join(parts), tensor


def official_weights(raw):
    """Map ModelOpt text tensors into the same logical layers as the MLX layout."""
    weights = {}
    for key, tensor in raw.items():
        name = key.removeprefix("model.llm.")
        if name.startswith("layers."):
            _, layer, field = name.split(".", 2)
            target = f"{PREFIX}layers.{layer}."
            if field.startswith("mlp.experts."):
                # Unscaled blocks and their scale bytes are already NVFP4/MXFP8.
                # Reinterpret the packed bytes; do not re-quantize them.
                kind, suffix = field.split(".")[-1].split("_weight", 1)
                projection = {"w13": "gate_up_proj", "w2": "down_proj"}[kind]
                target += f"mlp.experts.{projection}."
                if suffix == "":
                    weights[target + "weight"] = tensor.view(mx.uint32)
                elif suffix == "_scale":
                    weights[target + "scales"] = tensor
                elif suffix == "_amax":
                    denominator = raw[
                        key.removesuffix("_amax") + "_outer_scale_denominator"
                    ]
                    # Restore the per-projection factor for E2M1 × E4M3 block scaling.
                    weights[target + "global_scale"] = tensor.astype(mx.float32) * (
                        (6 * 448) / denominator.astype(mx.float32)
                    )
                elif suffix != "_outer_scale_denominator":
                    raise ValueError(f"Unexpected expert tensor: {key}")
            else:
                field, value = layer_weight(field, tensor)
                weights[target + field] = value
        elif name.startswith("attn_res.attn_queries."):
            # Layer zero has no attention input query.
            layer = int(name.split(".")[-1]) + 1
            weights[f"{PREFIX}layers.{layer}.attention_input.query"] = tensor
        elif name.startswith("attn_res.mlp_queries."):
            layer = int(name.split(".")[-1])
            weights[f"{PREFIX}layers.{layer}.mlp_input.query"] = tensor
        elif not name.startswith("middle_cycle_cross_pass"):
            target = {
                "embed.weight": PREFIX + "embed_tokens.weight",
                "unembed.weight": "lm_head.weight",
                "attn_res.output_query": PREFIX + "final_input.query",
            }.get(name, PREFIX + name)
            weights[target] = tensor

    # The checkpoint splits [Q, MLP] and [K, V]; the block consumes [Q, K, V, MLP].
    q_mlp = raw["model.llm.middle_cycle_cross_pass_queries"].reshape(12, 2, 2304)
    kv = raw["model.llm.middle_cycle_cross_pass_kv_queries"].reshape(12, 2, 2304)
    weights[PREFIX + "message_input.query"] = mx.concatenate(
        [q_mlp[:, :1], kv, q_mlp[:, 1:]], axis=1
    )
    return weights


def load_text_weights(path):
    index = json.loads((path / "model.safetensors.index.json").read_text())[
        "weight_map"
    ]
    official = "model.llm.embed.weight" in index
    prefixes = ("model.llm.",) if official else (PREFIX, "lm_head.")
    shards = {shard for key, shard in index.items() if key.startswith(prefixes)}
    if not shards:
        raise ValueError("Snapshot does not contain recognized Inkling text weights")
    weights = {}
    for shard in sorted(shards):
        weights.update(
            (k, v)
            for k, v in mx.load(str(path / shard)).items()
            if k.startswith(prefixes)
        )
    return official_weights(weights) if official else weights
