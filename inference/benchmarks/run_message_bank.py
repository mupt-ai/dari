"""Check the streamed cross-pass candidate with the standard full-model harness."""

from pathlib import Path
import runpy, sys
from inkling.inkling_model import Model

if __name__ == "__main__":
    h = sys.argv.pop(1)
    if (
        h not in {"bench_independent", "eval_teacher", "eval_unseen"}
        or sys.argv[1] != "ours"
    ):
        raise SystemExit("Expected harness and ours arm")
    Model.compact_message_bank = True
    runpy.run_path(str(Path(__file__).with_name(h + ".py")), run_name="__main__")
