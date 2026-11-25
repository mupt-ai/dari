"""Small-row grouped NVFP4 expansion and contraction, experimental."""

import mlx.core as mx
from inkling.inkling_top8 import top8
from inkling.inkling_group_routes import group_routes
from inkling.inkling_partial_steel import kernel


def compact(
    moe,
    x,
    shape=(8, 32, 32, 1, 2),
    *,
    return_routed=False,
    program=kernel,
    indexed=False,
):
    selected, coeff = top8(x.astype(mx.float32) @ moe.router.T, moe.bias)
    order, inv, idx = group_routes(selected)
    n = order.size
    d = x.shape[-1]
    E = 128
    a = x.reshape(-1, 1, d)
    if not indexed:
        a = a[order // 8]
    start = mx.searchsorted(idx, mx.arange(E + 1).astype(idx.dtype))
    bm, bn, bk, wm, wn = shape
    counts = (start[1:] - start[:-1] + bm - 1) // bm
    ends = mx.cumsum(counts)
    base = ends - counts
    nt = (n + bm - 1) // bm + E - 1
    experts = mx.searchsorted(ends, mx.arange(nt), side="right")

    def project(a, params, act):
        w, s, g = params
        N = w.shape[1]
        K = a.shape[-1]
        if not indexed:
            a = mx.pad(a, [(0, bm), (0, 0), (0, 0)])
        return program(
            inputs=[
                a,
                w,
                s,
                g if g is not None else mx.ones((128,), mx.float32),
                start,
                base,
                experts,
                order if indexed else mx.array([0], mx.uint32),
            ],
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
                ("CAP", 0),
                ("HOT", 0),
            ],
            grid=(wm * wn * 32 * N // bn, nt, 1),
            threadgroup=(wm * wn * 32, 1, 1),
            output_shapes=[(n, 1, N // 2 if act else N)],
            output_dtypes=[mx.bfloat16],
        )[0]

    out = project(project(a, moe.expand, True), moe.contract, False).squeeze(-2)
    if return_routed:
        return out, inv, coeff
    v = out[inv].reshape(*selected.shape, d)
    return (v.astype(mx.float32) * coeff[..., None]).sum(axis=-2).astype(x.dtype)
