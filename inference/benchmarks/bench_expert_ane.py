"""Optional Core ML device-placement and latency probe. No service integration."""

import time
from statistics import median
import numpy as np
import coremltools as ct
from coremltools.converters.mil import Builder as mb
from coremltools.converters.mil.mil import types
from coremltools.models.compute_plan import MLComputePlan
from benchmarks.benchmark_lock import exclusive_gpu

lock = exclusive_gpu()
rng = np.random.default_rng(137)
R = 256
K = N = 2304
x = rng.normal(0, 0.2, (1, 1, R, K)).astype(np.float16)
w = rng.normal(0, 0.02, (1, 1, N, K)).astype(np.float16)
ref = x.astype(np.float32) @ w.astype(np.float32).swapaxes(-1, -2)
for static in (False, True):

    def spec(shape):
        return mb.TensorSpec(shape=shape, dtype=types.fp16)

    if static:

        @mb.program(input_specs=[spec(x.shape)], opset_version=ct.target.iOS18)
        def prog(x):
            return mb.linear(x=x, weight=w.reshape(N, K))
    else:

        @mb.program(
            input_specs=[spec(x.shape), spec(w.shape)], opset_version=ct.target.iOS18
        )
        def prog(x, w):
            return mb.matmul(x=x, y=w, transpose_y=True)

    cu = ct.ComputeUnit.CPU_AND_NE
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
        "placement",
        static,
        [
            (op.operator_name, type(u.preferred_compute_device).__name__)
            for op in ops
            if (u := plan.get_compute_device_usage_for_mlprogram_operation(op))
        ],
        flush=True,
    )
    ts = []
    inputs = {"x": x} if static else {"x": x, "w": w}
    for i in range(9):
        t = time.perf_counter()
        y = next(iter(model.predict(inputs).values()))
        elapsed = (time.perf_counter() - t) * 1000
        if i > 1:
            ts.append(elapsed)
    print(
        "constant weights",
        static,
        "ms",
        median(ts),
        "relative RMS",
        np.linalg.norm(y.astype(np.float32) - ref) / np.linalg.norm(ref),
        flush=True,
    )
