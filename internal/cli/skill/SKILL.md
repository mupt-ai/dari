---
name: dari
description: Use when the user wants to create, configure, inspect, or call a Dari managed router; work with router specs (`dari router apply`), the Dari CLI/API, provider keys, evals, or routing API keys.
---

# Dari Managed Routers

Dari's managed path lets you define a router in a YAML spec and apply it with the public CLI. The self-hosted framework path is `@mupt-ai/dari-router`; see its [public documentation](https://docs.dari.dev/framework/overview) for framework usage.

## Router Specs

A router spec is a whole router in one file, with no credentials. `dari router get <id> --yaml` prints one; `dari router apply <file>` creates the router, or updates your router with the spec's name (`--router <id>` picks another). Each model is paid for with the person's subscription, then the org's key, then Dari credits, as `payment.allow` permits, and an existing router keeps the choices it already made.

```yaml
name: Opus + DeepSeek Subagents
models:
  - anthropic/claude-opus-5-5
  - id: deepseek-ai/DeepSeek-V4.1-Flash-1017
    thinking: [high]
    provider: opencode-go   # only when not the catalog's default
roles:
  subagent: { model: deepseek-ai/DeepSeek-V4.1-Flash-1017, prompt: Be brief. }
routing:
  session_pinning: false
payment:
  allow: [subscription, key, credits]
hosted:
  speculative_routing: true   # settings only hosted Dari has
```

## Create A Router

Install the CLI and authenticate:

```bash
curl -fsSL https://raw.githubusercontent.com/mupt-ai/dari/main/install.sh | bash
dari auth login
dari router models
```

Write a spec to `router.yaml` and apply it:

```bash
dari router apply ./router.yaml
```

`apply` accepts a file or a directory containing `router.yml` or `router.yaml`; the API parses and validates the spec. Models default to the provider shown by `dari router models`; set a model's `provider` only to serve it elsewhere (a gateway, Bedrock, Azure).

## Provider Keys

A spec carries no credentials. Save provider keys with `dari accounts provider add <provider> <name> --value-stdin`; `payment.allow` decides whether a model may use them. Never commit provider keys or `.env` files.

## Role Models

Dari routes every request by default. Pin the main agent or subagents (including Claude Code workflow agents) to one enabled model with `roles.<role>.model`; a pinned role is served that model directly, whatever model the client asked for. Leave it out to route the role. `roles.<role>.prompt` appends text to the end of that role's system prompt on every request from it. Background requests such as compaction get neither.

```yaml
roles:
  main: { model: anthropic/claude-sonnet-5, prompt: Delegate codebase exploration to subagents. }
  subagent: { model: deepseek-ai/DeepSeek-V4.1-Flash }
```

The same works with flags: `dari router create <name> --model ... --main-model <id> --subagent-model <id> --main-prompt <text>`. On `dari router update`, `--main-model ""` routes the main agent again.

## Routing Instructions

Dari already routes with each model's evals. Optional natural-language rules in `routing.rules` steer it for roles left on routing; a request no rule matches is routed among every enabled model as usual:

```yaml
routing:
  rules:
    - when: planning and architecture
      use: openai/gpt-5.6-sol
      thinking_level: high
```

Limit a model's reasoning levels with its `thinking` list (omitted offers every level).

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

`dari accounts` is the interactive page for subscriptions (plan, usage, renewal, buying another, rename, reconnect, disconnect), API keys, and auto-routing, hosted or on a gateway. Without a terminal, every action on that page has a command that prints JSON:

- Subscriptions: `dari accounts subscription list` (plan, usage windows, holds, `manage_url`), `connect <provider>` (`--reconnect NAME` to reconnect; with no terminal it waits for the browser approval), `rename`, `mark-available`, `disconnect`.
- Banked limit resets (hosted): `dari accounts subscription resets <provider>`, `use-reset <provider> [RESET_ID]`, `auto-reset <provider> on|off`.
- API keys: hosted `dari accounts list` and `dari accounts provider add|update|remove`; local gateway `dari accounts key` (list), `dari accounts key <provider> <api-key|off>`.
- Auto-routing: local gateway `dari accounts auto-routing <dari-api-key|off>`; hosted needs the Autorouting plan, bought in the web app (`dari accounts list` reports `autorouting_allowed`).

Launchers use server-owned router configuration and per-user subscription preferences, not a machine-local setup marker. Codex, Pi, OpenCode, OpenClaw, Hermes Agent, and Muse reuse the organization's configured default router; only an empty default router opens the model picker. Claude discovers its existing personal or managed router by its server-side client key and opens model setup only if that profile is absent. Model changes belong in the dashboard or `dari router update`; moving to another computer must not replace models with launcher presets. Set `DARI_ROUTING_API_KEY` to supply the key explicitly. Set `DARI_GATEWAY_URL` and `DARI_GATEWAY_KEY` to launch through a self-hosted gateway instead; the launch then makes no hosted API calls. Every following argument is forwarded to the selected agent, and Dari's provider/model settings take precedence:

```bash
dari claude --print "Review this diff"
dari codex exec "Fix the failing tests"
dari opencode run "Explain this repository"
dari pi -p "Review this repository"
```

All four launchers show the serving model, thinking level, routing lease turns (or `pinned` on session-pinned routers), and prompt-cache warmth (warm when the last response read cache within five minutes) using shared formatting. OpenCode and Pi use the default router and can connect either a ChatGPT or Claude Code subscription. OpenCode gets session-local config through `OPENCODE_CONFIG_CONTENT` and a private `--standalone` server, so `--server` and `pair` are rejected; use `dari opencode serve` for other clients. Codex 0.162.1+ uses a session-local loopback bridge for interactive sessions: status changes only UI display state, never saved session names. Resume with `dari codex resume`, not the temporary remote URL Codex prints on exit. Set `DARI_CODEX_STATUS=0` to disable the bridge; explicit `--remote` or `--profile`/`-p` and non-interactive commands bypass it. OpenClaw and Hermes Agent run every session through a long-lived gateway, so they route through Dari only once `dari setup openclaw --cli` or `dari setup hermes --cli` has written Dari into the agent's own config; until then their launches are refused. Launches never change any agent's config; `dari setup <agent> --remove` restores the previous default model.

## Inspect, Update, Delete

```bash
dari router list
dari router get <router-id-or-endpoint>
dari router update <router-id-or-endpoint> --model openai/gpt-5.6-sol
dari router delete <router-id-or-endpoint>
```

Set `routing.session_pinning: true` in a spec, or pass `--session-pinning` to `dari router create` or `dari router update`, to route once per session and keep that model for the whole session; each subagent is routed once when it starts. It is off by default; `--session-pinning=false` turns it off on update.

Set `native_compaction: true` in a spec, or pass `--native-compaction` to `dari router create` or `dari router update`, to let Codex compact context server-side with the provider's native compaction; requests carrying compaction state are routed only to models that support it. It is off by default; `--native-compaction=false` turns it off on update.

## Activity

`dari activity` reads routed traffic for the current org. Conversation and step pages hold at most 100; page with `--offset`.

```bash
dari activity people --from <rfc3339> --to <rfc3339>
dari activity conversations --from <rfc3339> --to <rfc3339> --user-id usr_...
dari activity conversations get <conversation_ref> --user-turns   # what the person typed
dari activity request rreq_... [--part client-response|selector-output]
```

## Examples

- Managed-router examples: https://github.com/mupt-ai/dari/tree/main/packages/router/examples/managed
- Router Framework documentation: https://docs.dari.dev/framework/overview
- Router Framework examples: https://github.com/mupt-ai/dari/tree/main/packages/router/examples
- Managed router docs: https://docs.dari.dev/router/create-a-router
