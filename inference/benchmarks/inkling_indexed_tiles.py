"""Direct routed input panel loads: avoid token expansion and both padded copies."""

from experiments.shaders import load_shader
from inkling.inkling_adaptive_tiles import adaptive
from inkling.inkling_partial_steel import tile_body


def indexed_kernel():
    body = tile_body(
        INPUT_LOADER="",
        ROUTE_OFFSETS=load_shader("indexed_offsets.metal"),
        INPUT_LOAD=load_shader("indexed_load.metal"),
        NEXT_INPUT="",
    )
    return adaptive(body, name="inkling_indexed_tile")
