# Official Inkling 2 Mini text performance — M4 Pro, 48 GiB

Paired-gate independent engine vs pinned MLX-LM, both on Thinking Machines revision `c9d028302cd0f035fdf8e7e91f089a4ce94d2195`. Files were locally re-sharded without changing the official tensor bytes. Measurements exclude loading the model, tokenization and HTTP. Fixed input IDs for all 63 decode steps were taken from the previously recorded community-reference greedy traces. Throughput comparisons do not require the predictions to match. [Held-out output comparison](m4-pro-official-gated-held.jsonl): 67/67 next-token matches across six prompts, not universal equivalence.

Every cell gives **prefill / decode** in tokens/s or percent change in throughput (positive = faster). A = Dari; B = MLX-LM. Four serial fresh processes per order, cold run discarded; four warm samples per arm for short prompts, two for long. Each long prefill uses 1,024-token chunks. Cache limit refers to unused allocator buffers, not the KV cache. The last two columns compare to earlier community-weight measurements; they are **not** a back-to-back weight-only experiment. Other apps, the idle local endpoint, swap and thermal state can affect absolute throughput, particularly at 50k. Do not pool allocator settings or process orders.

| Prompt tokens | Allocator cap | Order | Dari official | MLX-LM official | Dari vs MLX-LM | Dari community (historical) | Official vs community, Dari |
|---:|---|---|---:|---:|---:|---:|---:|
| 16 | default | ABBA | 122.2 / 29.9 | 91.8 / 22.9 | +33.2% / +30.6% | 138.9 / 44.1 | -12.0% / -32.4% |
| 16 | default | BAAB | 122.2 / 30.2 | 92.5 / 24.0 | +32.0% / +25.8% | 138.9 / 45.6 | -12.1% / -33.8% |
| 1008 | default | ABBA | 544.7 / 28.0 | 412.9 / 22.4 | +31.9% / +24.7% | 541.9 / 41.6 | +0.5% / -32.7% |
| 1008 | default | BAAB | 547.6 / 28.2 | 413.5 / 22.4 | +32.4% / +26.1% | 539.4 / 41.4 | +1.5% / -31.8% |
| 16384 | 512 MiB | ABBA | 466.1 / 25.7 | 349.9 / 19.9 | +33.2% / +28.8% | 463.5 / 37.4 | +0.6% / -31.3% |
| 16384 | 512 MiB | BAAB | 456.8 / 25.0 | 344.6 / 20.6 | +32.6% / +21.4% | 461.7 / 36.9 | -1.1% / -32.1% |
| 50000 | 512 MiB | ABBA | 393.0 / 22.9 | 305.4 / 16.7 | +28.7% / +37.4% | 393.9 / 31.3 | -0.2% / -26.8% |
| 50000 | 512 MiB | BAAB | 398.5 / 22.1 | 268.0 / 12.4 | +48.7% / +78.8% | 392.2 / 29.6 | +1.6% / -25.3% |

## Raw runs

- short ABBA: [official](m4-pro-official-gated-short-abba.txt) / [community](m4-pro-gated-short-replay.txt)
- short BAAB: [official](m4-pro-official-gated-short-baab.txt) / [community](m4-pro-gated-short-replay-baab.txt)
- 16384 ABBA: [official](m4-pro-official-gated-16384-abba.jsonl) / [community](m4-pro-gated-16k-replay-cache512.jsonl)
- 16384 BAAB: [official](m4-pro-official-gated-16384-baab.jsonl) / [community](m4-pro-gated-16k-replay-baab-cache512.jsonl)
- 50000 ABBA: [official](m4-pro-official-gated-50000-abba.jsonl) / [community](m4-pro-gated-50k-replay-cache512.jsonl)
- 50000 BAAB: [official](m4-pro-official-gated-50000-baab.jsonl) / [community](m4-pro-gated-50k-replay-baab-cache512.jsonl)

To reproduce, use the [paired-gate benchmark commands](../README.md#reproduce-the-paired-gate-scorecard) with `--snapshot "$OFFICIAL_SNAPSHOT"` and the indicated order. Omit `--free-cache-mib` for the default allocator.

**50,000 tokens, default allocator:** attempted separately. The trial stopped during the first Dari process when free disk fell below the 5 GiB safety floor under swap pressure, before a complete warm pair. No speed ratio is available for this configuration. Historical community-weight uncapped results are not a substitute.
