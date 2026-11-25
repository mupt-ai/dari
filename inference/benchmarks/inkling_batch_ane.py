"""One fixed-shape batched Core ML prediction for dynamically selected experts."""

from functools import lru_cache
import mlx.core as mx
import numpy as np
from _inkling_ane import Layer
from benchmarks.inkling_lazy_hybrid import LazyHybrid


@lru_cache(maxsize=8)
def batch_model(count, rows, d, h):
    import coremltools as ct
    from coremltools.converters.mil import Builder as mb
    from coremltools.converters.mil.mil import types

    def spec(r, c):
        return mb.TensorSpec(shape=(1, 1, count * r, c), dtype=types.fp16)

    @mb.program(
        input_specs=[spec(rows, d), spec(h, d), spec(h, d), spec(d, h)],
        opset_version=ct.target.iOS18,
    )
    def model(x, gate, up, down):
        def bat(v, r, c):
            return mb.reshape(x=v, shape=[1, count, r, c])

        def proj(a, b):
            return mb.matmul(x=a, y=b, transpose_y=True)

        x = bat(x, rows, d)
        a = proj(x, bat(gate, h, d))
        b = proj(x, bat(up, h, d))
        f = mb.tanh(x=mb.mul(x=a, y=np.float16(0.25)))
        u = mb.tanh(x=mb.mul(x=b, y=np.float16(0.04)))
        z = mb.mul(x=mb.mul(x=f, y=mb.sigmoid(x=a)), y=u)
        y = proj(mb.mul(x=z, y=np.float16(100)), bat(down, d, h))
        return mb.reshape(x=y, shape=[1, 1, count * rows, d])

    ml = ct.convert(
        model,
        convert_to="mlprogram",
        minimum_deployment_target=ct.target.macOS15,
        compute_units=ct.ComputeUnit.CPU_AND_NE,
    )
    return Layer(ml.get_compiled_model_path())


class BatchHybrid(LazyHybrid):
    def offload(self, moe, hot, start, flatx, d, h):
        cap, count = self.cap, self.count
        rows = mx.minimum(
            start[hot, None] + mx.arange(cap)[None, :], flatx.shape[0] - 1
        )
        x = flatx[rows, 0].astype(mx.float16)

        def dense(params):
            w, s, g = params
            # Dequantize with each expert's individual global scale.
            return (
                mx.stack(
                    [
                        mx.dequantize(
                            w[e],
                            s[e],
                            group_size=16,
                            bits=4,
                            mode="nvfp4",
                            global_scale=g[e],
                            dtype=mx.bfloat16,
                        )
                        for e in mx.split(hot, count)
                    ]
                )
                .reshape(count, w.shape[1], -1)
                .astype(mx.float16)
            )

        pair = dense(moe.expand)
        down = dense(moe.contract)
        arrays = [
            mx.contiguous(a.reshape(1, -1, a.shape[-1]))
            for a in (down, pair[:, ::2], pair[:, 1::2], x)
        ]
        v = batch_model(count, cap, d, h).predict(arrays).reshape(count, cap, d)
        return [v[i] for i in range(count)]
