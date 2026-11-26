"""Read Metal headers shipped as resources in the pinned MLX package."""

import re
from functools import cache
from importlib.resources import files

KERNELS = "mlx/backend/metal/kernels/"


def read_header(name: str) -> str:
    return files("mlx").joinpath("include", name).read_text(encoding="utf-8")


def expand_headers(*names: str) -> str:
    """Inline MLX-local includes once per shader, in their original order."""
    seen = set()

    def expand(name: str) -> str:
        if name in seen:
            return ""
        seen.add(name)
        text = read_header(name)
        if name == KERNELS + "fp_quantized.h":
            # The expert kernel uses the loader, not MLX's own kernel entry points.
            text = text.split("template <typename T, int group_size, int bits, int D>")[
                0
            ]
            text = re.sub(r"constant bool align_.*?;", "", text)
        return re.sub(
            r'^#include "(mlx/[^"\n]+)"',
            lambda match: expand(match[1]),
            text,
            flags=re.MULTILINE,
        ).replace("#pragma once", "")

    return "\n".join(expand(name) for name in names)


@cache
def expert_headers() -> str:
    return (
        expand_headers(
            KERNELS + "steel/gemm/loader.h",
            KERNELS + "steel/gemm/mma.h",
            KERNELS + "fp_quantized.h",
        )
        + "\n"
    )
