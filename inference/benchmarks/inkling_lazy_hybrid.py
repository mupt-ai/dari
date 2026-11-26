"""Experimental all-lazy split. ANE handles complete or partial hot expert buckets;
the GPU processes every other routed row. No CPU reads of routing decisions."""

from functools import lru_cache

import mlx.core as mx
from _inkling_ane import Layer

from benchmarks.inkling_ane_experiment import ane_model
from experiments.shaders import load_shader
from dari_engine.engines.inkling.inkling_partial_steel import kernel
from dari_engine.engines.inkling.inkling_top8 import top8
from dari_engine.engines.inkling.shaders import expand_inputs


@lru_cache(maxsize=8)
def native(cap, d, h):
    return Layer(ane_model(cap, d, h).get_compiled_model_path())


@lru_cache(maxsize=4)
def merge_kernel(count):
    names = [f"ane{i}" for i in range(count)]
    return mx.fast.metal_kernel(
        name=f"inkling_merge_hot_{count}",
        input_names=["gpu", "idx", "starts", "hot", *names],
        output_names=["out"],
        source=expand_inputs(load_shader("merge_hot_experts.metal"), names),
    )


class LazyHybrid:
    def __init__(self, moe, count=2, cap=1024):
        self.moe = moe
        self.count = count
        self.cap = cap

    def offload(self, moe, hot, start, flatx, d, h):
        cap, count, n, ane = self.cap, self.count, flatx.shape[0], []
        for j in range(count):
            e = hot[j]
            rows = mx.minimum(start[e] + mx.arange(cap), n - 1)
            v = flatx[rows, 0].astype(mx.float16)

            def dense(params, expert=e):
                w, s, g = params
                return mx.dequantize(
                    w[expert],
                    s[expert],
                    group_size=16,
                    bits=4,
                    mode="nvfp4",
                    global_scale=g[expert],
                    dtype=mx.bfloat16,
                ).astype(mx.float16)

            pair = dense(moe.expand)
            down = dense(moe.contract)
            ane.append(
                native(cap, d, h).predict(
                    [mx.contiguous(z[None]) for z in (down, pair[::2], pair[1::2], v)]
                )
            )
        return ane

    def __call__(self, x, *, return_routed=False):
        moe = self.moe
        l = x.shape[1]
        d = x.shape[-1]
        h = moe.contract[0].shape[-1] * 8
        if l < 512 or moe.mode != "nvfp4":
            return moe(x, return_routed=return_routed)
        cap = self.cap
        count = self.count
        sel, coef = top8(x.astype(mx.float32) @ moe.router.T, moe.bias)
        flat = sel.flatten()
        order = mx.argsort(flat)
        idx = flat[order]
        n = idx.size
        E = moe.expand[0].shape[0]
        start = mx.searchsorted(idx, mx.arange(E + 1).astype(idx.dtype))
        counts = (start[1:] - start[:-1]).astype(mx.int32)
        hot = mx.argsort(-counts)[:count]
        flatx = x.reshape(-1, 1, d)[order // 8]
        ane = []
        ane = self.offload(moe, hot, start, flatx, d, h)
        bm, bn, bk, wm, wn = 32, 64, 32, 2, 2
        tiles = (counts + bm - 1) // bm
        ends = mx.cumsum(tiles)
        base = ends - tiles
        nt = (n + bm - 1) // bm + E - 1
        experts = mx.searchsorted(ends, mx.arange(nt), side="right")

        def project(a, params, act):
            w, s, g = params
            N = w.shape[1]
            K = a.shape[-1]
            a = mx.pad(a, [(0, bm), (0, 0), (0, 0)])
            return kernel(
                inputs=[a, w, s, g, start, base, experts, hot],
                template=[
                    ("K", K),
                    ("N", N),
                    ("E", E),
                    ("BM", bm),
                    ("BN", bn),
                    ("BK", bk),
                    ("WM", wm),
                    ("WN", wn),
                    ("ACT", act),
                    ("CAP", cap),
                    ("HOT", count),
                ],
                grid=(wm * wn * 32 * N // bn, nt, 1),
                threadgroup=(wm * wn * 32, 1, 1),
                output_shapes=[(n, 1, N // 2 if act else N)],
                output_dtypes=[mx.bfloat16],
                init_value=0,
            )[0]

        gpu = project(project(flatx, moe.expand, True), moe.contract, False)
        out = merge_kernel(count)(
            inputs=[gpu, idx, start, hot, *ane],
            template=[("D", d), ("CAP", cap)],
            grid=(n * d, 1, 1),
            threadgroup=(256, 1, 1),
            output_shapes=[(n, d)],
            output_dtypes=[mx.bfloat16],
        )[0]
        inv = mx.argsort(order)
        if return_routed:
            return out, inv, coef
        return (
            (out[inv].reshape(*sel.shape, d).astype(mx.float32) * coef[..., None])
            .sum(axis=-2)
            .astype(x.dtype)
        )
