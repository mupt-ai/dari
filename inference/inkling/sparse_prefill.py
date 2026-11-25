"""Experiment: inject the 1024-lag bias into Steel's online softmax, not a dense mask."""

import mlx.core as mx

from inkling.mlx_headers import expand_headers, read_header
from inkling.shaders import load_shader, render


def make(whole=False):
    name = "mlx/backend/metal/kernels/steel/attn/kernels/steel_attention.h"
    text = read_header(name)
    header = (
        expand_headers("mlx/backend/metal/kernels/steel/attn/attn.h")
        + "\nusing namespace mlx::steel;\n"
        + text[text.index("struct MaxOp") : text.index("// clang-format off")]
    )
    src = text[text.index("  // Prepare threadgroup memory") : text.rindex("}")]
    src = (
        src[: src.index("  // Store the logsumexp")]
        + src[src.index("  // Store results\n") :]
    )
    src = src.replace(
        "sinks[tidl.y]",
        "sinks[min(int(tid.x)*BQ+tm+sm+i*8,QL-1)*sinks_strides[1]+tid.y]",
    )
    begin = src.index("    // Other masking")
    end = src.index("    threadgroup_barrier", begin)
    src = src[:begin] + load_shader("relative_attention_bias.metal") + src[end:]
    for field, val in {
        "Q_strides[2]": "q_strides[1]",
        "K_strides[2]": "k_strides[2]",
        "V_strides[2]": "v_strides[2]",
        "O_strides[2]": "(24*128)",
        "qL_off": "OFF",
        "qL_rem": "(QL%BQ)",
        "kL_rem": "(KL%BK)",
        "NQ_aligned": "(QL/BQ)",
        "NK_aligned": "(KL/BK)",
        "NK": "((KL+BK-1)/BK)",
        "scale": "(0.08838834764831845f)",
    }.items():
        src = src.replace("params->" + field, val)
    src = src.replace(
        "for (int kb = 0;",
        load_shader("relative_attention_skip.metal") + "for (int kb = first;",
    )
    setup = render(
        load_shader("relative_attention_setup.metal"),
        WARP_COLS="1" if whole else "2",
        WARP_ROWS="BQ/8" if whole else "2",
    )
    if whole:
        # One SIMD group owns each complete head dot. Keep BF16 matrix inputs
        # and float score/softmax accumulation; no split-dot exchange needed.
        src = src.replace("metal::conditional_t<WN == 2, T, AccumType>", "T").replace(
            "(WN == 2) && (BK == 32 || sizeof(T) == 4)", "true"
        )
    return mx.fast.metal_kernel(
        name="inkling_whole_head_prefill" if whole else "inkling_sparse_relative_steel",
        input_names=["q", "k", "v", "rel", "sinks"],
        output_names=["out"],
        ensure_row_contiguous=False,
        header=header,
        source=setup + src,
    )


kernel = make()
whole_kernel = make(True)


def attention(q, k, v, rel, sinks, local, bq=16, bk=32, *, whole=False):
    l = q.shape[1]
    n = k.shape[2]
    threads = 4 * bq if whole else 128
    return (whole_kernel if whole else kernel)(
        inputs=[q, k, v, rel, sinks],
        template=[
            ("T", q.dtype),
            ("align_Q", l % bq == 0),
            ("align_K", n % bk == 0),
            ("LOCAL", local),
            ("BQ", bq),
            ("BK", bk),
        ],
        grid=(threads * ((l + bq - 1) // bq), 24, 1),
        threadgroup=(threads, 1, 1),
        output_shapes=[(1, l, 24 * 128)],
        output_dtypes=[q.dtype],
    )[0]
