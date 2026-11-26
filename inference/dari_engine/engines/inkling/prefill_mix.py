"""Mix a current residual with stored depth-bank rows, one threadgroup per token.

The local attention entrance starts from the raw hidden row. The MLP entrance
starts from an attention projection and its three-row causal history. Both
normalize in FP32 and combine the same bank rows in their original order. A
cross-pass message consumes the FP32 mixture; without one the kernel can also
finish the weighted RMS and emit BF16 directly. No state crosses requests.
"""

from functools import lru_cache

import mlx.core as mx

from .shaders import expand_inputs, load_shader, render


@lru_cache(None)
def _kernel(n, post, save_norm):
    names = [f"b{i}" for i in range(n)]
    sections = {"INVERSE_RMS": load_shader("bank_mix_inverse_rms.metal")}
    if post:
        sections["INPUT"] = load_shader("bank_mix_filter.metal")
    if not save_norm:
        sections["SAVE_NORM"] = ""
    src = render(load_shader("prefill_bank_mix.metal"), **sections)
    return mx.fast.metal_kernel(
        name=f"inkling_prefill_mix_{n}_{int(post)}_{int(save_norm)}",
        input_names=["x", "query", "weight", *names]
        + (["z", "hist", "fir"] if post else []),
        output_names=["y"] + (["saved"] if post or save_norm else []),
        ensure_row_contiguous=False,
        source=expand_inputs(src, names),
    )


def _apply(x, bank, query, weight, final, save_norm=False, post=(), skip=False):
    assert x.shape[0] == 1 and x.shape[-1] == 2304 and query.size == 2304
    dtype = x.dtype if final else mx.float32
    outputs = [dtype] + ([mx.float32] if post or save_norm else [])
    return _kernel(len(bank), bool(post), save_norm)(
        inputs=[x, query, weight, *bank, *post],
        template=[("O", dtype), ("N", len(bank)), ("FINAL", final), ("SKIP", skip)],
        grid=(256, x.shape[1], 1),
        threadgroup=(256, 1, 1),
        output_shapes=[x.shape] * len(outputs),
        output_dtypes=outputs,
    )


def local_input(x, bank, query, weight, *, final, keep):
    return _apply(x, bank, query, weight, final, save_norm=keep)


def post_attention(z, prior, fir, x, bank, query, weight, skip, final):
    if prior is None:
        prior = mx.zeros((1, 3, 2304), z.dtype)
    y, res = _apply(x, bank, query, weight, final, post=(z, prior, fir), skip=skip)
    return res, y, mx.contiguous(z[:, -3:])
