"""Run the unchanged benchmark or quality harness with the optional hybrid engine."""

import os
from pathlib import Path
import runpy
import sys

if "INKLING_COREML_SITE" in os.environ:
    sys.path.append(os.environ["INKLING_COREML_SITE"])
from inkling import inkling_model
from benchmarks.inkling_ane_experiment import Hybrid


class ExperimentalModel(inkling_model.Model):
    def __init__(self, path):
        super().__init__(path)
        self.experts = [Hybrid(e) for e in self.experts]


if __name__ == "__main__":
    harness = sys.argv.pop(1)
    if (
        harness not in {"bench_independent", "eval_teacher", "eval_unseen"}
        or sys.argv[1] != "ours"
    ):
        raise SystemExit("Specify a supported harness and the ours arm.")
    inkling_model.Model = ExperimentalModel
    runpy.run_path(str(Path(__file__).with_name(harness + ".py")), run_name="__main__")
