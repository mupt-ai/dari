"""Experimental grouped NVFP4 Metal kernel with optional expert offload."""

import mlx.core as mx

from inkling.mlx_headers import expert_headers
from inkling.shaders import load_shader, render

headers = expert_headers()
prefix = load_shader("expert_tile_coordinates.metal")


def tile_body(mode="nvfp4", *, direct=False, hoist=False, bounded=False, **overrides):
    """The .metal file contains the complete default GEMM. Replace only variant-specific stages."""
    sections = {}
    if mode == "mxfp8":
        sections["WEIGHT_LOADER"] = load_shader("expert_weight_fp8.metal")
    elif mode != "nvfp4":
        raise ValueError(f"Unsupported expert weight format: {mode}")
    if direct:
        sections["INPUT_OFFSET"] = "(ACT ? 0 : row * K)"
        sections["INPUT_LOAD"] = load_shader("expert_direct_load.metal")
        sections["NEXT_INPUT"] = "if constexpr (!ACT) al.next();"
        sections["STORE_TILE"] = load_shader("expert_direct_store.metal")
        if hoist:
            sections["ROUTE_OFFSETS"] = load_shader("expert_route_offsets.metal")
            sections["INPUT_LOAD"] = render(
                sections["INPUT_LOAD"],
                READ_VECTOR=load_shader("expert_read_hoisted.metal"),
            )
    elif bounded:
        sections["INPUT_LOAD"] = load_shader("expert_contiguous_load.metal")
    return render(load_shader("expert_tile.metal"), **(sections | overrides))


kernel = mx.fast.metal_kernel(
    name="inkling_steel_partial_ffn",
    input_names=["a", "b", "sc", "gs", "starts", "base", "experts", "hot"],
    output_names=["y"],
    header=headers,
    source=prefix + tile_body(),
)
