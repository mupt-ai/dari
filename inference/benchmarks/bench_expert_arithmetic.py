"""Compare FP16, BF16 and activation-quantized expert GEMMs on a single real projection."""

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
mx.random.seed(37)
for n in (8, 8064):
    # Do not give candidates preconverted inputs: cast/quantization is timed.
    x = mx.random.normal((n, 1, K)).astype(mx.bfloat16)
    ids = mx.sort(mx.random.randint(0, E, (n,))).astype(mx.uint32)
    mx.eval(x, ids, w, sc, gs)

    def proj(arm, x=x, ids=ids):
        opts = {
            "rhs_indices": ids,
            "group_size": 16,
            "bits": 4,
            "mode": "nvfp4",
            "sorted_indices": True,
        }
        if arm == "qqmm":
            return mx.gather_qqmm(
                x,
                w,
                sc,
                global_scale_w=gs,
                global_scale_x=mx.max(mx.abs(x)).astype(mx.float32),
                **opts,
            )
        return mx.gather_qmm(
            x.astype(mx.float16) if arm == "fp16" else x, w, sc, global_scale=gs, **opts
        ).astype(mx.bfloat16)

    ref = proj("bf16")
    mx.eval(ref)
    times = {key: [] for key in ("bf16", "fp16", "qqmm")}
    err = {}
    for rep in range(9):
        arms = list(times)
        arms = arms[rep % 3 :] + arms[: rep % 3]
        for arm in arms:
            t = time.perf_counter()
            y = proj(arm)
            mx.eval(y)
            dt = time.perf_counter() - t
            if rep > 1:
                times[arm].append(dt * 1000)
            if rep == 0:
                err[arm] = (
                    mx.linalg.norm(y.astype(mx.float32) - ref.astype(mx.float32))
                    / mx.linalg.norm(ref.astype(mx.float32))
                ).item()
    print(
        n,
        {
            key: (round(statistics.median(v), 3), round(err[key], 5))
            for key, v in times.items()
        },
        flush=True,
    )
