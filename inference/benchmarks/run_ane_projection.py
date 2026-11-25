"""Optional full-model experiment: concurrently split large attention projections."""

import os
import runpy
import sys
from pathlib import Path

if "INKLING_COREML_SITE" in os.environ:
    sys.path.append(os.environ["INKLING_COREML_SITE"])
import coremltools as ct
import mlx.core as mx
import numpy as np
from coremltools.converters.mil import Builder as mb
from coremltools.converters.mil.mil import types
from inkling import inkling_model

base = inkling_model.linear
models = {}
native = os.environ.get("INKLING_ANE_NATIVE") == "1"
if native:
    from _inkling_ane import Layer


def linear(w, name, x):
    if (
        name not in {"self_attn.all_proj", "self_attn.qrgs_proj", "self_attn.o_proj"}
        or x.shape[1] < 512
    ):
        return base(w, name, x)
    weight, scale, bias = (w[name + "." + s] for s in ("weight", "scales", "biases"))
    n = weight.shape[0]
    d = x.shape[-1]
    l = x.shape[1]
    rows = 1024
    take = min(rows, l)
    split = n // 2 // 128 * 128
    key = (id(w), name)
    if key not in models:
        decoded = np.asarray(
            mx.dequantize(
                weight[:split], scale[:split], bias[:split], group_size=64, bits=4
            ).astype(mx.float16)
        )

        @mb.program(
            input_specs=[mb.TensorSpec(shape=(1, 1, rows, d), dtype=types.fp16)],
            opset_version=ct.target.iOS18,
        )
        def prog(x):
            return mb.linear(x=x, weight=decoded)

        models[key] = ct.convert(
            prog,
            convert_to="mlprogram",
            minimum_deployment_target=ct.target.macOS15,
            compute_units=ct.ComputeUnit.CPU_AND_NE,
        )
        if native:
            models[key] = Layer(models[key].get_compiled_model_path())
    padded = mx.contiguous(
        mx.pad(x[:, :take].astype(mx.float16), [(0, 0), (0, rows - take), (0, 0)])
    )
    other = mx.quantized_matmul(
        x[:, :take], weight[split:], scale[split:], bias[split:], group_size=64, bits=4
    )
    if native:
        first = models[key](padded)[:, :take]
    else:
        host = np.asarray(padded)[None]
        mx.async_eval(other)
        result = next(iter(models[key].predict({"x": host}).values()))
        first = mx.array(result[:, 0, :take])
    out = mx.concatenate([first.astype(x.dtype), other], axis=-1)
    return (
        mx.concatenate([out, linear(w, name, x[:, take:])], axis=1) if l > take else out
    )


if __name__ == "__main__":
    h = sys.argv.pop(1)
    if (
        h not in {"bench_independent", "eval_teacher", "eval_unseen"}
        or sys.argv[1] != "ours"
    ):
        raise SystemExit("Expected harness and ours arm.")
    inkling_model.linear = linear
    runpy.run_path(str(Path(__file__).with_name(h + ".py")), run_name="__main__")
