"""Check last-logit suffix evaluation against the same engine's full final block."""

from pathlib import Path
import mlx.core as mx
from huggingface_hub import snapshot_download
from tokenizers import Tokenizer
from dari_engine.engines.inkling.inkling_model import Model
from benchmarks.benchmark_lock import exclusive_gpu

lock = exclusive_gpu()
p = Path(
    snapshot_download(
        "mlx-community/Inkling-2-Mini-4bit",
        revision="9c0e2960609ba7cb40daf92c6f7bf8ed56e1dd62",
        local_files_only=True,
        allow_patterns=["*.json", "*.jinja", "*.safetensors"],
    )
)
m = Model(p)
tok = Tokenizer.from_file(str(p / "tokenizer.json"))
tokens = tok.encode(
    "\n".join(
        f"Line {i}: the measuring cup weighs {17 * i % 319} grams, excluding water."
        for i in range(250)
    )
).ids
base = m.block
checks = []


def rms(a, b):
    assert a.shape == b.shape
    aa, bb = a.astype(mx.float32), b.astype(mx.float32)
    return (mx.linalg.norm(aa - bb) / mx.maximum(mx.linalg.norm(bb), 1e-8)).item()


def compare(i, x, bank, cache, msg, **kw):
    if not kw.get("last_only") or x.shape[1] < 256:
        return base(i, x, bank, cache, msg, **kw)
    other = dict(cache)
    y, bank0 = base(i, x, bank, other, msg)
    z, bank1 = base(i, x, bank, cache, msg, **kw)
    mx.eval(y, z)
    assert other.keys() == cache.keys() and other["offset"] == cache["offset"]
    errors = {}
    for k in other:
        if k == "offset":
            continue
        if k == "storage":
            errors["key"] = rms(cache[k][0], other[k][0])
            errors["value"] = rms(cache[k][1], other[k][1])
            continue
        errors[k] = rms(cache[k], other[k])
    errors["last_hidden"] = rms(z[:, -1:], y[:, -1:])
    checks.append(errors)
    print(
        "length",
        x.shape[1],
        "offset after",
        cache["offset"],
        "relative RMS",
        errors,
        flush=True,
    )
    return z, bank1


m.block = compare
for chunks in [(256,), (257,), (1025,), (73, 259, 384)]:
    c = [{} for _ in range(48)]
    p0 = 0
    for n in chunks:
        mx.eval(m(mx.array([tokens[p0 : p0 + n]]), c))
        p0 += n
assert len(checks) == 5 and all(e["key"] == e["value"] == 0 for e in checks)
