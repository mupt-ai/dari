# Independent text forward path (experimental)

[Metal kernel source and reading guide](inkling/metal/README.md) · [Experimental shaders](experiments/metal/)

`inkling/inkling_model.py` loads quantized text tensors directly from the pinned MLX snapshot. It computes the 6-layer prelude, three visits to the same 12-layer core, and 6-layer tail, with cross-pass message banks and a separate KV/short-convolution state per visit. The final head returns last-position raw logits over the unpadded vocabulary (sufficient for greedy decoding). The decoder uses `mlx.core`, not MLX-LM modules or Metal kernels from MLX-LM. The production Pi service has not been switched to it.

To reproduce on Apple Silicon, create a Python 3.12 virtual environment and install `requirements-independent.txt`. Place the pinned `mlx-community/Inkling-2-Mini-4bit` snapshot (revision `9c0e2960609ba7cb40daf92c6f7bf8ed56e1dd62`) in the Hugging Face cache first; the benchmark and quality runners use it offline. The optional Core ML experiments are not engine dependencies.

From this folder, with other models unloaded, run `.venv/bin/python -m benchmarks.bench_independent ours` and then `.venv/bin/python -m benchmarks.bench_independent reference`. They use the same tokenizer, prompts, weights, and synchronous greedy loop. Each starts a new cache and generates 64 tokens. The first run warms up. Time to first token includes the head and argmax; decode timing covers the other 63 tokens. This comparison does not measure HTTP, lookup, or speculative decoding. A reference import occurs only in the reference benchmark arm.

## Paired-gate result on the M4 Pro (48 GiB)

One implementation, `inkling.decode_message_gate.GatedModel`, exceeded +30% in **both** phases at each of the four tested prompt lengths in **both** process orders. Each cell is the throughput gain over MLX-LM on identical decode inputs. This is a measured result for these workloads and allocator settings, not an accuracy-equivalence claim.

| Prompt tokens | ABBA: prefill / decode | BAAB: prefill / decode | Unused allocator pool (both arms) |
| ---: | ---: | ---: | --- |
| 16 | [+36.85% / +42.42%](benchmarks/results/m4-pro-gated-short-replay.txt) | [+36.31% / +46.86%](benchmarks/results/m4-pro-gated-short-replay-baab.txt) | Default |
| 1,008 | [+32.80% / +41.26%](benchmarks/results/m4-pro-gated-short-replay.txt) | [+34.15% / +42.27%](benchmarks/results/m4-pro-gated-short-replay-baab.txt) | Default |
| 16,384 | [+34.58% / +38.53%](benchmarks/results/m4-pro-gated-16k-replay-cache512.jsonl) | [+34.15% / +37.16%](benchmarks/results/m4-pro-gated-16k-replay-baab-cache512.jsonl) | 512 MiB |
| 50,000 | [+34.61% / +52.25%](benchmarks/results/m4-pro-gated-50k-replay-cache512.jsonl) | [+33.95% / +30.27%](benchmarks/results/m4-pro-gated-50k-replay-baab-cache512.jsonl) | 512 MiB |

The lowest margin was 50k BAAB decode: **29.585 vs 22.711 tokens/s**, only 0.27 percentage points above the threshold. These are observed medians, not a guaranteed lower bound. A = independent, B = MLX-LM. Each letter is a fresh process; only warm runs count. Long prompts use 1,024-token chunks and full global attention. The pool limit is not a KV cap. No prefix cache or speculative decode is used. [Protocol](benchmarks/README.md) · [Kernel details](FUSED_PREFILL.md) · [Narrated walkthrough](docs/explainer/README.md).

In a separate [50k default-allocator ABBA](benchmarks/results/m4-pro-gated-50k-replay-default.jsonl), the same engine and trace measured **290.52 / 18.85 tok/s** vs **95.11 / 8.23 tok/s** (+205.47% / +128.94%). Both arms were slower in absolute terms than with the equal 512 MiB caps. The machine was paging and the individual warm decode rates varied from 15.96 to 21.74 for the engine and 7.40 to 9.07 for MLX-LM. Do not pool this diagnostic with the capped scorecard or extrapolate the larger ratios to memory-unconstrained hosts.

**Held-out checks:** Top-1 agreement was [66/67 established](benchmarks/results/m4-pro-gated-held-established.jsonl), [156/157 additional](benchmarks/results/m4-pro-gated-held-extra.jsonl) and [72/74 on six fresh prompts specified after freezing the gate](benchmarks/results/m4-pro-gated-held-fresh.jsonl). Mean target NLL differences (engine minus reference) were +0.00326, −0.01811 and −0.00953 respectively. Both engines predicted all [six answer tokens on a separate 50k amendment](benchmarks/results/m4-pro-gated-50k-amendment.jsonl); mean target NLL rose by 0.04160. The timed 50k prompt already diverged at output four; matched replay measures speed, not identical text.

## Where to start

- `inkling/` is the inference library: load `inkling.inkling_model.Model` for the measured default, or `inkling.combined_candidate.DirectModel` for the direct-route candidate. Neither imports benchmark drivers or MLX-LM. Pass the local snapshot path to the constructor and a fresh list of 48 independent state dictionaries per request. Reuse that list only for subsequent chunks and tokens of that same request.
- `benchmarks/` contains the reference adapter, held-out fixtures, timing harnesses, report readers and experimental comparisons. Run them as Python modules **from this directory**. `benchmarks/results/` contains the original measurements, not generated fixtures. See [benchmark protocols](benchmarks/README.md).
- `native/` contains optional native build experiments; `docs/explainer/` contains the narrated video and its source. Neither is required to run the independent engine.

The newer [fused prefill candidate](FUSED_PREFILL.md) combines local FIR, implicit message gates and whole-head attention. Its code, measured results, and reproduction commands are separate from the direct and default scorecards below.

## Run the paired-gate engine without the benchmark harness

Run from `inference/` with the pinned snapshot already on disk. The core accepts token IDs; it neither downloads the model nor retains state between requests. This example prints the prompt's predicted next token, then advances the same request by one token:

```python
from pathlib import Path
import mlx.core as mx
from huggingface_hub import snapshot_download
from tokenizers import Tokenizer
from inkling.decode_message_gate import GatedModel

snapshot = Path(snapshot_download(
    "mlx-community/Inkling-2-Mini-4bit",
    revision="9c0e2960609ba7cb40daf92c6f7bf8ed56e1dd62",
    allow_patterns=["*.json", "*.jinja", "*.safetensors"],
    local_files_only=True,
))
model = GatedModel(snapshot)
tok = Tokenizer.from_file(str(snapshot / "tokenizer.json"))
state = [{} for _ in range(48)]  # One cache per visit, not per physical layer.
ids = tok.encode("The opposite of hot is").ids
logits = model(mx.array([ids]), state)
token = mx.argmax(logits).item()
print(tok.decode([token]))
next_logits = model(mx.array([[token]]), state)
mx.eval(next_logits)
```

For long prompts, pass consecutive non-overlapping chunks (1,024 tokens in the reported runs) with the **same** state, evaluating logits after each chunk. Begin decode with the prediction after the last chunk. Allocate new dictionaries before starting another prompt. The standalone HTTP server uses this same model.

## What the default engine achieves on the M4 Pro

Warm median tokens/s, independent engine versus MLX-LM. A workload passes the performance gate only if **both** columns improve by at least 30%. The 50k run uses fresh request caches and 1,024-token prefill chunks; its decode rates vary widely under memory pressure.

| Prompt tokens | Prefill: engine / reference | Decode: engine / reference | Meets both? |
| ---: | ---: | ---: | :--- |
| 16 | 138.50 / 101.95 (+35.9%) | 43.10 / 31.00 (+39.0%) | Not verified on identical decode inputs |
| 1,008 | 495.35 / 413.50 (+19.8%) | 38.60 / 29.65 (+30.2%) | No |
| 50,000 | 190.80 / 113.48 (+68.1%) | 7.28 / 9.94 (−26.7%) | No |

In every warm default and direct pair the 16-token prompt first diverged at generated token 18. Its prefill still matches the workload, but its free-running decode speed is not an identical-input result. All 64 greedy tokens matched at 1,008 tokens. For a separate fixed-input control, see [the replay protocol](benchmarks/README.md).

**Correctness is not identical.** On separate held-out inputs the engine matched 66 of 67 established and 156 of 157 additional reference next-token predictions. At 50k both arms retrieved the locker name and matched all six teacher-forced checkpoints, but their greedy continuations first differed at the fourth token. Repetitions of that one retrieval prompt do not add independent accuracy cases.

Rebuild the table from the checked-in raw records (no GPU or model weights needed):

```sh
python3 -m benchmarks.report_short_context benchmarks/results/m4-pro-promoted-baab.txt
python3 -m benchmarks.report_long_context benchmarks/results/m4-pro-50k-greedy.jsonl
python3 -m benchmarks.report_held_out --prompts 6 --positions 67 benchmarks/results/m4-pro-held-established.jsonl
python3 -m benchmarks.report_held_out --prompts 8 --positions 157 benchmarks/results/m4-pro-held-extra.jsonl
```

[Watch the narrated engine walkthrough](docs/explainer/README.md). The notes below are a chronological research log: earlier measurements describe earlier implementations, not the current default.

## Direct-route candidate (not the default)

The expansion kernel in `inkling/direct_routes.py` reads a token's normalized row directly into threadgroup memory. It does not first copy that row once for each of its eight routes. The contraction writes each result back to its original token and rank, so the weighted sum keeps its original order. In single-token NVFP4 decode, `inkling/direct_experts.py` combines contraction, expert weighting, causal filtering and residual addition in one GPU dispatch. FP8 decode uses the default implementation. Both paths preserve per-request history; neither reuses another request's work.

| Prompt tokens | Prefill: direct / reference | Decode: direct / reference | Both ≥30%? |
| ---: | ---: | ---: | :--- |
| 16 | 139.00 / 101.85 (+36.5%) | 43.75 / 30.55 (+43.2%) | Not verified on identical decode inputs |
| 1,008 | 517.95 / 411.75 (+25.8%) | 40.60 / 29.50 (+37.6%) | No |
| 50,000 | 226.75 / 87.84 (+158.1%) | 7.77 / 8.11 (−4.2%) | No |

**Fixed-input decode control:** A separate ABBA fed both engines the same previously recorded reference tokens on every decode step, without skipping model evaluation or argmax. At 16 tokens, direct was 138.60 / 43.80 vs 102.30 / 31.70 tok/s (**+35.5% prefill / +38.2% decode**). This passes both throughput thresholds on identical inputs, not exact greedy agreement. At 1,008 tokens the same control gave +25.3% / +36.0%. Rebuild with `python3 -m benchmarks.report_short_context benchmarks/results/m4-pro-direct-short-replay.txt`.

The 50k comparison ran ABBA with the default allocator and fresh KV state. Both warm pairs retrieved `violet`, agreed on all 64 greedy predictions and matched all six teacher-forced checkpoints (mean target NLL delta +0.0000019). This is one prompt. Peak active memory was 19.31 vs 19.20 GiB. Paging varied: independent warm decode was 6.98 and 8.56 tokens/s; reference was 7.72 and 8.51. Each process held the GPU lock individually, not across all four; other probes could run **between** arms. Do not combine this result with another candidate or allocator setting.

**Separate 50k allocator check:** With the same 512 MiB unused-buffer cap on both engines and the GPU lease held for the whole BAAB suite, direct achieved **364.88 / 30.48** vs **298.42 / 22.92** tok/s (**+22.3% prefill / +33.0% decode**). Both warm pairs again matched every checkpoint and all 64 predictions. Neither allocator setting meets both thresholds; the faster prefill from the uncapped run and faster decode from the capped run cannot be combined.

On a different 50,000-token prompt, a later amendment changes an inventory assignment. Given the same target prefix at each position, direct and reference both predicted all six target tokens of ` Amber, Cedar.`; direct's mean target NLL was 0.06302 higher. This checks two distant facts in one held-out ledger, not general retrieval accuracy.

Short and medium rates are medians from four warm samples per arm and length. At the measured 1,008-token reference rate, the prefill target is 535.28 tokens/s. Held-out agreement: 67/67 on six prompts (mean target NLL delta +0.01424) and 156/157 on eight other prompts (−0.01666).

```sh
PYTHONPATH=. .venv/bin/python -m benchmarks.direct_full bench_independent ours
python3 -m benchmarks.report_short_context benchmarks/results/m4-pro-direct-abba.txt
python3 -m benchmarks.report_long_context benchmarks/results/m4-pro-direct-50k-greedy.jsonl
python3 -m benchmarks.report_long_context benchmarks/results/m4-pro-direct-50k-greedy-cache512.jsonl
python3 -m benchmarks.report_held_out --prompts 1 --positions 6 benchmarks/results/m4-pro-direct-50k-amendment.jsonl
python3 -m benchmarks.report_held_out --prompts 6 --positions 67 benchmarks/results/m4-pro-direct-held-established.jsonl
python3 -m benchmarks.report_held_out --prompts 8 --positions 157 benchmarks/results/m4-pro-direct-held-extra.jsonl
```

## Experiment history

On this M4 Pro the 1,008-token prompt gave 370–381 prompt tokens/s and 29.3–29.4 decode tokens/s for the independent implementation, vs 383–394 and 29.9–30.5 for the reference. All 64 greedy tokens agreed on this prompt. On the 16-token technical prompt the first greedy tokens already differed. Performance parity is not correctness parity: these results do not qualify as a win. Compiling depth mixing, gate mixing, clipping and the MoE activation improved the independent long-prompt result from 344–353 prompt tokens/s and 26.3–26.6 decode tokens/s. Baseline and candidate were timed in separate processes, not interleaved across thermal conditions. The next correctness gate is layer-by-layer error on real token embeddings and cross-pass state, then held-out next-token loss, not agreement on a counting prompt.

### November 23 continuation

`.venv/bin/python -m benchmarks.compare_visits` captures all 48 visit outputs in separate reference and independent processes on the same real prompt, then performs one forced decode step on each cache. On the 16-token crash-recovery prompt the previous implementation had 0.279% relative RMS error at the first visit and 9.66% at the raw logits, changing the first prediction. Promoting stock attention inputs to float32 did not fix it. For a single attention tile, rounding the unnormalized numerator weights to fp16 before multiplying values, but leaving the denominator in float32, fixed the first prediction. Packing the query, relative-position, output gate and sink projections yielded 64/64 greedy-token agreement on both existing benchmark prompts. This is not a held-out accuracy evaluation.

Warm runs on the 1,008-token prompt: independent 366.3–367.3 prefill and 28.5–29.9 decode tokens/s; reference 417.1–418.0 and 29.3–30.1 respectively. Packing did not improve long-prompt prefill. No serving change. Next benchmark kernel candidates on held-out prompts as well as these two; prioritize long-prompt prefill and profile warmed independent decode, not the serving wrapper.

### Expert and cache experiments

- `benchmarks/profile_experts.py` synchronizes on the inputs and outputs of every expert block. A warmed 1,008-token prefill spent 1.41 s in NVFP4 expert blocks and 0.16 s in MXFP8 expert blocks out of 2.74 s total. These synchronized timings are for attribution, not headline throughput.
- `benchmarks/bench_expert_projection.py` alternates packed and pre-dequantized bf16 GEMMs for the real first layer expansion weights. At 8 selected rows the packed/dense medians were 0.291/0.647 ms; at 8,064 rows they were 19.60/19.40 ms. This does not justify expanding the checkpoint in memory.
- Fusing the expert output gather and reduction in Metal did not establish an end-to-end gain. Reverted that experiment. The candidate KV cache now uses ring slots for local layers and grows global storage in 256-token pages. Warm throughput 371–382 prefill and 29.1–30.5 decode on the long prompt, not a verified 30% win.
- `eval_teacher.py {ours,reference}` checks four fixed out-of-benchmark prompts, 43 teacher-forced target tokens, using model-softcapped logits. Keep top-1 agreement and token loss separate from generation timing. This is a smoke test, not a broad quality benchmark.

The static four-tap convolution now uses a direct Metal filter with an explicit bf16 round before residual addition. Two warm long-prompt runs measured 379.1/383.8 prefill and 31.7/31.4 decode tokens/s; the teacher-forced smoke corpus gave 41/43 reference top tokens and mean NLL 1.03251 vs 1.03211. Neither metric meets the throughput target. `benchmarks/bench_expert_tiles.py` found the existing sorted-vector `gather_qmm` faster than padded 8/16/32/64-row expert GEMMs or 128 ragged dispatches for the real first-layer expansion on a uniform routing fixture. `benchmarks/bench_expert_decode.py`'s direct NVFP4 matvec agreed on its fixture but was slower than the packed primitive. Neither expert prototype is enabled in the model.

Long prefill now runs relative attention in 128-query strips, omitting future key tiles and (in local attention) expired keys. A Metal kernel writes the sink and relative mask for each strip. On the 1,008-token benchmark the new path measured 396.0/416.5 prefill and 33.0/32.2 decode tokens/s. Explicitly dequantizing non-expert projections for long prompts dropped prefill to 381 tokens/s; that change is not enabled. `eval_teacher.py {ours,reference} --long` adds independent 608- and 1,366-token prompts to exercise this path on both sides of the 1,024-position cache boundary. All performance measurements must use one model runner at a time.

On the two long teacher-forced cases the fused-mask candidate agreed with the reference on 23/24 top predictions (11/12 on 1,366 tokens, 12/12 on 608).

Packing all six attention projections into one quantized matmul where Q/K/V share an input gave 414.4/417.1 prefill and 32.8/32.8 decode on the 1,008-token benchmark, after warmup. An earlier overlapping run failed with a Metal timeout and was discarded. Full benchmark and teacher-forced scripts now hold an OS-released exclusive GPU benchmark lock. Replacing the expert input permutation with `lhs_indices` more than doubled prefill latency, so it was reverted. The real-weight arithmetic microbenchmark found no speed gain from fp16 inputs or on-the-fly NVFP4 activation quantization; neither is enabled.

Dynamic four-tap convolution now contracts directly from the short history and the per-position coefficients. Depth mixing for up to three queries uses a Metal threadgroup per row/query to avoid copying the entire residual bank. Warm long-prompt rates were 418.9–425.8 prefill and 32.3–35.7 decode tokens/s. On the held-out teacher-forced cases, 65 of 67 top tokens agreed; one fewer than the previous candidate. Batching the three Q/K/V cross-pass message gates did not improve long-prompt throughput and was reverted. These throughput ranges are not a matched 30% improvement.

The completed alternating (reference/ours/ours/reference) comparison for the depth-mixing candidate gave median 423.9/35.2 tokens/s vs 417.35/30.5 on the long prompt. The next candidate shares one leading sink across attention strips and performs Q/R/K clipping plus V RMS normalization in one dispatch. Its two warm long-prompt trials measured 417.4/421.3 prefill and 36.3/36.3 decode. The 30% targets implied by the matched baseline are 542.6 and 39.65 respectively.

`benchmarks/bench_expert_mma.py` implements a grouped SIMD-matrix FP4 prefill projection, with packed tiles and a per-expert scale/code lookup. Five tile shapes agreed with the reference to relative RMS below 1e-7. None improved latency: best 26.25 ms versus 19.89 ms for the existing gather on the same real projection. It is not used by the runtime. The active candidate instead fuses sigmoid routing, biased top-eight selection, and normalization of the unbiased weights. Warm long-prompt trials reached 423.2/431.3 prefill and 33.6/36.8 decode tokens/s. This does not establish a 30% speedup.

The cross-pass message down-projection now reads a single fused normalization of its two strided inputs, avoiding two RMS dispatches, a concatenation, and a dtype conversion. Warm 1,008-token results reached 435.0/436.3 prefill and 37.0/37.2 decode tokens/s. This still falls short of the matched targets.

### Matched mask and expert-intermediate experiments

The four-arm norm-pair run (two warm measurements per arm, four warm values per backend and length) gave median independent 426.15 prefill / 37.30 decode vs MLX-LM 411.35 / 29.00 tokens/s on 1,008 tokens. A refreshed synchronized prefill profile attributed 1.574 of 2.388 s to experts (1.401 s NVFP4). This profile is not a throughput measurement.

The direct single-token relative mask reads by physical KV slot, including wrapping local storage, and skips the global temperature multiplier only where its mathematical value is unity. Its separate reference/ours/ours/reference run gave 409.35 / 38.25 vs 401.40 / 28.45 tokens/s (+2.0% / +34.4%). The long-prompt baseline varied appreciably between arms; **prefill does not qualify**. Held-out results unchanged: 65/67 top predictions, mean NLL difference +0.00670. These results do not imply overall completion.

`benchmarks/bench_expert_real.py` measures the first expansion using actual first-block routing on the benchmark input: individual expert counts range from 0 to 1,003 rather than clustering around 63. `benchmarks/bench_expert_epilogue.py` fused GEMM, bf16 rounding and the two-input activation, without writing the expanded tensor. Even with resident fp16-decoded weights, the best fused time was 23.98 vs 20.07 ms. Packing the weight into 8x8 panels (`benchmarks/bench_expert_panel.py`) improved the best to 20.69 vs 19.07 ms (relative RMS 0.000044), still a loss. Affine recoding (`benchmarks/bench_expert_repack.py`) was either slower or imprecise (4-bit: 18.29 vs 18.82 ms, 7.16% projection-relative RMS error). None of these expert alternatives is enabled.

Packing the two output matrices of each cross-pass gate (as distinct from batching Q/K/V gates) gave 408.45 / 36.10 vs 384.8 / 28.8 tokens/s in an ours/reference/reference/ours run; thermal variation was large and the packed gate did not establish improvement over the direct-mask candidate. Held-out results again were 65/67, +0.00670 mean NLL. A warm, synchronized component profile (`benchmarks/profile_prefill_parts.py`) put experts at 1,725 of 2,821 ms, attention projections at ~560 ms, and striped attention at 113 ms. These component times include forced synchronization.

On the same real first-layer expansion, using Metal Performance Primitives for fused activation (`benchmarks/bench_expert_mpp.py`) took 17.67 ms for a 32x128 tile without relaxed precision vs 19.16 ms for packed expansion plus activation. This requires decoded resident weights; it is a single-layer microbenchmark, not model throughput. Reading the packed FP4 weights directly via threadgroup dequantization (`benchmarks/bench_expert_mpp_fp4.py`) cost at least 21.62 vs 19.11 ms. Neither is on the runtime path.

The fused weighted RMS-and-cast before attention and MoE projections (`inkling/inkling_norm.py`) agreed on 67/67 held-out top predictions, with independent mean NLL 0.00753 lower than reference on those targets. Its 1,008-token matched medians were 429.4 / 37.7 vs 417.05 / 30.7 tokens/s (+3.0% / +22.8%). Neither speed threshold was reached in this run, notwithstanding a 34.4% decode result on the previous matched run. The gate-pair experiment was reverted. Real-routing hybrid CPU/GPU expansion took at least 25.37 vs 18.83 ms; exact routing buckets with padded native GEMMs at least 22.87 vs 19.00 ms. INT8 MPP expansion plus activation was both slower and less accurate. A Steel FP4 fused register epilogue matched the native expansion plus separate activation at best, 19.10 ms each.

Fusing the expert output gather, weighted reduction, FIR history and residual write (`inkling/inkling_expert_fir.py`) removed the full token-major expert intermediate. On the completed 1,008-token ABBA the medians were 431.65 / 37.05 vs 411.7 / 29.8 (+4.8% / +24.3%). Two standalone prefill runs at 451.3 / 459.7 were not the matched result. On six established prompts it matched 67/67 top predictions (mean NLL difference −0.00942). On eight additional cases fixed **after** this candidate was implemented (`benchmarks/eval_unseen.py`), it matched 153/157 (mean NLL difference −0.00320). There is no claim of identical logits or general quality equivalence.

Optional Core ML feasibility probes use a separate temporary coremltools environment. The compute plan selected the Neural Engine for both constant and dynamic-weight 256x2304 by 2304x2304 products; Python prediction timings were 0.62 / 2.54 ms respectively. Offloading the hottest complete expert *expansion* to a precompiled model, including input/output copies and concurrent GPU processing of the remainder, reduced one-layer time from 18.83 to 17.59 ms. This is not a 30% gain, and does not include the residency cost of all expert models. Splitting just 256 of its rows was slower. No Core ML dependency was added to the engine.

Reading strided attention projections directly in head normalization and the convolution taps, and compiling the output-attention gate, raised the matched long medians to 450.7 / 38.1 vs 406.5 / 30.5 tokens/s (+10.9% / +24.9%). On 16 tokens the same run gave 105.7 / 41.25 vs 102.15 / 32.1 (+3.5% / +28.5%). Established and additional held-out results stayed 67/67 and 153/157 (220/224 total). The target remains open.

`benchmarks/bench_expert_ane_ffn.py` measured the entire first expert block on real routing. Two static hot experts on the ANE plus the remainder on GPU took 26.78 vs 30.97 ms. Six were slower (48.25 ms). More importantly, `benchmarks/bench_expert_ane_dynamic.py` uses **runtime** expert weights selected by actual route counts and includes dequantization and copies; at two experts it took 26.94 vs 30.76 ms (relative RMS 0.0052). This runner requires no precompiled per-expert models. A separate `benchmarks/run_ane_experiment.py` can exercise this alternative on the unchanged full-model benchmark and held-out inputs; it is not enabled by default.

The optional dynamic GPU/ANE runner completed the whole independent model at 421.9 / 456.5 prefill and 38.3 / 37.1 decode on the two warm long trials. Despite the first-layer microbenchmark, it did not establish a prefill improvement, let alone the matched 30% target; it remains an experiment, not the default.

A dedicated single-token kernel now gathers the eight outputs, applies the causal FIR and residual, and writes the following token's three history slots together. In ours/reference/reference/ours order the 1,008-token medians were **442.05 / 39.45 vs 399.35 / 29.80** (+10.7% prefill, +32.4% decode); the 16-token medians were 105.55 / 42.95 vs 101.95 / 31.7 (+3.5%, +35.5%). This is a matched decode win, not completion. Correctness: 66/67 established top predictions, 154/157 additional, mean NLL differences −0.00488 and −0.00506 respectively. Neither differential establishes universal correctness.

The experimental fused relative FlashAttention was slower than the shipped striped attention (1,008 tokens: ~8.9 vs ~2.2 ms); it is not used. A separate static ANE/GPU division of a large 8,600-channel attention projection gave 4.89 ms with 4,096 channels on ANE vs 7.64 GPU-only; the full-model experiment `benchmarks/run_ane_projection.py` includes the device bridge and is not in the default engine.

The final visit now keeps the entire KV history but evaluates only the trailing attention strips needed by the final token and the two four-tap FIR histories. Five fresh/cached comparisons (including lengths 257 and 1,025) had identical final hidden rows and KV; maximum FIR state relative RMS was 3.56e-7. The suffix candidate's 1,008-token ABBA medians were 440.45 / 38.65 vs 357.20 / 29.35 (+23.3%, +31.7%); 16-token medians were 104.10 / 43.00 vs 100.50 / 31.25 (+3.6%, +37.6%). Long prefill varied substantially between the two reference arms (403.5/391.9 then 322.5/315.9), so do not treat this as a stable 23% improvement. Established and additional held-out targets matched 66/67 and 154/157, mean NLL deltas −0.00488 and −0.00506. No prefix cache was reused.

The optional native Core ML bridge schedules predictions on the MLX CPU stream, using shared input views and output backings. Splitting static attention projections reached only 421.0/448.5 warm long prefill. The lazy dynamically routed full FFN experiment removed host routing readbacks: first-layer packed baseline 30.79 ms vs 32.92/33.95/29.50 ms offloading 1/2/3 hot experts. A single batched Core ML prediction instead measured 35.90/36.05/36.55 ms (2×512, 3×512, 3×1024) vs 30.83 ms packed, relative RMS 0.00364–0.00552. Neither replaces the default. Separate Strassen projection and FP16-accumulation microbenchmarks were slower: 8.08 vs 7.63 ms packed, and best 22.47 vs 18.81 ms, respectively.

Stable GPU counting sort now produces both permutations and sorted expert IDs together. `benchmarks/bench_group_routes.py` verified all three against `argsort` at lengths 16, 257, and 1,008. At 1,008 tokens isolated dispatch fell from 394 to 219 μs, but full-model BAAB medians were only 418.95/38.40 vs 397.55/29.70 (+5.4%/+29.3%). On 16 tokens: 103.00/41.90 vs 101.30/31.70 (+1.7%/+32.2%). All 14 prompt-aligned quality records, including NLL vectors, were unchanged vs the suffix candidate. This microbenchmark win does not establish a full-model improvement.

`benchmarks/bench_short_experts.py` found that unsorted expert dispatch does not help at 16 tokens (2.70 vs 2.53 ms); padding route rows to force a larger native GEMM took 3.76 ms. Instead `benchmarks/bench_short_steel.py` tries an 8×32 GPU output tile, decoding packed FP4 and fusing the expansion activation. On the first real expert block this took 1.83 vs 2.52 ms at 16 tokens and 2.28 vs 4.72 ms at 32. `benchmarks/run_short_steel.py` evaluates this path only for 8–63 tokens in NVFP4 layers. Core ML is not required.

Completed short-Steel ABBA: at 16 tokens, 126.90 / 41.65 vs 101.00 / 31.20 (+25.6% prefill, +33.5% decode); at 1,008 tokens, 442.35 / 38.90 vs 369.95 / 29.45 (+19.6%, +32.1%). This kernel does not run on long prompt rows. Held-out top predictions matched 66/67 established and 156/157 additional; mean NLL deltas −0.00235 and −0.01604. Neither prefill threshold was reached. `benchmarks/bench_short_plan.py` then avoided the sort/copy using a per-expert SIMD route plan: 1.76 vs 1.86 ms for sorted Steel and 2.54 ms native at length 16. `benchmarks/bench_adaptive_tiles.py` specialized the last partial tile of each long-prompt expert: 28.01 vs 30.77 ms native for the first real block. These latter figures are layer timings, not engine throughput.

### Mixed FP4/FP8 prefill (current default)

`inkling/inkling_prefill_moe.py` uses warp-sized route plans for 8–32 tokens, a fixed short FP4 tile for 33–63 tokens, and grouped adaptive tail tiles for longer inputs and the remaining MXFP8 layers. Decode and fewer than eight rows retain the packed native path. These kernels do not require Core ML and do not cache activations across requests.

| M4 Pro, fresh-cache warm medians | Independent prefill / decode | MLX-LM prefill / decode | Relative prefill / decode |
|---|---:|---:|---:|
| Initial candidate ABBA, 16 tokens | 137.80 / 42.10 | 101.75 / 30.85 | +35.4% / +36.5% |
| Initial candidate ABBA, 1,008 tokens | 486.35 / 38.90 | 392.95 / 29.50 | +23.8% / +31.9% |
| Promoted default BAAB, 16 tokens | 138.50 / 43.10 | 101.95 / 31.00 | +35.9% / +39.0% |
| Promoted default BAAB, 1,008 tokens | 495.35 / 38.60 | 413.50 / 29.65 | +19.8% / +30.2% |

For the promoted BAAB, warm 1,008-token prefill measurements in execution order: reference (414.7, 418.6), ours (494.3, 502.1), ours (490.6, 496.4), reference (412.3, 405.3). The remaining gap is long prefill, not decode. Initial and promoted quality JSONL matched byte-for-byte on all 14 held-out prompts: 66/67 and 156/157 top tokens, mean NLL differences −0.00996 and −0.01666. Five suffix checks retained exact final hidden and KV, max FIR relative RMS 4.86e-5. These are differential checks, not exact-logit equivalence.

Further real-input probes: alternating two threadgroup panels was slower (28.73–29.39 vs 28.04–28.07 ms). A lossless per-expert bf16 palette needed 76–96 distinct nonnegative magnitudes on first-block weights and measured 27.72 vs 27.93 ms; nearly doubling weight bytes was not justified. Concurrent CPU/GPU projection reduced one 7.71 ms projection to 6.17 ms, but not whole-model prefill (459.6/335.4 unmatched). None is selected by the default engine.

### Long-context validation

From `dari-inference`, run `PYTHONPATH=. .venv/bin/python -m benchmarks.long_context ours --length 50000 --chunk 1024 --runs 2`, then repeat with `reference`. For paired timings, run ours/reference/reference/ours serially, discard run 0 in each process, and report the median of each metric separately. Do not compare these chunked timings directly with the single-call 1,008-token benchmark.

Both arms ingest the same exact-length token sequence, identified by SHA-256, with a fresh cache each run. Both compute a last-row head per chunk. The prompt puts a locker name in the opening note and asks for it at the end; the middle consists of distinct numbered records. Output JSON includes full-prompt throughput through the first prediction, throughput for 63 subsequent synchronous greedy predictions, MLX peak memory, generated text, and top token and target NLL on the same teacher-forced record boundaries. This is one retrieval probe, not a general long-context quality score.

`python -m benchmarks.report_long_context LOG.jsonl` summarizes a completed four-process log. It rejects partial runs, differing token hashes, different chunk sizes, and missing teacher-forced positions. Repeated measurements of the same prompt are not new held-out cases.

Greedy runs can send different tokens to the experts once the engines disagree. For a separate matched-token decode diagnostic, add `--replay-reference GREEDY.jsonl` to **all four** long-context arms. Use a greedy log with a warm MLX-LM result for the same prompt SHA, chunk size, and decode count. Every step still runs the full engine and synchronizes its own prediction; only the token fed to the next step is fixed. `output` is then a sequence of predictions on reference histories, **not** free-running generated text. The report refuses to mix modes or reference trajectories. This diagnostic supplements, never replaces, greedy latency and held-out quality.

**50,000-token M4 Pro result (completed ABBA, default greedy mode).** The independent engine achieved **190.80 prefill / 7.28 decode tok/s**, versus MLX-LM **113.48 / 9.94**: **+68.1% prefill, −26.7% decode**. Peak active MLX memory was 21.53 vs 19.20 GiB. Both engines answered `violet`; all six teacher-forced top tokens matched, with mean target NLL difference −0.0000011. The generated sequences first diverged at zero-based index 3. This is one retrieval prompt on a shared 48 GiB host with paging; the two independent warm decode runs differed materially. It is not evidence of superiority on long decode or general long-context accuracy. Reproduce the numerical summary without MLX: `python -m benchmarks.report_long_context benchmarks/results/m4-pro-50k-greedy.jsonl`.

**Following the decode regression.** The `benchmarks/profile_cache_storage.py` diagnostic synchronizes and records buffer backing changes; it is not a throughput test. On a real 8,192-token prefill all 16 global KV buffers moved when their capacity grew from 8,192 to 8,448 at the first step. None moved on the following seven steps. The MLX unused-buffer pool held about 5.6 GiB even then. This rules out reallocating the global KV backing on every token at that size, not temporary copies or paging at 50k. To isolate free-pool effects, pass `--free-cache-mib 512` to **both** long-context arms; report that comparison separately from default settings. The cap does not shrink live weights or the request cache.

### How allocator pressure changes the 50k comparison

We repeated the default engine versus MLX-LM in ABBA order with `--free-cache-mib 512` **on both engines**. This limits how much unused memory the allocator keeps; it does not limit live model or KV bytes. The warm medians were **347.51 vs 300.83 prefill (+15.5%)** and **27.35 vs 18.95 decode (+44.3%)**. The two reference decode rates were 22.67 and 15.23, versus 27.15 and 27.54 for the independent engine. Peak active memory remained 21.53 vs 19.20 GiB. Both repetitions still matched 6/6 teacher-forced checkpoints and first diverged on the fourth greedy prediction.

The allocator setting changes the conclusion for each phase, but **neither configuration passes both targets**. Do not combine the uncapped prefill advantage with the capped decode advantage. Reproduce the diagnostic report with `python3 -m benchmarks.report_long_context benchmarks/results/m4-pro-50k-greedy-cache512.jsonl`.

### Avoiding padded expert inputs (experimental)

`benchmarks/ragged_dispatch.py` reuses the expert histogram to locate routed rows. Where a tile could run beyond the end of the input buffer, it bounds the load rather than padding and copying the whole input. `--split` handles a 33–48-row tail as two smaller pieces (32 plus the remainder); the same rule applies to 17–24 rows. The first real routed block agreed bit-for-bit with the default path. To run the full-model arm from this directory:

```sh
PYTHONPATH=. .venv/bin/python -m benchmarks.ragged_dispatch --split --harness bench_independent ours
python3 -m benchmarks.report_short_context benchmarks/results/m4-pro-ragged-split-abba.txt
```

In matched ABBA order this reached 139.00 / 41.95 prefill/decode at 16 tokens (reference 101.35 / 29.45), and 504.45 / 38.80 at 1,008 tokens (reference 405.35 / 28.95). Long prefill improved by **24.4% over MLX-LM**, not the required 30%; kernel-level agreement is not a substitute for held-out model tests. Not enabled by default.

### Combined candidate: separate normal and memory-pressure comparisons

`benchmarks/combined_candidate.py` combines the ragged expert dispatch with (1) computing relative bias inside the attention tile, (2) sharing a global KV read across three query heads in long decode, (3) views of one packed attention projection instead of duplicate rows, and (4) a paged prefill append for each global KV cache. Each request still starts empty. None of these switches changes the serving path. Run `PYTHONPATH=. .venv/bin/python -m benchmarks.combined_candidate long_context ours --length 50000 --runs 2` for an independent arm; the reference arm is `PYTHONPATH=. .venv/bin/python -m benchmarks.long_context reference --length 50000 --runs 2`. Use the same flags on every arm.

| Workload | Independent prefill / decode | MLX-LM prefill / decode | Gain, prefill / decode |
| --- | ---: | ---: | ---: |
| 16, BAAB | 138.60 / 42.35 | 101.70 / 29.90 | +36.3% / +41.6% |
| 1,008, same BAAB | 506.25 / 38.50 | 412.65 / 28.45 | +22.7% / +35.3% |
| 50,000, default allocator ABBA | 254.68 / 9.81 | 68.20 / 4.86 | +273.5% / +101.7% |
| 50,000, both unused pools capped at 512 MiB, BAAB | 363.62 / 29.17 | 296.53 / 22.85 | +22.6% / +27.7% |

**Interpretation:** The uncapped 50k run reached both thresholds, but the system was paging heavily: the two reference decode samples were 2.69 and 7.04 tok/s. The capped comparison was much faster in absolute terms but did not reproduce a 30% gain. Do not generalize the uncapped ratio or pool these records. At 50k the candidate used 19.35 GiB peak active memory vs 19.20 GiB reference and matched all 64 greedy predictions and all six checkpoint predictions on both paired comparisons. The intermediate-context prefill target remains open. Verify the metrics with `benchmarks/report_short_context.py` on `benchmarks/results/m4-pro-combined-baab.txt` and `benchmarks/report_long_context.py` on either `m4-pro-combined-50k-greedy*.jsonl` file individually.

**Independent 32k quality check.** `benchmarks/heldout_register.py` constructs a 32,768-token ledger with an assignment at one-quarter depth and an amendment at three-quarter depth. It asks for the final and original depots in that order. The default independent engine and MLX-LM both predicted all six target tokens (` Amber, Cedar.`) under teacher forcing, with fresh caches, identical token IDs and 1,024-token chunks. This is one additional correctness case, **not** a throughput measurement or a general retrieval score. Run `PYTHONPATH=. .venv/bin/python -m benchmarks.heldout_register ours --length 32768` and repeat with `reference`; the recorded pair is in `benchmarks/results/m4-pro-32k-amendment.jsonl`.

On the separate, existing held-out corpus the combined candidate matched the reference top token at 67/67 established positions (mean target NLL delta +0.01424) and 156/157 additional positions (−0.01666).

## Official Thinking Machines weights

The independent text engine also accepts `thinkingmachines/Inkling-2-Mini` (tested revision `c9d028302cd0f035fdf8e7e91f089a4ce94d2195`). Pass the local snapshot directory to `GatedModel`; the index selects the layout. `inkling/checkpoint.py` maps the publisher's tensor names, convolution axes, cross-pass queries and packed expert metadata at load time. Dense embeddings, attention and output matrices stay dense; they are not requantized to the community checkpoint's affine 4-bit format. Expert kernels consume the original NVFP4/MXFP8 blocks. This is text inference only, not vision or DSpark.

Run the same quality check on both backends with a locally available snapshot:

```sh
P=.venv/bin/python
$P -m benchmarks.fused_full eval_teacher ours --gated --snapshot "$SNAPSHOT"
$P -m benchmarks.eval_teacher reference --snapshot "$SNAPSHOT"
```

Repeat both commands with `--long` for the longer held-out prompts. On the M4 Pro, the official-weight engine matched **67/67** MLX-LM teacher-forced next-token choices on these six prompts (mean target NLL difference −0.0331). [Raw records](benchmarks/results/m4-pro-official-gated-held.jsonl). This validates a limited text corpus, not universal equivalence. The community-weight comparison remains a distinct scorecard.

[Official-weight speed scorecard and raw replay logs](benchmarks/results/official-weights.md): 16, 1,008, 16,384 and 50,000 tokens in both process orders, with same-weight MLX-LM and historical community-weight comparisons.
