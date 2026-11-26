"""Independent block-0 accuracy and speed against the upstream layer."""

import json
import time
from pathlib import Path
import mlx.core as mx
from huggingface_hub import snapshot_download
from mlx_lm import load
from dari_engine.engines.inkling.inkling_block import PreludeBlock

p = Path(
    snapshot_download(
        "mlx-community/Inkling-2-Mini-4bit",
        revision="9c0e2960609ba7cb40daf92c6f7bf8ed56e1dd62",
        local_files_only=True,
        allow_patterns=["*.json", "*.safetensors", "*.jinja"],
    )
)
index = json.loads((p / "model.safetensors.index.json").read_text())["weight_map"]
keys = {k for k in index if k.startswith("model.language_model.layers.0.")}
tensors = {
    k: v
    for shard in {index[k] for k in keys}
    for k, v in mx.load(str(p / shard)).items()
    if k in keys
}
own = PreludeBlock(tensors)
model, _ = load(str(p), lazy=True)
mx.random.seed(7)
xs = [mx.random.normal((1, n, 2304)).astype(mx.bfloat16) for n in [256] + [1] * 32]
from statistics import median

samples = {False: [], True: []}
for rep in range(7):
    results = {}
    for native in [False, True] if rep % 2 == 0 else [True, False]:
        state = {} if native else model.make_cache()[0]
        ys = []
        start = time.perf_counter()
        for i, x in enumerate(xs):
            y, _ = own(x, state) if native else model.layers[0](x, None, cache=state)
            mx.eval(y)
            ys.append(y)
            if i == 0:
                pre = time.perf_counter() - start
                decode = time.perf_counter()
        elapsed = (time.perf_counter() - decode) / 32
        if rep:
            samples[native].append((pre, elapsed))
        results[native] = ys
    if rep == 0:
        for i in (0, 1, 32):
            a, b = [results[n][i].astype(mx.float32) for n in (False, True)]
            print(
                "step",
                i,
                "relative RMS",
                (mx.linalg.norm(a - b) / mx.linalg.norm(a)).item(),
            )
for n, times in samples.items():
    print(
        "independent" if n else "upstream",
        "median ms (prefill, decode)",
        [round(1000 * median(t), 3) for t in zip(*times)],
    )
