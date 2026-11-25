"""Compare packed vs resident bf16 expert GEMMs on a single real projection."""

import json
import statistics
import time
from pathlib import Path

import mlx.core as mx
from huggingface_hub import snapshot_download

p = Path(
    snapshot_download(
        "mlx-community/Inkling-2-Mini-4bit",
        revision="9c0e2960609ba7cb40daf92c6f7bf8ed56e1dd62",
        allow_patterns=["*.json", "*.safetensors", "*.jinja"],
        local_files_only=True,
    )
)
index = json.loads((p / "model.safetensors.index.json").read_text())["weight_map"]
prefix = "model.language_model.layers.0.mlp.experts.gate_up_proj."


def get(k):
    key = prefix + k
    return mx.load(str(p / index[key]))[key]


w, sc, gs = [get(k) for k in ("weight", "scales", "global_scale")]
E, N, _ = w.shape
K = w.shape[-1] * 8
# Separate per-expert scalar global scales are required for dequantization.
dense = mx.stack(
    [
        mx.dequantize(
            w[e],
            sc[e],
            group_size=16,
            bits=4,
            mode="nvfp4",
            global_scale=gs[e],
            dtype=mx.bfloat16,
        )
        for e in range(E)
    ]
)
mx.eval(dense, w, sc, gs)
mx.random.seed(19)
for n in (8, 8064):
    x = mx.random.normal((n, 1, K)).astype(mx.bfloat16)
    idx = mx.sort(mx.random.randint(0, E, (n,))).astype(mx.uint32)
    mx.eval(x, idx)
    times = [[], []]
    values = {}
    for r in range(7):
        for b in (0, 1) if r % 2 == 0 else (1, 0):
            t = time.perf_counter()
            if not b:
                y = mx.gather_qmm(
                    x,
                    w,
                    sc,
                    rhs_indices=idx,
                    sorted_indices=True,
                    group_size=16,
                    bits=4,
                    mode="nvfp4",
                    global_scale=gs,
                )
            else:
                y = mx.gather_mm(
                    x, dense.swapaxes(-2, -1), rhs_indices=idx, sorted_indices=True
                )
            mx.eval(y)
            elapsed = time.perf_counter() - t
            if r:
                times[b].append(elapsed * 1000)
            else:
                values[b] = y
    a, b = [z.astype(mx.float32) for z in values.values()]
    print(
        n,
        "ms packed / dense",
        *[round(statistics.median(t), 3) for t in times],
        "relative RMS",
        (mx.linalg.norm(a - b) / mx.linalg.norm(a)).item(),
        flush=True,
    )
