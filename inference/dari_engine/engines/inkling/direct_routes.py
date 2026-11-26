"""Read routed input tiles from original tokens and scatter contracted rows on store.

This avoids materializing eight copies of the normalized input and restores
logical route order before FIR. No routes change. Input rows remain in token order until loaded into threadgroup memory.
"""

from functools import lru_cache

import mlx.core as mx

from .inkling_adaptive_tiles import adaptive
from .inkling_group_routes import _hist, _scatter
from .inkling_partial_steel import prefix, tile_body
from .inkling_prefill_moe import PrefillMoE
from .inkling_top8 import top8
from .shaders import load_shader


@lru_cache(None)
def program(mode, hoist=False):
    src = tile_body(mode, direct=True, hoist=hoist)
    layout = prefix + load_shader("expert_split_tail.metal")
    return adaptive(
        src,
        name=f"inkling_route_io_{mode}_{int(hoist)}",
        tile_prefix=layout,
        simds=4,
    )


class Direct(PrefillMoE):
    hoist_addresses = False

    @staticmethod
    def plan(ids):
        n = ids.size
        b = (n + 255) // 256
        kw = {"template": [("N", n), ("B", b)], "threadgroup": (256, 1, 1)}
        counts = _hist(
            inputs=[ids],
            grid=(256 * b, 1, 1),
            output_shapes=[(128 * b,)],
            output_dtypes=[mx.uint32],
            **kw,
        )[0]
        ends = mx.cumsum(counts)
        order, _, _ = _scatter(
            inputs=[ids, ends, counts],
            grid=(256 * b, 128, 1),
            output_shapes=[(n,)] * 3,
            output_dtypes=[mx.uint32] * 3,
            **kw,
        )
        starts = mx.concatenate([mx.zeros((1,), ends.dtype), ends[b - 1 :: b]])
        return starts, order

    def __call__(self, x, *, return_routed=False):
        if x.shape[1] < 64:
            return super().__call__(x, return_routed=return_routed)
        ids, coeff = top8(x.astype(mx.float32) @ self.router.T, self.bias)
        n = ids.size
        starts, order = self.plan(ids)
        count = starts[1:] - starts[:-1]
        tail = count % 64
        tiles = (count + 63) // 64 + (
            ((tail > 32) & (tail <= 48)) | ((tail > 16) & (tail <= 24))
        ).astype(count.dtype)
        stop = mx.cumsum(tiles)
        nt = (n + 63) // 64 + 255
        expert = mx.searchsorted(stop, mx.arange(nt, dtype=stop.dtype), side="right")

        def project(a, params, act):
            bn, bk, wm, wn = 64, 32, 2, 2
            w, s, g = params
            width = w.shape[1]
            k = a.shape[-1]
            return program(self.mode, self.hoist_addresses)(
                inputs=[
                    a,
                    w,
                    s,
                    g if g is not None else mx.ones((128,), mx.float32),
                    starts,
                    stop - tiles,
                    expert,
                    order,
                ],
                template=[
                    ("K", k),
                    ("N", width),
                    ("E", 128),
                    ("BM", 64),
                    ("BN", bn),
                    ("BK", bk),
                    ("WM", wm),
                    ("WN", wn),
                    ("ACT", act),
                    ("CAP", 0),
                    ("HOT", 0),
                ],
                grid=(32 * wm * wn * width // bn, nt, 1),
                threadgroup=(32 * wm * wn, 1, 1),
                output_shapes=[(n, 1, width // 2 if act else width)],
                output_dtypes=[mx.bfloat16],
            )[0]

        out = project(project(x, self.expand, True), self.contract, False).squeeze(-2)
        if return_routed:
            return out, mx.arange(n, dtype=mx.uint32), coeff
        return (
            (out.reshape(*ids.shape, -1).astype(mx.float32) * coeff[..., None])
            .sum(axis=-2)
            .astype(x.dtype)
        )
