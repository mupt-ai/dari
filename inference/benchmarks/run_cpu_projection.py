"""Optional hybrid: issue part of each substantial affine projection on CPU."""

import sys, runpy
from pathlib import Path
import mlx.core as mx
from dari_engine.engines.inkling import inkling_model

base = inkling_model.linear


def linear(w, name, x):
    if (
        name not in {"self_attn.qrgs_proj", "self_attn.all_proj", "self_attn.o_proj"}
        or x.shape[1] < 256
    ):
        return base(w, name, x)
    weight, scale, bias = (
        w[name + "." + field] for field in ("weight", "scales", "biases")
    )
    n = weight.shape[0]
    part = max(128, n // 4 // 128 * 128)
    key = name + ".cpu_transposed"
    if key not in w:
        w[key] = mx.contiguous(
            mx.dequantize(
                weight[:part], scale[:part], bias[:part], group_size=64, bits=4
            )
            .astype(mx.float16)
            .T
        )
    other = mx.quantized_matmul(
        x, weight[part:], scale[part:], bias[part:], group_size=64, bits=4
    )
    first = mx.matmul(
        x.astype(mx.float16, stream=mx.cpu), w[key], stream=mx.cpu
    ).astype(x.dtype, stream=mx.cpu)
    return mx.concatenate([first, other], axis=-1)


if __name__ == "__main__":
    h = sys.argv.pop(1)
    if (
        h not in {"bench_independent", "eval_teacher", "eval_unseen"}
        or sys.argv[1] != "ours"
    ):
        raise SystemExit("Expected harness and ours arm")
    inkling_model.linear = linear
    runpy.run_path(str(Path(__file__).with_name(h + ".py")), run_name="__main__")
