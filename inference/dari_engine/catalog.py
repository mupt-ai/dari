"""Discover shipped model manifests without importing any engine or GPU library."""

import json
from dataclasses import dataclass
from importlib import import_module
from importlib.resources import files
from types import ModuleType


@dataclass(frozen=True)
class Model:
    adapter: str
    repository: str
    revision: str
    context_window: int

    @property
    def backend(self) -> ModuleType:
        return import_module(self.adapter)


def _catalog():
    models = {}
    for package in files("dari_engine.engines").iterdir():
        manifest = package.joinpath("models.json")
        if not manifest.is_file():
            continue
        for name, spec in json.loads(manifest.read_text(encoding="utf-8")).items():
            if name in models:
                raise ValueError(f"Duplicate local model: {name}")
            models[name] = Model(**spec)
    return models


DEFAULT_MODEL = "inkling-2-mini"
MODELS = _catalog()
