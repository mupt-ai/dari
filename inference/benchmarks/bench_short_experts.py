"""Compare full short-prefill expert dispatch on real normalized inputs."""

from statistics import median
from time import perf_counter
import mlx.core as mx
from benchmarks.bench_expert_real import moe, states
from inkling.inkling_top8 import top8
from inkling.inkling_moe import activate


def direct(x, gather):
    ids, weights = top8(x.astype(mx.float32) @ moe.router.T, moe.bias)

    def proj(z, params, indices, lhs=None):
        w, s, g = params
        return mx.gather_qmm(
            z,
            w,
            s,
            lhs_indices=lhs,
            rhs_indices=indices,
            global_scale=g,
            group_size=moe.group,
            bits=moe.bits,
            mode=moe.mode,
        )

    if gather:
        v = proj(
            x.reshape(-1, 1, x.shape[-1]),
            moe.expand,
            ids,
            mx.broadcast_to(
                mx.arange(x.shape[1], dtype=mx.uint32)[None, :, None], ids.shape
            ),
        )
    else:
        v = proj(x[..., None, None, :], moe.expand, ids)
    y = proj(activate(v), moe.contract, ids).squeeze(-2)
    return (y.astype(mx.float32) * weights[..., None]).sum(axis=-2).astype(x.dtype)


def aligned(x):
    from inkling.inkling_group_routes import group_routes

    ids, weights = top8(x.astype(mx.float32) @ moe.router.T, moe.bias)
    order, inv, idx = group_routes(ids)
    a = x.reshape(-1, 1, x.shape[-1])[order // 8]
    n = idx.size
    pad = max(512 - n, 0)
    idx = mx.pad(idx, [(0, pad)], constant_values=127)
    a = mx.pad(a, [(0, pad), (0, 0), (0, 0)])

    def project(a, params):
        w, s, g = params
        return mx.gather_qmm(
            a,
            w,
            s,
            rhs_indices=idx,
            sorted_indices=True,
            global_scale=g,
            group_size=moe.group,
            bits=moe.bits,
            mode=moe.mode,
        )

    v = project(activate(project(a, moe.expand)), moe.contract)[inv].reshape(
        *ids.shape, x.shape[-1]
    )
    return (v.astype(mx.float32) * weights[..., None]).sum(axis=-2).astype(x.dtype)


for n in (8, 16, 32, 64, 128):
    x = states[:, :n]
    arms = [moe, lambda x: direct(x, False), lambda x: direct(x, True), aligned]
    ref = moe(x)
    mx.eval(ref)
    ts = [[] for _ in arms]
    errs = []
    for r in range(15):
        for j in [(k + r) % len(arms) for k in range(len(arms))]:
            t = perf_counter()
            z = arms[j](x)
            mx.eval(z)
            ts[j].append((perf_counter() - t) * 1000)
            if r == 0:
                errs.append(
                    (
                        mx.linalg.norm(z.astype(mx.float32) - ref)
                        / mx.linalg.norm(ref.astype(mx.float32))
                    ).item()
                )
    print(n, [round(median(v[2:]), 3) for v in ts], errs, flush=True)
