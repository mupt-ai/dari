"""Keep per-position cross-pass mixture coefficients, materialize one gate group at a time."""

import mlx.core as mx

from .shaders import load_shader

_scatter = mx.fast.metal_kernel(
    name="inkling_message_four",
    input_names=["a", "b", "scores", "layer"],
    output_names=["out"],
    source=load_shader("message_four.metal"),
)


class MessageBank:
    def __init__(self, rows, query):
        assert len(rows) == 2 and query.size == 48 * 2304
        self.a, self.b = rows
        source = mx.stack(rows, axis=-2)
        self.scores = mx.contiguous(
            mx.softmax(
                (source @ query.reshape(48, 2304).T) * (2304**-0.5), axis=-2
            ).swapaxes(-2, -1)
        )

    def group(self, j):
        _, l, d = self.a.shape
        return _scatter(
            inputs=[self.a, self.b, self.scores, mx.array(j, mx.uint32)],
            template=[("D", d)],
            grid=(l * 4 * d, 1, 1),
            threadgroup=(256, 1, 1),
            output_shapes=[(1, l, 4, d)],
            output_dtypes=[mx.float32],
        )[0]
