"""One real routed expansion with GPU/ANE concurrent work, including bridge costs.

Standalone probe: compiled static expert weights are prepared outside timing. It
is not a model benchmark and does not model the residency cost of all experts.
"""

import os
import sys
from statistics import median
from time import perf_counter
import numpy as np
import mlx.core as mx
from benchmarks.bench_expert_real import compute, idx, x, dense, w, s, g, E, K, N

if "INKLING_COREML_SITE" in os.environ:
    sys.path.append(os.environ["INKLING_COREML_SITE"])
import coremltools as ct
from coremltools.converters.mil import Builder as mb
from coremltools.converters.mil.mil import types
from coremltools.models.compute_plan import MLComputePlan


def boundaries():
    return mx.searchsorted(idx, mx.arange(E + 1).astype(idx.dtype)).tolist()


bounds = boundaries()
e = max(range(E), key=lambda i: bounds[i + 1] - bounds[i])
weight = np.array(dense[e])
models = {}
cu = ct.ComputeUnit.CPU_AND_NE
for rows in (256, 512, 1024):

    @mb.program(
        input_specs=[mb.TensorSpec(shape=(1, 1, rows, K), dtype=types.fp16)],
        opset_version=ct.target.iOS18,
    )
    def prog(x):
        return mb.linear(x=x, weight=weight)

    model = ct.convert(
        prog,
        convert_to="mlprogram",
        minimum_deployment_target=ct.target.macOS15,
        compute_units=cu,
    )
    plan = MLComputePlan.load_from_path(
        model.get_compiled_model_path(), compute_units=cu
    )
    ops = plan.model_structure.program.functions["main"].block.operations
    print(
        rows,
        "placement",
        [
            (op.operator_name, type(u.preferred_compute_device).__name__)
            for op in ops
            if (u := plan.get_compute_device_usage_for_mlprogram_operation(op))
        ],
        flush=True,
    )
    models[rows] = model


def split(rows):
    b = boundaries()
    expert = max(range(E), key=lambda i: b[i + 1] - b[i])
    assert expert == e
    lo, hi = b[expert], min(b[expert + 1], b[expert] + rows)

    def q(a, b):
        return mx.gather_qmm(
            x[a:b],
            w,
            s,
            rhs_indices=idx[a:b],
            sorted_indices=True,
            group_size=16,
            bits=4,
            mode="nvfp4",
            global_scale=g,
        )

    # Materialize ANE inputs before submitting GPU work: a subsequent default
    # stream synchronization for numpy conversion would otherwise serialize both.
    host = np.array(
        mx.pad(x[lo:hi, 0].astype(mx.float16), [(0, rows - hi + lo), (0, 0)])
    ).reshape(1, 1, rows, K)
    sides = [(a, q(a, b)) for a, b in ((0, lo), (hi, x.shape[0])) if a < b]
    mx.async_eval(*[v for _, v in sides])
    y = next(iter(models[rows].predict({"x": host}).values()))
    middle = mx.array(y.reshape(rows, 1, N)[: hi - lo]).astype(mx.bfloat16)
    return mx.concatenate(
        [v for _, v in sorted(sides + [(lo, middle)], key=lambda p: p[0])]
    )


ref = compute("packed")
mx.eval(ref)
times = {a: [] for a in (0, 256, 512, 1024)}
for r in range(8):
    for a in list(times)[r % 4 :] + list(times)[: r % 4]:
        t = perf_counter()
        y = split(a) if a else compute("packed")
        mx.eval(y)
        dt = (perf_counter() - t) * 1000
        if r > 1:
            times[a].append(dt)
        if not r:
            print(
                "rows",
                a,
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
