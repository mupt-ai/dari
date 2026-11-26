# Dari Inference

Run Inkling 2 Mini locally on Apple Silicon. The standalone `dari-inference` command serves the **Dari Metal engine** (`inkling.decode_message_gate.GatedModel`) with the **official Thinking Machines weights**. MLX-LM supplies tokenizer utilities, not the inference model. The server accepts one text chat at a time: streaming or non-streaming, 50,000 tokens including output by default. Function tools work in both streaming and non-streaming requests. Pi executes tools locally and sends their results back to the model. Generation uses the official draft head for speculative decoding. Image inputs are not supported.

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

## Try Pi

Add this entry under `providers` in `~/.pi/agent/models.json`, preserving any existing providers. Match the port and `contextWindow` to your server (e.g. `100000` for the command above).

```json
"dari-metal": {
  "api": "openai-completions",
  "baseUrl": "http://127.0.0.1:8081/v1",
  "apiKey": "local",
  "models": [{"id": "inkling-2-mini", "contextWindow": 50000, "maxTokens": 8192}]
}
```

```sh
pi --model dari-metal/inkling-2-mini
```

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

`dari_engine/catalog.py` is the source of truth for supported model names. A name selects one immutable checkpoint, its family backend, and its default context budget. The CLI and both HTTP APIs use the selected name. Each server process loads only that model and owns its prefix cache; to run two models at once, start them on different ports.

- **Compatible checkpoint:** Add one `Model` entry to `MODELS` with the official `repository`, pinned commit `revision`, existing `backend`, and a tested `context_window`. No Go CLI, command parser, or HTTP changes. Confirm compatibility with the weight layout, kernel dimensions, tokenizer, and message format; sharing a publisher or family name alone is not sufficient.
- **Different architecture:** Add a sibling package to `inkling/` with its own weight mapping, runtime, tokenizer logic, and kernels. Include the package and any shader files in `pyproject.toml`. Use `inkling/backend.py` as the adapter example: `resolve_snapshot(model, install)` checks local files unless explicitly pulling, `max_context(snapshot)` reads the checkpoint limit, and `load(snapshot, context_window)` returns the runtime. `inkling/runtime.py` shows the inference interface: `prompt`, `encode_raw`, and `events`, plus context and cached-token counts. Keep GPU initialization out of catalog imports so `list` and `show` remain lightweight.

Before publishing a new entry, explicitly pull it, disconnect from the network, run `show` and `run`, and verify that `/v1/models` advertises its name and `/v1/chat/completions` returns a real answer with that name. Check prefix reuse, output correctness, and peak memory at the default context length against a reference implementation before claiming performance.
