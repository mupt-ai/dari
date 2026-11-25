"""One GPU dispatch for decode's packed NVFP4 contraction, mixture, FIR and residual.

Each SIMD group computes four channels for one routed expert; its threadgroup
combines all eight experts before writing any intermediate tensor to memory.
Benchmark includes both contraction and FIR on both arms. Not a default path.
"""

import mlx.core as mx

from inkling.direct_routes import Direct
from inkling.inkling_moe import activate
from inkling.inkling_partial_steel import headers
from inkling.inkling_top8 import top8
from inkling.shaders import load_shader

kernel = mx.fast.metal_kernel(
    name="inkling_contract_mix_decode",
    input_names=["x", "w", "s", "g", "ids", "coeff", "prior", "weight", "res"],
    output_names=["out", "hist"],
    header=headers,
    source=load_shader("contract_mix_decode.metal"),
)


def fused(x, params, ids, coeff, prior, weight, res, rows, v):
    w, s, g = params
    d = w.shape[1]
    k = x.shape[-1]
    assert d % rows == 0 and k % v == 0
    return kernel(
        inputs=[x, w, s, g, ids, coeff, prior, weight, res],
        template=[("ROWS", rows), ("V", v), ("K", k), ("D", d)],
        grid=(256 * (d // rows), 1, 1),
        threadgroup=(256, 1, 1),
        output_shapes=[res.shape, prior.shape],
        output_dtypes=[mx.bfloat16] * 2,
    )


class DirectExperts(Direct):
    def decode_with_fir(self, x, prior, weight, res):
        ids, coeff = top8(x.astype(mx.float32) @ self.router.T, self.bias)
        w, s, g = self.expand
        hidden = activate(
            mx.gather_qmm(
                x[..., None, None, :],
                w,
                s,
                rhs_indices=ids,
                group_size=16,
                bits=4,
                mode="nvfp4",
                global_scale=g,
            )
        )
        if prior is None:
            prior = mx.zeros((1, 3, res.shape[-1]), mx.bfloat16)
        return fused(hidden, self.contract, ids, coeff, prior, weight, res, 4, 8)
