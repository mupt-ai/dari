# Dari Inference

Run Inkling 2 Mini locally on Apple Silicon. The standalone `dari-inference` command serves the **Dari Metal engine** (`dari_engine.engines.inkling.decode_message_gate.GatedModel`) with the **official Thinking Machines weights**. MLX-LM supplies tokenizer utilities, not the inference model. The server accepts one text chat at a time: streaming or non-streaming, 50,000 tokens including output by default. Function tools work in both streaming and non-streaming requests. Pi executes tools locally and sends their results back to the model. Generation uses the official draft head for speculative decoding. Image inputs are not supported.

## Start the server

From `inference/` on an Apple Silicon Mac with `uv`:

```sh
./dari-inference install   # Once: install the runtime and fetch the official text weights
./dari-inference           # Start the optimized engine offline on port 8081
```

No Go CLI, snapshot path, or shell variables needed. Starting never installs anything and never falls back to community weights. `./dari-inference inkling-2-mini` explicitly selects the same model. If you already have the runtime and a local checkpoint, use `./dari-inference --snapshot /path/to/checkpoint`. Override the port with `--port`. Keep this unauthenticated server on loopback.

To use a different total window, pass it at startup, for example `./dari-inference --context-window 100000`. The server enforces the checkpoint’s maximum and reports its default `context_window` at `GET /v1/models`. The official-weight benchmarks on the M4 Pro cover up to 50,000 tokens; a larger setting is not a guarantee it will fit in memory.

## Dari CLI and native HTTP API

```sh
./dari-inference pull inkling-2-mini    # Only if the weights are missing
./dari-inference run inkling-2-mini     # Start the API on port 8081
```

`run` serves the installed model in the foreground. No separate `serve` step or terminal chat client is needed. Send requests from Pi or another HTTP client. Use `list` to see installed models and `show inkling-2-mini` to inspect the weights and model limit.

```sh
curl http://127.0.0.1:8081/api/generate -d '{"model":"inkling-2-mini","prompt":"What is 12 times 7?","options":{"num_ctx":100000},"stream":false}'
```

`POST /api/chat` takes `messages` instead of `prompt`. Both native endpoints stream newline-delimited JSON by default. `num_ctx` overrides the server default for that request; `num_predict` caps output. These endpoints currently support text, not the entire Ollama API: registry operations, Modelfiles, structured output, images, and native tool calls are not implemented. For function tools use `/v1/chat/completions`.

## Local coding harnesses

With the harness installed, run these from your project directory:

```sh
dari pi --include-local               # choose the route for this session
# or: dari claude --include-local

# Noninteractive alternative:
dari pull inkling-2-mini              # once per CLI release; reuses cached weights
dari pi --local inkling-2-mini        # no separate `dari run` needed
# Or: dari codex --local inkling-2-mini exec 'Explain this project'
```

The `--include-local` launch picker offers normal routing, each supported local model, and **Set Up a Local Model**. Opening the picker does not probe a listener, sign in, or download anything. Choose **Pull … and Launch** to explicitly install, or choose a model directly to use existing weights or an SSH-forwarded engine. The route applies to one launch; this does not mix providers inside the harness’s `/model` menu or change future defaults.

`--local MODEL` goes immediately after `pi`, `codex`, `claude`, `opencode`, `muse`, `openclaw`, or `hermes`. Without it, the harness launches exactly as before. Native arguments follow the model. `--local` elsewhere is not interpreted by Dari.

Dari first checks loopback port 8081 (`DARI_INFERENCE_PORT` to override). It borrows a server advertising the requested model, or starts a private copy on a free port when no engine is running or the model differs. Quitting stops only processes this launch started. For shared prefix caching across launches, leave `dari run inkling-2-mini` running. To borrow an engine on another machine, forward its port first, e.g. `ssh -N -L 8081:127.0.0.1:8081 user@other-mac`.

No hosted router or account is needed. The release's `pull` also installs a matching protocol bridge for Codex, Claude Code, and Muse: only those sessions start it, on loopback, with one upstream and no hosted credentials. A source build can use a locally compiled `dari-gateway` via `DARI_INFERENCE_GATEWAY`. OpenClaw and Hermes use temporary agent profiles; their profile-local history and settings are not retained. Hermes requires at least 64,000 tokens; a private Hermes engine defaults to that size, and an existing shared server must already have a sufficient context window.

Run Pi from the project you want it to work on. For example, ask it to read a file, edit it, and run its tests. This gives Pi its normal local permissions; for read-only review, start it with `--tools read,grep,find,ls`. The model server never executes commands itself.

Pi handles history compaction itself; no extension is needed. For long coding sessions, merge this model-specific entry into `compaction.modelOverrides` in `~/.pi/agent/settings.json`:

```json
"dari-metal/inkling-2-mini": {"reserveTokens": 18000, "keepRecentTokens": 6000}
```

With automatic compaction enabled, Pi begins summarizing history above `contextWindow - reserveTokens`: 32,000 estimated tokens with the default window, or 82,000 with a 100,000-token window. `maxTokens` is a ceiling, not a guarantee: input and output share the configured window. Pi can compact and retry a context-limited response, but a single response that exhausts its full output allowance can still end with `length`. Incomplete tool calls are never executed.

The chat endpoint accepts OpenAI function declarations and `tool_choice: auto` (default) or `none`. It returns validated calls with IDs, including multiple calls in one turn. Send each result back with role `tool` and the matching `tool_call_id`. An incomplete or undeclared call is never sent for execution. Forced tool choice and multimodal tool results are not supported.

Or send a request directly:

```sh
curl --fail-with-body http://127.0.0.1:8081/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"inkling-2-mini","messages":[{"role":"user","content":"What is 8 times 7?"}],"temperature":0,"max_tokens":64}'
```

## Prefix caching

The server retains model state in memory across requests; clients still send the full conversation. Inspect `usage.prompt_tokens_details.cached_tokens` to see how many input tokens skipped prefill. For streaming, request `stream_options: {"include_usage": true}`. The total prompt count still includes cached input.

One active conversation is retained, with checkpoints at the decoded tip, the original prompt, and a preceding prefill boundary when available. Only exact token prefixes are reused. This lets a tool result reuse the previous prompt even if Pi reformats the assistant’s tool call. An edit before all retained checkpoints, switching to an unrelated prompt, or restarting the process causes a cold prefill. No cache is written to disk.

## Speculative decoding

The checkpoint ships a draft head (`mtp.safetensors`, fetched by `install` and `pull`). Each round it proposes up to seven tokens from the target's hidden states, and the target checks them in one forward pass: it keeps the proposals that match its own choice, then adds its next token. Greedy output follows the target's own choices, except where batched and single-token kernels round a near-tie differently; sampling uses rejection sampling, so the output distribution is the target's.

The server picks each round's draft depth from measured round times and acceptance, so text the draft predicts well gets deeper proposals and long contexts get shallower ones. A client that stops mid-round keeps a prefix cache that matches exactly what it received.

## Weights, implementation and benchmarks

- [Official checkpoint](https://huggingface.co/thinkingmachines/Inkling-2-Mini/tree/c9d028302cd0f035fdf8e7e91f089a4ce94d2195). The example above pins this revision. Serving another architecture requires an engine implementation.
- [Engine internals and direct Python usage](INDEPENDENT.md). The engine also accepts the MLX Community 4-bit layout, but it is not the checkpoint used in the quickstart.
- [Benchmark protocols](benchmarks/README.md) and [official-weight performance results](benchmarks/results/official-weights.md). These measure engine execution, not HTTP or Pi overhead.
- [Narrated optimization walkthrough](docs/explainer/README.md).

## Add a model

Each engine lives in `dari_engine/engines/<engine>/`. Start with [Inkling](dari_engine/engines/inkling/models.json): its `models.json` declares the public model ID, official repository, pinned revision, Python adapter module, and default context window. The Python runtime discovers these manifests and the Go launcher embeds the same files for offline setup. No second model list or harness-specific registration is needed.

- **New architecture:** Create a Python package (including `__init__.py`) under `engines/`. Put its adapter, checkpoint loader, tokenizer, cache, runtime, and kernels there. Follow [the adapter](dari_engine/engines/inkling/backend.py): `resolve_snapshot(model, install)` must stay offline unless explicitly pulling; `max_context(snapshot)` reads the weight limit; `load(snapshot, context_window)` creates the runtime. See [the runtime](dari_engine/engines/inkling/runtime.py) for the shared HTTP contract. Manifests and `metal/*.metal` ship automatically; declare any other asset formats or new dependencies in `pyproject.toml`.
- **Compatible checkpoint:** Add another model ID to the same manifest only after verifying its weight layout, tokenizer, and kernel dimensions. Point it at the same adapter if it needs no new engine code.
- **Shared services:** Keep model-specific code out of `dari_engine/server.py`, the transport handlers, and the harness launchers. One server process serves one model and owns its prefix cache.

Before publishing a new entry, explicitly pull it, disconnect from the network, run `show` and `run`, and verify that `/v1/models` advertises its name and `/v1/chat/completions` returns a real answer with that name. Check prefix reuse, output correctness, and peak memory at the default context length against a reference implementation before claiming performance.
