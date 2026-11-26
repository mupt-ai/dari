"""Share packed backing tensors across attention projection consumers."""

PARTS = ("q", "r", "gate", "sink")
FIELDS = ("weight", "scales", "biases")


def compact(model):
    import mlx.core as mx

    for i, w in enumerate(model.layers):
        prefix = f"model.language_model.layers.{i}."
        for field in FIELDS:
            if "self_attn.q_proj." + field not in w:
                continue

            def key(name, field=field):
                return f"self_attn.{name}_proj.{field}"

            parts = list(PARTS) if i % 6 == 5 else [*PARTS, "k", "v"]
            width = [w[key(p)].shape[0] for p in parts]
            # Keep the same packed byte rows and quantizer metadata in the same
            # order. Axis-zero slices do not introduce strides within a row.
            packed = w[key("qrgs" if i % 6 == 5 else "all")]
            mx.eval(packed)
            for p in parts:
                del w[key(p)], model.w[prefix + key(p)]
            if i % 6 != 5:
                end = sum(width[:4])
                w[key("qrgs")] = packed[:end]
                w[key("k")] = packed[end : end + width[4]]
                w[key("v")] = packed[end + width[4] :]
