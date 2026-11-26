# Running the benchmarks

Candidate Metal implementations live in [`experiments/metal/`](../experiments/metal/); the benchmark runners load them from there. For the model kernels and a guide to their launchers, see [`dari_engine/engines/inkling/metal/`](../dari_engine/engines/inkling/metal/README.md).

Run commands from `inference/` in the environment described in [the engine guide](../INDEPENDENT.md). Keep the M4 Pro free of other GPU work. The model harnesses acquire a process lock. Select `ours` or `reference` in separate processes; the reference uses MLX-LM. The `direct_full` runner selects only an independent engine variant, not different inputs or decoding rules.

For a publishable comparison, acquire the GPU for all four subprocesses. This prevents another local model job from running between arms. The launcher never changes the measured loops. It opens a **new** log, retains partial evidence if a process fails, and prints a scored result only after the completeness checks pass.

```sh
.venv/bin/python -m benchmarks.run_comparison short /tmp/inkling-short.txt --engine direct --order ABBA
.venv/bin/python -m benchmarks.run_comparison long /tmp/inkling-50k.jsonl --engine direct --length 50000 --order BAAB
```

The lease covers cooperating benchmark tools on this machine, not other apps or system memory pressure. Keep allocator diagnostics and fixed-trajectory replays in separate logs.

| Question | Entry point | What counts |
| --- | --- | --- |
| Is the model faster on short and medium prompts? | `python -m benchmarks.bench_independent reference` and `python -m benchmarks.direct_full bench_independent ours` | Alternate processes ABBA or BAAB. Discard each process’s first pass. Report prefill and decode separately for each length. |
| What happens at 50,000 tokens? | `python -m benchmarks.long_context reference --runs 2` and `python -m benchmarks.direct_full long_context ours --runs 2` | Fresh KV for each run; match chunk size, allocator options, and greedy vs replay mode. Save JSONL from all four processes in run order. |
| Did predictions change? | `eval_teacher`, `eval_teacher ours --long`, `eval_unseen`, `direct_full heldout_register ours --length 32768` | Compare both arms on the same prompts and target tokens. Top-1 agreement and mean target NLL measure different things. The register case tests one long-range correction, not general long-context accuracy. |
| Can I verify without model weights? | `report_short_context`, `report_long_context`, `report_held_out` | These read saved raw records and reject incomplete comparisons. See the scorecard for exact invocations. |

`bench_*`, `profile_*`, and `run_*` experiments isolate individual mechanisms. A kernel time is not end-to-end throughput. Optional native and ANE comparisons may require additional build tools. None is used by the core model at import time.

The short report also lists the zero-based first greedy-token difference for each warm pair (`null` means all 64 predictions matched). If generation diverges, the subsequent decode inputs no longer match: do not treat those rates as proof of matched-trajectory performance.

To hold every decode input constant, pass `--replay-reference benchmarks/results/m4-pro-direct-abba.txt` to the short launcher. Both engines still run an argmax and synchronize each step, but consume the same recorded reference token next. The report verifies all four processes used the same trace digest. This is a throughput control, not free-running generation or a held-out quality test.

## Reproduce the paired-gate scorecard

Use a fresh output path each time. Replace `ABBA` with `BAAB` and change the output name to reverse process order. The recorded greedy files only supply input tokens; rates are always measured anew.

```sh
P=.venv/bin/python
$P -m benchmarks.run_comparison short /tmp/gated-short.txt --engine gated --order ABBA --replay-reference benchmarks/results/m4-pro-direct-abba.txt
$P -m benchmarks.run_comparison long /tmp/gated-16k.jsonl --engine gated --order ABBA --length 16384 --free-cache-mib 512 --replay-reference benchmarks/results/m4-pro-fused-16k-greedy-cache512.jsonl
$P -m benchmarks.run_comparison long /tmp/gated-50k.jsonl --engine gated --order ABBA --length 50000 --free-cache-mib 512 --replay-reference benchmarks/results/m4-pro-direct-50k-greedy-cache512.jsonl
$P -m benchmarks.fused_full eval_teacher ours --gated --cases benchmarks/fixtures/post-gate-holdout.json > /tmp/held-ours.jsonl
$P -m benchmarks.eval_teacher reference --cases benchmarks/fixtures/post-gate-holdout.json > /tmp/held-ref.jsonl
$P -m benchmarks.report_held_out --prompts 6 --positions 74 /tmp/held-ref.jsonl /tmp/held-ours.jsonl
```
