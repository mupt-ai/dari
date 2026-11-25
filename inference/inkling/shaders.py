"""Load MLX kernel bodies relative to the package, never the working directory."""

from functools import cache
from importlib.resources import files


@cache
def load_shader(name: str) -> str:
    return files("inkling").joinpath("metal", name).read_text(encoding="utf-8")


def render(source: str, **sections: str) -> str:
    """Fill explicit comment slots, not substrings of Metal expressions."""
    for name, code in sections.items():
        marker = f"/* {name} */"
        if marker not in source:
            raise ValueError(f"Missing Metal template slot: {name}")
        end = f"/* END {name} */"
        if end in source:
            # Optional overrides enclose the ordinary Metal implementation so it can be read in place.
            start = source.index(marker)
            stop = source.index(end, start) + len(end)
            source = source[:start] + code + source[stop:]
        else:
            source = source.replace(marker, code)
    return source


def expand_inputs(source: str, names: list[str]) -> str:
    """Unroll marked blocks for MLX's separately named input buffers and strides."""
    begin, end = "/* EACH_INPUT */", "/* END_INPUT */"
    while begin in source:
        before, rest = source.split(begin, 1)
        block, after = rest.split(end, 1)
        source = (
            before
            + "\n".join(
                block.replace("INPUT_INDEX", str(index)).replace("INPUT_BUFFER", name)
                for index, name in enumerate(names)
            )
            + after
        )
    return source
