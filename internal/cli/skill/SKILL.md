---
name: dari
description: Use when the user wants to create, configure, inspect, or call a Dari managed router; work with router.yml/router.yaml manifests, the Dari CLI/API, provider keys, evals, or routing API keys.
---

# Dari Managed Routers

Dari's managed path lets you define a router in YAML and create it with the public CLI. The self-hosted framework path is `@mupt-ai/dari-router`; see its [public documentation](https://docs.dari.dev/framework/overview) for framework usage.

## Create A Router

Install the CLI and authenticate:

```bash
curl -fsSL https://raw.githubusercontent.com/mupt-ai/dari/main/install.sh | bash
dari auth login
dari router models
```

Create a `router.yml`:

```yaml
name: Production Router
enabled_models:
  - openai/gpt-5.6-sol
  - anthropic/claude-sonnet-5
provider_key_sources:
  openai: managed
  anthropic: managed
routing_strategy: dari
```

Create it:

```bash
dari router create ./router.yml
```

The command accepts a file or a directory containing `router.yml` or `router.yaml`. The CLI strictly parses and validates the manifest before sending it to the managed API.

Models default to the provider shown by `dari router models`; the CLI resolves those defaults from the model catalog during create. Bind a model to a different provider with `model_providers` (when present, it must cover every enabled model):

```yaml
enabled_models:
  - openai/gpt-5.6-sol
  - zai-org/GLM-5.3
model_providers:
  openai/gpt-5.6-sol: openai
  zai-org/GLM-5.3: fireworks
```

## Provider Keys

Use Dari-managed keys when available:

```yaml
provider_key_sources:
  openai: managed
```

For BYOK, read the value from the local environment instead of committing it:

```yaml
provider_key_sources:
  fireworks: user
provider_key_envs:
  fireworks: FIREWORKS_API_KEY
```

```bash
export FIREWORKS_API_KEY=fw_...
dari router create ./router.yml
```

Never commit provider keys or `.env` files.

## Custom Rules

Use `routing_strategy: custom` and `custom_config` for natural-language routing rules:

```yaml
routing_strategy: custom
custom_config:
  rules:
    - when: planning and architecture
      use: openai/gpt-5.6-sol
      thinking_level: high
  default: deepseek-ai/DeepSeek-V4.1-Flash
  default_thinking_level: off
```

When `model_thinking_levels` is present, it must list every enabled model:

```yaml
model_thinking_levels:
  openai/gpt-5.6-sol: [low, medium, high]
  deepseek-ai/DeepSeek-V4.1-Flash: [off]
```

## Evals

Dari automatically picks the relevant evals for each request from your organization's evals and Public Evals. Evals are not selected on a router.

Create an organization scorecard from a CSV whose first two columns are `model_id,score`. Optional columns are `thinking_level`, `notes`, and `metadata_json`:

```bash
dari eval create --name "SWE-bench Verified" --file scores.csv
```

Each `(model_id, thinking_level)` pair must be unique. Use `--file -` to read the CSV from standard input.

`model_id` values must be the exact provider-prefixed IDs from the router model catalog — run `dari router models` first and copy IDs from its output. Do not invent aliases, bare provider names, or IDs the catalog does not list:

```csv
model_id,score,thinking_level,notes
openai/gpt-5.6-sol,87,high,Strong public run
anthropic/claude-fable-5,81,,Generic score
```

List scorecards with:

```bash
dari eval list
```

## Call A Router

Create a routing API key and use the endpoint returned by `dari router get`:

```bash
dari api-keys create --name app --type routing
export DARI_ROUTING_API_KEY=dari_...

curl https://routing.dari.dev/rtr_.../chat/completions \
  -H "Authorization: Bearer $DARI_ROUTING_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dari/routing",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

The response is OpenAI-compatible and includes `dari_routing` metadata with the selected model and reasoning effort.

## Launch A Coding Agent

Use an installed local coding agent through Dari:

```bash
dari claude
dari codex
dari opencode
dari pi
dari openclaw
dari hermes
```

Launchers use server-owned router configuration and per-user subscription preferences, not a machine-local setup marker. Codex, Pi, OpenCode, OpenClaw, Hermes Agent, and Muse reuse the organization's configured default router; only an empty default router opens the model picker. Claude discovers its existing personal or managed router by its server-side client key and opens model setup only if that profile is absent. Model changes belong in the dashboard or `dari router update`; moving to another computer must not replace models with launcher presets. Set `DARI_ROUTING_API_KEY` to supply the key explicitly. Set `DARI_GATEWAY_URL` and `DARI_GATEWAY_KEY` to launch through a self-hosted gateway instead; the launch then makes no hosted API calls. Every following argument is forwarded to the selected agent, and Dari's provider/model settings take precedence:

```bash
dari claude --print "Review this diff"
dari codex exec "Fix the failing tests"
dari opencode run "Explain this repository"
dari pi -p "Review this repository"
```

All four launchers show the serving model, thinking level, routing lease turns (or `pinned` on session-pinned routers), and prompt-cache warmth (warm when the last response read cache within five minutes) using shared formatting. OpenCode and Pi use the default router and can connect either a ChatGPT or Claude Code subscription. OpenCode gets session-local config through `OPENCODE_CONFIG_CONTENT` and a private `--standalone` server, so `--server` and `pair` are rejected; use `dari opencode serve` for other clients. Codex 0.162.1+ uses a session-local loopback bridge for interactive sessions: status changes only UI display state, never saved session names. Resume with `dari codex resume`, not the temporary remote URL Codex prints on exit. Set `DARI_CODEX_STATUS=0` to disable the bridge; explicit `--remote` or `--profile`/`-p` and non-interactive commands bypass it. OpenClaw and Hermes Agent run every session through a long-lived gateway, so `dari openclaw` and `dari hermes` write Dari into the agent's own config (as `--setup` does) before launching; `--remove-setup` restores the previous default model.

## Inspect, Update, Delete

```bash
dari router list
dari router get <router-id-or-endpoint>
dari router update <router-id-or-endpoint> --model openai/gpt-5.6-sol
dari router delete <router-id-or-endpoint>
```

Set `session_pinning: true` in `router.yml`, or pass `--session-pinning` to `dari router create` or `dari router update`, to route once per session and keep that model for the whole session; each subagent is routed once when it starts. It is off by default; `--session-pinning=false` turns it off on update.

## Examples

- Managed-router manifests: https://github.com/mupt-ai/dari/tree/main/packages/router/examples/managed
- Router Framework documentation: https://docs.dari.dev/framework/overview
- Router Framework examples: https://github.com/mupt-ai/dari/tree/main/packages/router/examples
- Managed router docs: https://docs.dari.dev/router/create-a-router
