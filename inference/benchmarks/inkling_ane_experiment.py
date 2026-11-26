"""Experimental dynamic-weight FFN on ANE, with other experts on GPU. Offline only."""

from functools import lru_cache
import numpy as np
import mlx.core as mx
from dari_engine.engines.inkling.inkling_moe import activate
from dari_engine.engines.inkling.inkling_top8 import top8


@lru_cache(maxsize=4)
def ane_model(rows, d, h):
    import coremltools as ct
    from coremltools.converters.mil import Builder as mb
    from coremltools.converters.mil.mil import types

    def spec(r, c):
        return mb.TensorSpec(shape=(1, 1, r, c), dtype=types.fp16)

    @mb.program(
        input_specs=[spec(rows, d), spec(h, d), spec(h, d), spec(d, h)],
        opset_version=ct.target.iOS18,
    )
    def prog(x, gate, up, down):
        a = mb.matmul(x=x, y=gate, transpose_y=True)
        b = mb.matmul(x=x, y=up, transpose_y=True)
        f = mb.tanh(x=mb.mul(x=a, y=np.float16(0.25)))
        u = mb.tanh(x=mb.mul(x=b, y=np.float16(0.04)))
        z = mb.mul(x=mb.mul(x=f, y=mb.sigmoid(x=a)), y=u)
        return mb.matmul(x=mb.mul(x=z, y=np.float16(100)), y=down, transpose_y=True)

    return ct.convert(
        prog,
        convert_to="mlprogram",
        minimum_deployment_target=ct.target.macOS15,
        compute_units=ct.ComputeUnit.CPU_AND_NE,
    )


class Hybrid:
    def __init__(self, base, count=2):
        self.base = base
        self.count = count

    def __call__(self, x, *, return_routed=False):
        moe = self.base
        d = x.shape[-1]
        h = moe.contract[0].shape[-1] * (32 // moe.bits)
        if x.shape[1] < 256 or moe.mode != "nvfp4":
            return moe(x, return_routed=return_routed)
        sel, coef = top8(x.astype(mx.float32) @ moe.router.T, moe.bias)
        flat = sel.flatten()
        order = mx.argsort(flat)
        idx = flat[order]
        inv = mx.argsort(order)
        nexp = moe.expand[0].shape[0]
        bounds = mx.searchsorted(idx, mx.arange(nexp + 1).astype(idx.dtype)).tolist()
        hot = sorted(
            sorted(
                (e for e in range(nexp) if bounds[e + 1] - bounds[e] >= 256),
                key=lambda e: bounds[e + 1] - bounds[e],
                reverse=True,
            )[: self.count]
        )
        flatx = x.reshape(-1, 1, d)[order // 8]

        def dense(params, e):
            w, s, g = params
            return mx.dequantize(
                w[e],
                s[e],
                group_size=16,
                bits=4,
                mode="nvfp4",
                global_scale=g[e],
                dtype=mx.bfloat16,
            ).astype(mx.float16)

        feeds = []
        spans = []
        last = 0
        for e in hot:
            a, b = bounds[e : e + 2]
            rows = 1 << (b - a - 1).bit_length()
            m = ane_model(rows, d, h)
            pair = dense(moe.expand, e)
            down = dense(moe.contract, e)
            v = mx.pad(flatx[a:b, 0].astype(mx.float16), [(0, rows - b + a), (0, 0)])
            feeds.append(
                (
                    a,
                    b,
                    m,
                    dict(
                        x=v,
                        gate=mx.contiguous(pair[::2]),
                        up=mx.contiguous(pair[1::2]),
                        down=down,
                    ),
                )
            )
            if last < a:
                spans.append((last, a))
            last = b
        if last < idx.size:
            spans.append((last, idx.size))
        if feeds:
            mx.eval(*[v for _, _, _, p in feeds for v in p.values()])
            feeds = [
                (a, b, m, {k: np.asarray(v)[None, None] for k, v in p.items()})
                for a, b, m, p in feeds
            ]

        def proj(states, ix, params):
            w, s, g = params
            return mx.gather_qmm(
                states,
                w,
                s,
                rhs_indices=ix,
                sorted_indices=True,
                group_size=moe.group,
                bits=moe.bits,
                mode=moe.mode,
                global_scale=g,
            )

        pieces = []
        for a, b in spans:
            ix = idx[a:b]
            y = proj(activate(proj(flatx[a:b], ix, moe.expand)), ix, moe.contract)
            pieces.append((a, y))
        if feeds:
            mx.async_eval(*[v for _, v in pieces])
            for a, b, m, p in feeds:
                y = next(iter(m.predict(p).values())).reshape(-1, 1, d)
                pieces.append((a, mx.array(y[: b - a]).astype(mx.bfloat16)))
        out = mx.concatenate(
            [v for _, v in sorted(pieces, key=lambda p: p[0])]
        ).squeeze(-2)
        if return_routed:
            return out, inv, coef
        return (
            (out[inv].reshape(*sel.shape, d).astype(mx.float32) * coef[..., None])
            .sum(axis=-2)
            .astype(x.dtype)
        )
