"""Supported checkpoints. Backends keep weight resolution and kernels family-specific."""

from dataclasses import dataclass
from types import ModuleType

from inkling import backend as inkling


@dataclass(frozen=True)
class Model:
    repository: str
    revision: str
    backend: ModuleType
    context_window: int


DEFAULT_MODEL = "inkling-2-mini"
MODELS = {
    "inkling-2-mini": Model(
        repository="thinkingmachines/Inkling-2-Mini",
        revision="c9d028302cd0f035fdf8e7e91f089a4ce94d2195",
        backend=inkling,
        context_window=50_000,
    ),
}
