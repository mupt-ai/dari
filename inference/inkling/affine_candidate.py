"""Use wider matrix tiles for the fused engine's packed attention projections.

The MLX Metal implementation is from the installed, pinned MLX headers (see
requirements-independent.txt). Keep its affine 4-bit decoder, BF16 operands,
accumulation, and guarded edge stores; specialize only its tile dimensions.
"""

import re
from functools import lru_cache

import mlx.core as mx

from inkling.fused_candidate import FusedModel
from inkling.inkling_model import linear
from inkling.mlx_headers import KERNELS, expand_headers, read_header
from inkling.shaders import load_shader


@lru_cache(maxsize=1)
def _projection_kernel():
    header = expand_headers(
        KERNELS + "steel/gemm/loader.h", KERNELS + "steel/gemm/mma.h"
    )
    quantized = read_header(KERNELS + "quantized.h")
    quantized = re.sub(
        r"^constant bool align_[^;]+;", "", quantized, flags=re.MULTILINE
    )
    loader_end = (
        quantized.index("\n};", quantized.index("struct QuantizedBlockLoader")) + 3
    )
    function = quantized.index("METAL_FUNC void qmm_t_impl")
    impl = quantized[
        quantized.rindex("template <", 0, function) : quantized.index(
            "\ntemplate <", function
        )
    ]
    # The enclosing kernel passes compile-time shape constants by value rather
    # than binding each as a separate constant-buffer argument.
    impl = impl.replace("const constant int&", "int")
    return mx.fast.metal_kernel(
        name="inkling_affine_attention_64x64",
        input_names=["x", "w", "s", "b"],
        output_names=["y"],
        header=header + "\n" + quantized[:loader_end] + "\n" + impl,
        source=load_shader("affine_attention_64x64.metal"),
    )


def _project(w, p, x):
    if x.shape[1] < 256 or not p.startswith("self_attn.") or p + ".scales" not in w:
        return linear(w, p, x)
    weight = w[p + ".weight"]
    n = weight.shape[0]
    m, k = x.shape[1:]
    if n < 1024 or k % 64 or x.dtype != mx.bfloat16:
        return linear(w, p, x)
    return _projection_kernel()(
        inputs=[x, weight, w[p + ".scales"], w[p + ".biases"]],
        template=[("M", m), ("K", k), ("N", n), ("ALIGNED", n % 64 == 0)],
        grid=(128 * ((n + 63) // 64), (m + 63) // 64, 1),
        threadgroup=(128, 1, 1),
        output_shapes=[(1, m, n)],
        output_dtypes=[x.dtype],
    )[0]


class AffineModel(FusedModel):
    """Experimental variant; decode and the checkpoint format are unchanged."""

    project_linear = staticmethod(_project)
