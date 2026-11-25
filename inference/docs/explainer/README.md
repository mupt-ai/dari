# How Inkling prefill and decode work

[Watch the narrated walkthrough](inkling-engine.mp4). It walks from the first kernels to the paired-gate engine and its four-length scorecard. Read [the measurements](../../INDEPENDENT.md) for matched workloads and correctness evidence.

| Chapter | What to look for |
| --- | --- |
| Two different races | Prefill can work on many positions together; the next decode step must wait for the previous prediction. |
| Send work to the right experts | Colors represent experts. Sorting by color lets many positions reuse each expert’s packed weights, then the inverse index restores order. |
| Fit the tile to the work | The diagram illustrates occupied rows, not three successive tiles from one launch. The actual kernel chooses its last tile size from the group’s remaining rows. |
| Keep intermediate values nearby | Fused activation avoids storing the expanded gate/up pair. A separate fused reduction, causal filter and residual preserves the histories needed for decode. |
| Prove it end to end | Warm measurements and held-out checks serve different purposes. A 50k-token retrieval probe is not a general measure of long-context accuracy. |
| Route indices, not copies | See why the direct candidate gathers at the tile and restores token/rank order at the write. |
| One target still out of reach | The direct candidate’s 1,008-token decode passes while prefill misses. The [scorecard](../../INDEPENDENT.md#direct-route-candidate-not-the-default) links the raw measurements. |
| At 50,000 tokens, the result flips | With the default allocator the same candidate reads the prompt faster, but generates more slowly. Both engines produce the same continuation on this example. |
| Two rows can carry 48 messages | Two source vectors and 48 coefficient pairs replace a bank of expanded messages. The engine checks that paired gate weights round-trip exactly through BF16. |
| Keep a whole head together | Each SIMD group computes one complete head dot product. The packaged fused engine still misses the medium-prompt prefill threshold. |
| Wider attention projections | A 64 × 64 tile reuses packed weights across prompt positions; it does not accelerate single-token decode. |
| Why replay matters at 50,000 tokens | After a prediction differs, feeding the same recorded next input keeps the measured workload matched. The separate ledger prompt checks retrieval. |
| Two gate decisions from one input | Eight lanes reuse the input to compute both gate decisions in single-token decode. |
| What the final engine demonstrated | Compare the smaller measured gain across process orders and distinguish throughput from prediction agreement. |

The walkthrough is 5 min 45 s. For the later matched 16k and 50k experiments, see the [fused-engine scorecard](../../FUSED_PREFILL.md).

The 16-token free-running rates use identical prompts, but the continuations diverged at generated token 18. Use the [fixed-input replay protocol](../../benchmarks/README.md) for matched decode.

**Rebuild on macOS:** Install Pillow, FFmpeg (with libx264), and the Arial system font. Set `VOGENT_API_KEY` in your shell and run `python render.py /tmp/inkling-engine-video`. The script performs external narration requests; cached WAVs are reused. No model weights, prompts from users, or credentials are embedded in the MP4. The `SCENES` table in `render.py` doubles as the transcript.
