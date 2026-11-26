"""Ragged expert dispatch with bounded tile loads."""

from functools import lru_cache

import mlx.core as mx

from .inkling_adaptive_tiles import adaptive
from .inkling_group_routes import _hist, _scatter
from .inkling_partial_steel import prefix, tile_body
from .inkling_prefill_moe import PrefillMoE
from .inkling_top8 import top8
from .shaders import load_shader


@lru_cache(None)
def program(mode, split):
    layout = prefix + (load_shader("expert_split_tail.metal") if split else "")
    return adaptive(
        tile_body(mode, bounded=True),
        name=f"inkling_bounded_{mode}_{int(split)}",
        tile_prefix=layout,
    )


class RaggedMoE(PrefillMoE):
    split = False
    program = staticmethod(program)

    @staticmethod
    def auxiliary():
        return mx.array([0], mx.uint32)

    def __call__(self, x, *, return_routed=False):
        if x.shape[1] < 64:
            return super().__call__(x, return_routed=return_routed)
        ids, coeff = top8(x.astype(mx.float32) @ self.router.T, self.bias)
        n = ids.size
        b = (n + 255) // 256
        opts = [("N", n), ("B", b)]
        kw = {"template": opts, "threadgroup": (256, 1, 1)}
        counts = _hist(
            inputs=[ids],
            grid=(256 * b, 1, 1),
            output_shapes=[(128 * b,)],
            output_dtypes=[mx.uint32],
            **kw,
        )[0]
        ends = mx.cumsum(counts)
        order, inv, _ = _scatter(
            inputs=[ids, ends, counts],
            grid=(256 * b, 128, 1),
            output_shapes=[(n,)] * 3,
            output_dtypes=[mx.uint32] * 3,
            **kw,
        )
        starts = mx.concatenate([mx.zeros((1,), ends.dtype), ends[b - 1 :: b]])
        count = starts[1:] - starts[:-1]
        ts = (count + 63) // 64
        if self.split:
            tail = count % 64
            ts = ts + (
                ((tail > 32) & (tail <= 48)) | ((tail > 16) & (tail <= 24))
            ).astype(ts.dtype)
        tile_ends = mx.cumsum(ts)
        base = tile_ends - ts
        nt = (n + 63) // 64 + 127 + (128 if self.split else 0)
        experts = mx.searchsorted(
            tile_ends, mx.arange(nt, dtype=tile_ends.dtype), side="right"
        )

        def project(a, params, act):
            w, s, g = params
            k = a.shape[-1]
            width = w.shape[1]
            return self.program(self.mode, self.split)(
                inputs=[
                    a,
                    w,
                    s,
                    g if g is not None else mx.ones((128,), mx.float32),
                    starts,
                    base,
                    experts,
                    self.auxiliary(),
                ],
                template=[
                    ("K", k),
                    ("N", width),
                    ("E", 128),
                    ("BM", 64),
                    ("BN", 64),
                    ("BK", 32),
                    ("WM", 2),
                    ("WN", 2),
                    ("ACT", act),
                    ("CAP", 0),
                    ("HOT", 0),
                ],
                grid=(128 * width // 64, nt, 1),
                threadgroup=(128, 1, 1),
                output_shapes=[(n, 1, width // 2 if act else width)],
                output_dtypes=[mx.bfloat16],
            )[0]

        routed = x.reshape(-1, 1, x.shape[-1])[order // 8]
        out = project(project(routed, self.expand, True), self.contract, False).squeeze(
            -2
        )
        if return_routed:
            return out, inv, coeff
        return (
            (
                out[inv].reshape(*ids.shape, x.shape[-1]).astype(mx.float32)
                * coeff[..., None]
            )
            .sum(axis=-2)
            .astype(x.dtype)
        )
