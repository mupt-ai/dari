"""Split a real affine attention projection by output channels across ANE and GPU."""

from statistics import median
from time import perf_counter
import os, sys
import numpy as np
import mlx.core as mx
from benchmarks.bench_expert_real import block, states

if "INKLING_COREML_SITE" in os.environ:
    sys.path.append(os.environ["INKLING_COREML_SITE"])
import coremltools as ct
from coremltools.converters.mil import Builder as mb
from coremltools.converters.mil.mil import types
from coremltools.models.compute_plan import MLComputePlan

x = states
w, s, b = block.packed
n = w.shape[0]
d = x.shape[-1]
l = x.shape[1]
rows = 1 << (l - 1).bit_length()
cu = ct.ComputeUnit.CPU_AND_NE
models = {}
for part in (1024, 2048, 3072, 4096, n):
    weight = np.asarray(
        mx.dequantize(w[:part], s[:part], b[:part], group_size=64, bits=4).astype(
            mx.float16
        )
    )

    @mb.program(
        input_specs=[mb.TensorSpec(shape=(1, 1, rows, d), dtype=types.fp16)],
        opset_version=ct.target.iOS18,
    )
    def prog(x):
        return mb.linear(x=x, weight=weight)

    m = ct.convert(
        prog,
        convert_to="mlprogram",
        minimum_deployment_target=ct.target.macOS15,
        compute_units=cu,
    )
    models[part] = m
    plan = MLComputePlan.load_from_path(m.get_compiled_model_path(), compute_units=cu)
    print(
        part,
        "placement",
        [
            (op.operator_name, type(u.preferred_compute_device).__name__)
            for op in plan.model_structure.program.functions["main"].block.operations
            if (u := plan.get_compute_device_usage_for_mlprogram_operation(op))
        ],
        flush=True,
    )


def project(part):
    if not part:
        return mx.quantized_matmul(x, w, s, b, group_size=64, bits=4)
    host = np.asarray(mx.pad(x.astype(mx.float16), [(0, 0), (0, rows - l), (0, 0)]))[
        None
    ]
    if part < n:
        gpu = mx.quantized_matmul(
            x, w[part:], s[part:], b[part:], group_size=64, bits=4
        )
        mx.async_eval(gpu)
    y = next(iter(models[part].predict({"x": host}).values()))
    out = mx.array(y[:, 0, :l]).astype(x.dtype)
    return mx.concatenate([out, gpu], axis=-1) if part < n else out


ref = project(0)
mx.eval(ref)
times = {k: [] for k in [0, *models]}
for r in range(10):
    for k in list(times)[r % 6 :] + list(times)[: r % 6]:
        t = perf_counter()
        y = project(k)
        mx.eval(y)
        dt = 1000 * (perf_counter() - t)
        if r > 1:
            times[k].append(dt)
        if not r:
            print(
                k,
                "relative RMS",
                (
                    mx.linalg.norm(y.astype(mx.float32) - ref)
                    / mx.linalg.norm(ref.astype(mx.float32))
                ).item(),
                flush=True,
            )
print(
    "median milliseconds",
    {a: round(median(ts), 2) for a, ts in times.items()},
    flush=True,
)
