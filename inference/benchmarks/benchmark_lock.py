"""Serialize model work on this user's GPU, including whole comparison suites."""

import fcntl
import os
import tempfile
from pathlib import Path

INHERITED_FD = "INKLING_BENCHMARK_LOCK_FD"


def exclusive_gpu():
    # Keep this handle until all Metal allocations are gone. A suite parent
    # passes its already-open description, so children needn't release the
    # suite's lock and reacquire it between arms. Re-lock it in all cases:
    # an environment variable alone must never bypass mutual exclusion.
    path = Path(tempfile.gettempdir()) / f"inkling-eval-{os.getuid()}.lock"
    inherited = os.environ.get(INHERITED_FD)
    if inherited is None:
        handle = path.open("a")
    else:
        fd = int(inherited)
        if not os.path.samestat(os.fstat(fd), path.stat()):
            raise ValueError("Inherited descriptor is not the benchmark lock")
        handle = os.fdopen(os.dup(fd), "a")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX)
    except BaseException:
        handle.close()
        raise
    return handle
