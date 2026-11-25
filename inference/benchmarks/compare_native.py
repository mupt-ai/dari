"""ABBA comparison of native vs Python graph construction for loop message gates."""
import time
import mlx.core as mx
from mlx_lm.models.inkling2.layers import MessageGate
import _native
from dari_inference import Engine

engine = Engine(prefix_cache=False)
ids = engine.tokenizer.encode('Explain replication and consensus in distributed databases:', add_special_tokens=False)
original = MessageGate.__call__

def native(self, h, m):
    if h.shape[1] != 1:
        return original(self, h, m)
    return _native.gate(h, m, self.down_proj.weight, self.forget_gate_proj.weight, self.message_gate_proj.weight)

# Warm both paths before timing; model loading and first-use Metal work
# otherwise penalize the first configuration.
for fn in (original, native):
    MessageGate.__call__ = fn
    list(engine.generate(ids, 32, 0))
    mx.synchronize()
reference = None
for fn in (original, native, native, original):
    MessageGate.__call__ = fn
    stream = engine.generate(ids, 256, 0)
    first = next(stream)
    mx.synchronize()
    start = time.perf_counter()
    tokens = [first, *stream]
    mx.synchronize()
    elapsed = time.perf_counter() - start
    if reference is None:
        reference = tokens
    assert tokens == reference and len(tokens) == 256
    print(fn.__name__, round(255 / elapsed, 2), 'tokens/s', flush=True)
