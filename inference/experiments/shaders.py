"""Load MLX kernel bodies relative to the package, never the working directory."""

from functools import cache
from importlib.resources import files


@cache
def load_shader(name: str) -> str:
    return files("experiments").joinpath("metal", name).read_text(encoding="utf-8")
