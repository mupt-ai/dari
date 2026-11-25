"""Time a direct, per-selected-expert NVFP4 matvec vs gather_qmm."""

import json
import statistics
import time
from pathlib import Path

import mlx.core as mx
from huggingface_hub import snapshot_download

from experiments.shaders import load_shader

p = Path(
    snapshot_download(
        "mlx-community/Inkling-2-Mini-4bit",
        revision="9c0e2960609ba7cb40daf92c6f7bf8ed56e1dd62",
        allow_patterns=["*.json", "*.safetensors", "*.jinja"],
        local_files_only=True,
    )
)
index = json.loads((p / "model.safetensors.index.json").read_text())["weight_map"]
key = "model.language_model.layers.6.mlp.experts.gate_up_proj."


def get(s):
    return mx.load(str(p / index[key + s]))[key + s]


w, sc, gs = [get(s) for s in ("weight", "scales", "global_scale")]
E, N, Kp = w.shape
K = Kp * 8
# Decode the 256 possible scale bytes once using the pinned library's codebook.
# A packed nibble of 2 represents +1. A global scale of 2688 cancels normalization.
scales = mx.dequantize(
    mx.full((256, 2), 0x22222222, mx.uint32),
    mx.arange(256).astype(mx.uint8)[:, None],
    bits=4,
    group_size=16,
    mode="nvfp4",
    global_scale=mx.array(2688.0),
    dtype=mx.float32,
)[:, 0]
mx.random.seed(19)
x = mx.random.normal((1, K)).astype(mx.bfloat16)
ids = mx.array([1, 18, 31, 35, 51, 80, 95, 112], mx.uint32)
kernel = mx.fast.metal_kernel(
    name="inkling_nvfp4_mv",
    input_names=["x", "w", "sc", "gs", "ids", "lut"],
    output_names=["y"],
    source=load_shader("nvfp4_mv.metal"),
)
vector_kernel = mx.fast.metal_kernel(
    name="inkling_nvfp4_vector_mv",
    input_names=["x", "w", "sc", "gs", "ids", "lut"],
    output_names=["y"],
    source=load_shader("nvfp4_vector_mv.metal"),
)


def vect(rows):
    return vector_kernel(
        inputs=[x, w, sc, gs, ids, scales],
        template=[("K", K), ("N", N), ("ROWS", rows)],
        grid=(8 * N * 32 // rows, 1, 1),
        threadgroup=(256, 1, 1),
        output_shapes=[(8, N)],
        output_dtypes=[mx.bfloat16],
    )[0]


mx.eval(scales, x, w, sc, gs, ids)


def packed():
    return mx.gather_qmm(
        x, w, sc, rhs_indices=ids, group_size=16, bits=4, mode="nvfp4", global_scale=gs
    ).reshape(8, N)


def direct():
    return kernel(
        inputs=[x, w, sc, gs, ids, scales],
        template=[("K", K), ("N", N)],
        grid=(8 * N * 32, 1, 1),
        threadgroup=(256, 1, 1),
        output_shapes=[(8, N)],
        output_dtypes=[mx.bfloat16],
    )[0]


ref = packed().astype(mx.float32)
mx.eval(ref)
arms = [("packed", packed), ("scalar", direct)] + [
    (f"vector{r}", lambda r=r: vect(r)) for r in [1, 2, 4, 8]
]
samples = {name: [] for name, _ in arms}
errors = {}
for rep in range(19):
    for name, fn in arms[rep % len(arms) :] + arms[: rep % len(arms)]:
        t = time.perf_counter()
        y = fn()
        mx.eval(y)
        elapsed = time.perf_counter() - t
        if rep:
            samples[name].append(elapsed * 1000)
        else:
            errors[name] = (
                mx.linalg.norm(y.astype(mx.float32) - ref) / mx.linalg.norm(ref)
            ).item()
for name, _ in arms:
    print(
        name,
        "ms / relative RMS",
        round(statistics.median(samples[name]), 4),
        errors[name],
    )
