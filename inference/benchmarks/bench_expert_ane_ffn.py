"""Measure full, real-routed FFN hybrid throughput including sorts and device copies.

Limited to a single layer: constant-weight ANE models compiled up front for the
hot experts here. No full-model speedup or deployment follows from this probe.
"""

import os, sys, time
from statistics import median
import numpy as np
import mlx.core as mx
from benchmarks.bench_expert_real import states, moe, dense, E, K, N
from dari_engine.engines.inkling.inkling_top8 import top8
from dari_engine.engines.inkling.inkling_moe import activate

if "INKLING_COREML_SITE" in os.environ:
    sys.path.append(os.environ["INKLING_COREML_SITE"])
import coremltools as ct
from coremltools.converters.mil import Builder as mb
from coremltools.converters.mil.mil import types
from coremltools.models.compute_plan import MLComputePlan


def routes():
    sel, coef = top8(states.astype(mx.float32) @ moe.router.T, moe.bias)
    flat = sel.flatten()
    order = mx.argsort(flat)
    idx = flat[order]
    bounds = mx.searchsorted(idx, mx.arange(E + 1).astype(idx.dtype)).tolist()
    return sel, coef, order, idx, bounds


def rank(bounds):
    return sorted(range(E), key=lambda e: bounds[e + 1] - bounds[e], reverse=True)


*_, bounds = routes()
models = {}
cu = ct.ComputeUnit.CPU_AND_NE
for e in rank(bounds)[:6]:
    rows = 1 << (bounds[e + 1] - bounds[e] - 1).bit_length()
    pair = np.array(dense[e])
    w, s, g = moe.contract
    down = np.array(
        mx.dequantize(
            w[e],
            s[e],
            group_size=16,
            bits=4,
            mode="nvfp4",
            global_scale=g[e],
            dtype=mx.bfloat16,
        ).astype(mx.float16)
    )
    gate = np.ascontiguousarray(pair[::2])
    up = np.ascontiguousarray(pair[1::2])
    inv4 = np.float16(0.25)
    inv25 = np.float16(0.04)

    @mb.program(
        input_specs=[mb.TensorSpec(shape=(1, 1, rows, K), dtype=types.fp16)],
        opset_version=ct.target.iOS18,
    )
    def prog(x):
        a = mb.linear(x=x, weight=gate)
        b = mb.linear(x=x, weight=up)
        f = mb.tanh(x=mb.mul(x=a, y=inv4))
        u = mb.tanh(x=mb.mul(x=b, y=inv25))
        z = mb.mul(x=mb.mul(x=f, y=mb.sigmoid(x=a)), y=u)
        return mb.linear(x=mb.mul(x=z, y=np.float16(100)), weight=down)

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
        "expert",
        e,
        "rows",
        rows,
        "placement",
        [
            (op.operator_name, type(u.preferred_compute_device).__name__)
            for op in ops
            if (u := plan.get_compute_device_usage_for_mlprogram_operation(op))
        ],
        flush=True,
    )
    models[e] = (model, rows)


def hybrid(count):
    sel, coef, order, idx, bounds = routes()
    hot = sorted(rank(bounds)[:count])
    flatx = states.reshape(-1, 1, K)[order // 8]
    feeds = []
    spans = []
    last = 0
    for e in hot:
        a, b = bounds[e : e + 2]
        m, rows = models[e]
        assert b - a <= rows
        feeds.append(
            (
                a,
                b,
                m,
                mx.pad(flatx[a:b, 0].astype(mx.float16), [(0, rows - b + a), (0, 0)]),
            )
        )
        if last < a:
            spans.append((last, a))
        last = b
    if last < idx.size:
        spans.append((last, idx.size))
    mx.eval(*[v for _, _, _, v in feeds])
    feeds = [(a, b, m, np.array(v)[None, None]) for a, b, m, v in feeds]

    def proj(x, idx, params):
        w, s, g = params
        return mx.gather_qmm(
            x,
            w,
            s,
            rhs_indices=idx,
            sorted_indices=True,
            group_size=16,
            bits=4,
            mode="nvfp4",
            global_scale=g,
        )

    pieces = []
    for a, b in spans:
        ix = idx[a:b]
        y = proj(activate(proj(flatx[a:b], ix, moe.expand)), ix, moe.contract)
        pieces.append((a, y))
    mx.async_eval(*[v for _, v in pieces])
    for a, b, m, h in feeds:
        y = next(iter(m.predict({"x": h}).values())).reshape(-1, 1, K)
        pieces.append((a, mx.array(y[: b - a]).astype(mx.bfloat16)))
    out = mx.concatenate([v for _, v in sorted(pieces, key=lambda p: p[0])])
    return (
        (
            out.squeeze(-2)[mx.argsort(order)].reshape(*sel.shape, K).astype(mx.float32)
            * coef[..., None]
        )
        .sum(axis=-2)
        .astype(states.dtype)
    )


ref = moe(states)
mx.eval(ref)
times = {a: [] for a in (0, 1, 2, 4, 6)}
for r in range(8):
    for a in list(times)[r % 5 :] + list(times)[: r % 5]:
        t = time.perf_counter()
        y = hybrid(a) if a else moe(states)
        mx.eval(y)
        dt = (time.perf_counter() - t) * 1000
        if r > 1:
            times[a].append(dt)
        if not r:
            print(
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
