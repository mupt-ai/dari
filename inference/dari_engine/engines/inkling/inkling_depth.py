"""Mix residual-bank rows without materializing a stacked copy of the bank."""

from functools import lru_cache

import mlx.core as mx

from .shaders import expand_inputs, load_shader


@lru_cache(None)
def kernel(n):
    names = [f"v{i}" for i in range(n)]
    return mx.fast.metal_kernel(
        name=f"inkling_depth_{n}",
        input_names=[*names, "queries"],
        output_names=["out"],
        source=expand_inputs(load_shader("depth_bank_mix.metal"), names),
    )


def depth(rows, query):
    _, length, d = rows[0].shape
    q = query.size // d
    return kernel(len(rows))(
        inputs=[*rows, query],
        template=[("D", d), ("Q", q), ("N", len(rows))],
        grid=(256, length, q),
        threadgroup=(256, 1, 1),
        output_shapes=[(1, length, q, d)],
        output_dtypes=[mx.float32],
    )[0]
