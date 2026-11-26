# Fused prefill candidate

`dari_engine.engines.inkling.fused_candidate.FusedModel` is an experimental, single-request engine. It uses the same checkpoint, causal mask, eight experts per token and per-visit cache as `DirectModel`. It is not the serving default. It changes how tensors move through the GPU, not which prompt tokens are processed.

| Cost in the direct engine | What changes | Invariant |
| --- | --- | --- |
| For every K tile of a routed expansion, read the same token-to-row address again. | `direct_routes.py` hoists the row address out of the inner loop. | Store each contraction in the original token/rank order before mixing. |
| Read, filter and normalize K/V in different dispatches. | `local_head_fir.py` makes one SIMD group responsible for one head. | The FIR keeps the three **raw** previous projection rows, not normalized rows. |
| Write normalized residuals, weighted depth mixtures and filtered attention outputs between operations. | `prefill_mix.py` computes the needed values in one threadgroup per token. | Preserve the original bank ordering, layer-boundary additions, FP32 reductions and BF16 filter rounding. |
| Materialize 48 messages of width 2,304 for a token. | `implicit_messages.py` stores their two source rows and 48 pairs of coefficients. The gate reconstructs only the message it consumes. | Same sigmoid/tanh gate inputs; no sharing between requests. |
| Project two gates separately, then read both outputs to blend the message. | `packed_message_gate.py` interleaves corresponding output rows and blends in the matrix epilogue. | Pack only when **every** stored FP32 weight round-trips exactly through BF16; accumulate in FP32. Other weights use the original path. |
| Exchange half-head scores between SIMD groups while processing attention. | `sparse_prefill.py` lets each group compute a complete head dot. Groups work on distinct query rows within the tile. | Include the sink, the appropriate relative bias and all unmasked keys. Global attention still reads the entire causal history at 50k. |

The direct single-token route remains in place. A faster prefill microkernel is not a decode speedup: time the full synchronous generation loop, and when greedy outputs diverge, replay identical inputs for the decode comparison.

## First end-to-end measurements

Warm M4 Pro throughput changes vs MLX-LM; both reports use the packaged `FusedModel`. Do **not** combine prefill from one suite with decode from another.

| Decode inputs and process order | 16-token prefill / decode | 1,008-token prefill / decode |
| --- | ---: | ---: |
| [Greedy, ABBA](benchmarks/results/m4-pro-fused-short-greedy.txt) | +37.2% / +40.6%* | +29.6% / +35.5% |
| [Fixed reference inputs, BAAB](benchmarks/results/m4-pro-fused-short-replay.txt) | +35.5% / +39.6% | +28.8% / +36.0% |

\* Both greedy arms started from the same prompt but diverged at output 18 for the 16-token prompt. Use the fixed-input row for a matched decode comparison. At 1,008 tokens all 64 greedy outputs agreed, but prefill still missed +30%. This earlier variant did not meet the goal.

At [16,384 tokens](benchmarks/results/m4-pro-fused-16k-greedy-cache512.jsonl), with the unused allocator pool capped equally at 512 MiB and processes ordered BAAB, the warm medians were **452.76 / 36.71 tok/s** (fused prefill / decode) vs **348.72 / 27.52 tok/s** (MLX-LM). Both warm pairs agreed on all 64 greedy predictions. Decode cleared the threshold (+33.37%); prefill did not (+29.84%). There was one teacher checkpoint in this timing run; it does not replace independent held-out evaluation.

At [50,000 tokens with fixed reference inputs](benchmarks/results/m4-pro-fused-50k-replay-cache512.jsonl), the same 512 MiB cap and BAAB order gave **393.24 / 29.60 tok/s** vs **297.18 / 22.64 tok/s** (+32.32% prefill / +30.78% decode). These are medians of two warm processes per arm. Both engines computed and synchronized every prediction, but consumed the reference token at the next step. Their predictions first differed at output four. All six teacher-forced prompt checkpoints agreed on top-1; the mean target NLL difference was −0.00000191. This run clears both speed thresholds under the stated settings, not across every length or allocator configuration.

The [separate 50k greedy ABBA](benchmarks/results/m4-pro-fused-50k-greedy-cache512.jsonl) measured +30.86% prefill and +35.19% free-running decode. Both continuations first diverged at token four. Use the fixed-input result above, not that greedy decode rate, for a matched-trajectory claim.

## Wider tiles for affine projections (`--engine affine`)

`dari_engine.engines.inkling.affine_candidate.AffineModel` changes the *attention projections*, not the routed expert GEMMs. It multiplies up to 64 prompt rows by 64 output channels per GPU tile, with 32 input channels per inner step. It reuses MLX’s installed 4-bit affine decoder (group size 64), matrix accumulation, and guarded edge writes. Narrow projections and decode use the original path. No expanded weight matrices are kept resident.

In a [fixed-input ABBA](benchmarks/results/m4-pro-affine-short-replay.txt), 16 tokens measured **+35.90% / +38.22%** and 1,008 tokens measured **+30.08% / +35.20%**. The [opposite-order BAAB replay](benchmarks/results/m4-pro-affine-short-replay-baab.txt) measured +35.92% / +41.38% at 16 and +31.65% / +37.02% at 1,008. The ABBA medium prefill margin is less than one token per second over the threshold: 544.25 vs 418.40 tok/s. Do not ascribe the longer-context FusedModel results above to this variant. Reproduce using the `short` replay command below with `--engine affine`.

At [16,384 tokens on fixed inputs](benchmarks/results/m4-pro-affine-16k-replay-cache512.jsonl), the affine variant gave **+35.53% prefill / +28.71% decode** (ABBA; 512 MiB unused pool for both). All 64 predictions agreed. Affine tiling does not run on a one-token input, so the decode difference from the earlier fused suite is not evidence that a new decode kernel regressed. It is a measured miss, and the earlier engine’s decode rate cannot stand in for it.

The [reverse-order 16,384-token replay](benchmarks/results/m4-pro-affine-16k-replay-baab-cache512.jsonl) measured **462.51 / 32.52 tok/s** vs **342.07 / 27.33 tok/s** (+35.21% / +18.99%). All 64 predictions again agreed. Decode missed in both orders.

At [50,000 tokens on fixed inputs](benchmarks/results/m4-pro-affine-50k-replay-cache512.jsonl), AffineModel measured **398.31 / 30.49 tok/s** vs **296.95 / 22.61 tok/s** for MLX-LM, or **+34.13% prefill / +34.86% decode** (ABBA; the same 512 MiB cap). Both pairs first differed on prediction four. All six intermediate teacher checkpoints matched top-1 with a −0.00000191 mean target NLL difference. This is the affine engine’s own 50k measurement, not a result carried over from FusedModel.

AffineModel independently matched [67/67 established](benchmarks/results/m4-pro-affine-held-established.jsonl) and [156/157 extra](benchmarks/results/m4-pro-affine-held-extra.jsonl) reference next-token choices. Mean target NLL differences were +0.00793 and −0.01666. On the separate [50k ledger amendment](benchmarks/results/m4-pro-affine-50k-amendment.jsonl), both predicted all six answer tokens; mean target NLL difference was +0.04266.

## Single-token message gate (`--engine gated`)

`dari_engine.engines.inkling.decode_message_gate.GatedModel` extends `AffineModel`. During decode, eight lanes split the 64 input channels of a forget/message gate pair. They reuse the same input and the prepacked BF16 weights, reduce the two dot products in FP32, and blend the two residuals before writing a single FP32 row. The existing weighted RMS still follows. Non-representable weights use the original FP32 path. This changes gate arithmetic order, not the number of experts, context length or KV precision.

On [short fixed-input ABBA](benchmarks/results/m4-pro-gated-short-replay.txt), the packaged engine measured **+36.85% / +42.42%** at 16 tokens and **+32.80% / +41.26%** at 1,008 tokens. The [reverse-order short BAAB](benchmarks/results/m4-pro-gated-short-replay-baab.txt) measured +36.31% / +46.86% at 16 and +34.15% / +42.27% at 1,008. Predictions first differed at output 18 on the short prompt; all 64 agreed on the medium prompt. At [16,384 tokens](benchmarks/results/m4-pro-gated-16k-replay-cache512.jsonl), fixed-input ABBA measured **463.48 / 37.40 tok/s** vs **344.40 / 26.99 tok/s** (+34.58% / +38.53%). The [reverse-order BAAB](benchmarks/results/m4-pro-gated-16k-replay-baab-cache512.jsonl) gave **461.67 / 36.87 tok/s** vs **344.15 / 26.88 tok/s** (+34.15% / +37.16%). All 64 predictions agreed in both orders. The unused allocator cap was 512 MiB in both arms.

At [50,000 tokens](benchmarks/results/m4-pro-gated-50k-replay-cache512.jsonl), fixed-input ABBA measured **393.93 / 31.30 tok/s** vs **292.64 / 20.56 tok/s** (+34.61% / +52.25%) with the same 512 MiB unused-pool cap. All six prefill checkpoints matched; both pairs first differed at output four. The [50k reverse-order BAAB](benchmarks/results/m4-pro-gated-50k-replay-baab-cache512.jsonl) measured **392.25 / 29.58 tok/s** vs **292.83 / 22.71 tok/s** (+33.95% / +30.27%). This is matched decode throughput, not identical greedy continuations. See the [paired-gate scorecard](INDEPENDENT.md#paired-gate-result-on-the-m4-pro-48-gib) for all orders and held-out results.

The paired gate matched [66/67 established](benchmarks/results/m4-pro-gated-held-established.jsonl) and [156/157 extra](benchmarks/results/m4-pro-gated-held-extra.jsonl) reference predictions. Mean target NLL differences were +0.00326 and −0.01811, respectively. Affine without the decode change matched one additional established prediction; exact weight packing does not make the changed summation order bit-exact.

## Held-out predictions

On [six established prompts](benchmarks/results/m4-pro-fused-held-established.jsonl), FusedModel matched 67/67 reference top-1 predictions (mean target NLL difference +0.00793). On [eight additional prompts](benchmarks/results/m4-pro-fused-held-extra.jsonl), it matched 156/157 (−0.01666). The archived MLX-LM reference rows are reused unchanged and paired with fresh candidate rows; these are differential checks, not exact-logit equivalence or general accuracy estimates.

On the separate [50,000-token ledger amendment](benchmarks/results/m4-pro-fused-50k-amendment.jsonl), both engines predicted the six supplied answer tokens; the fused engine’s mean target NLL was 0.04266 higher. This is one case, distinct from the timed observatory prompt.

## Reproduce

From `inference/` with the pinned offline environment and model described in `INDEPENDENT.md`:

```sh
.venv/bin/python -m benchmarks.run_comparison short /tmp/fused-greedy.txt --engine fused --order ABBA
.venv/bin/python -m benchmarks.run_comparison short /tmp/fused-fixed.txt --engine fused --order BAAB --replay-reference /tmp/fused-greedy.txt
.venv/bin/python -m benchmarks.run_comparison long /tmp/fused-50k.jsonl --engine fused --length 50000 --order BAAB --free-cache-mib 512
.venv/bin/python -m benchmarks.run_comparison long /tmp/fused-50k-replay.jsonl --engine fused --length 50000 --order BAAB --free-cache-mib 512 --replay-reference benchmarks/results/m4-pro-direct-50k-greedy-cache512.jsonl
.venv/bin/python -m benchmarks.fused_full heldout_register ours --length 50000
.venv/bin/python -m benchmarks.heldout_register reference --length 50000
```

Repeat timings in the opposite process order. The 512 MiB option limits only unused allocator buffers for **both** engines; it is not a KV size cap. Re-run without the option for the default allocator comparison, and keep the two sets of results separate. Use the held-out reports rather than benchmark greedy output to evaluate quality.
