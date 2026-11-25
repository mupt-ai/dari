"""Local prefill: apply K/V causal filtering while loading values for head normalization.

Each SIMD group owns one head, so past rows need no synchronization. The FIR
still rounds twice in BF16, including before the residual add. Write the same
three raw projection rows to history; never substitute normalized rows.
"""

import mlx.core as mx

from inkling.shaders import load_shader

kernel = mx.fast.metal_kernel(
    name="inkling_local_head_fir",
    input_names=["q", "r", "k", "v", "qs", "rs", "kp", "vp", "kw", "vw"],
    output_names=["qn", "rn", "kn", "vn"],
    ensure_row_contiguous=False,
    source=load_shader("local_head_fir.metal"),
)


def filtered(q, r, k, v, qs, rs, cache, w):
    keys = ("self_attn.k_sconv", "self_attn.v_sconv")
    l = q.shape[1]
    assert l >= 3
    prior = [cache.get(a) for a in keys]
    prior = [p if p is not None else mx.zeros((1, 3, 1024), k.dtype) for p in prior]
    cache.update(
        {a: mx.contiguous(x[:, -3:]) for a, x in zip(keys, (k, v), strict=True)}
    )
    return kernel(
        inputs=[q, r, k, v, qs, rs, *prior, *[w[a + ".conv1d.weight"] for a in keys]],
        template=[("T", q.dtype)],
        grid=(2048, l, 1),
        threadgroup=(128, 1, 1),
        output_shapes=[(1, l, 24, 128), (1, l, 24, 16), (1, l, 8, 128), (1, l, 8, 128)],
        output_dtypes=[q.dtype] * 4,
    )
