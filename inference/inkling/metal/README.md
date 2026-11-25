# Metal kernels

Start with the `.metal` file to read the math. Its Python caller names the inputs and outputs, chooses types and tile sizes, and launches the grid. These are **MLX kernel bodies**, not standalone `kernel void` functions: MLX supplies the entry point, buffer bindings and requested stride metadata. The loader reads the files relative to the package; keep this directory when copying the engine. No offline shader build is required.

| To follow… | Start here | What to look for |
| --- | --- | --- |
| A cross-pass message | [message_load_norm.metal](message_load_norm.metal), [inverse_rms.metal](inverse_rms.metal) | Reconstruct two weighted rows, then normalize the message and hidden state independently. |
| Decode attention | [shared_kv_parts.metal](shared_kv_parts.metal) → [shared_kv_merge.metal](shared_kv_merge.metal) | Three queries reuse one KV head. Each partition keeps its own softmax maximum; merge rescales the partial sums. |
| Expert selection | [top8.metal](top8.metal) → [route_hist.metal](route_hist.metal) → [route_scatter.metal](route_scatter.metal) | Select by biased priority, weight by unbiased probability, then stably group the selected routes. |
| An expert matrix multiply | [expert_tile_coordinates.metal](expert_tile_coordinates.metal) → [expert_tile.metal](expert_tile.metal) | `BM`, `BN`, `BK` are the input-row, output-channel, and reduction tile sizes. Look at the default contiguous FP4 path before following a variant. |
| Mixing the residual bank | [prefill_bank_mix.metal](prefill_bank_mix.metal) | Score the current and saved rows, normalize their scores, then blend in the same order. |

Most callers load one file unchanged. Two cases need assembly:

- **Different input counts.** MLX exposes one named buffer per bank row. `EACH_INPUT` blocks are expanded once per buffer, including its own strides. An empty bank emits no such statements.
- **Different tile implementations.** Comments such as `/* INPUT_LOAD */` and `/* END INPUT_LOAD */` surround the ordinary implementation. A variant replaces that named block, not a substring of a Metal expression. For example, direct routing substitutes [expert_direct_load.metal](expert_direct_load.metal). Attention and affine kernels that reuse Steel still take the upstream implementation from the pinned MLX installation; we don't vendor a second copy.

Candidate shaders live in [experiments/metal](../../experiments/metal/); the runtime does not depend on them. When editing, keep the precision of casts, the order of reductions, and the barriers intact unless the change is intentionally numerical. From `inference/`, format sources and exercise both prompt and decode paths with:

```sh
clang-format -i --assume-filename=source.cpp inkling/metal/*.metal experiments/metal/*.metal
.venv/bin/python -m benchmarks.fused_full eval_teacher ours --gated --long
```
