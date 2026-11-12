<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dari-logo-dark.svg">
    <img src="assets/dari-logo-light.svg" alt="Dari" width="72">
  </picture>
</p>

<h1 align="center">Dari Gateway</h1>

<p align="center">
  <b>One endpoint for your coding agents, on your own keys and subscriptions.</b><br>
  Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses, served on the model your router picks.
</p>

<p align="center">
  <a href="https://docs.dari.dev/gateway/self-hosting"><img src="https://img.shields.io/badge/Self--Host_Guide-docs.dari.dev-111111?style=for-the-badge" alt="Self-host guide at docs.dari.dev"></a>
  <a href="#run"><img src="https://img.shields.io/badge/Quick_Start-Run_It_Locally-16A34A?style=for-the-badge" alt="Quick start: run it locally"></a>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-111111" alt="Apache-2.0 license"></a>
  <img src="https://img.shields.io/badge/runtime-Bun_1.3%2B-111111" alt="Requires Bun 1.3 or later">
</p>

The gateway is the runtime behind Dari's hosted routing service, packaged to run on your own machine. Point a client at it, and each request is served on the model your router picks, using your provider API keys or your connected Claude Code and ChatGPT subscriptions. It needs no Dari account.

## Features

- **One endpoint, three protocols.** `/v1/messages`, `/v1/chat/completions`, and `/v1/responses` (plus `/v1/models`) reach API-key providers in the [Pi AI](https://www.npmjs.com/package/@mupt-ai/pi-ai) catalog, such as Anthropic, OpenAI, and OpenRouter, or any OpenAI-compatible server.
- **Subscription pooling.** Connect several Claude Code (Max/Pro) or ChatGPT plans. Each conversation stays on one plan so its prompt cache stays warm. Claude Code plans report their usage on every response: once a plan has used 95% of a window, its conversations move to another plan at their next turn, and new conversations start on the plan whose quota resets soonest. A plan that reports a usage limit is held until its reset, and the request it refused is served by the next plan at once. When every plan is held, the provider's API key serves if you set one.
- **Failover.** A provider failure retries the router's next model.
- **Prompt-cache aware.** Conversations keep their identity and serving model across turns, so provider caches stay warm. Responses carry `X-Dari-Selected-Model`, `X-Dari-Thinking-Level`, and `X-Dari-Conversation-Id` headers for status lines.
- **Coding agents.** `dari claude`, `dari codex`, `dari opencode`, and `dari pi` from the [Dari CLI](https://github.com/mupt-ai/dari) launch straight against your gateway.

Dari Auto Routing (choosing among a router's models with Dari's trained policy) is optional and needs a Dari API key; without it, `dari/routing` serves the router's first available model.

## Run

> [!IMPORTANT]
> **Observability needs hosted Dari.** Requests through your own gateway never reach Dari, so there is no Activity dashboard, per-request cost, or usage analytics. Use hosted mode (`dari gateway setup --mode hosted`) if you want them.

The easiest way to run it on your own machine is the [Dari CLI](https://github.com/mupt-ai/dari): choose **Fully local** in `dari gateway setup` (or on your first `dari claude`), and it installs this gateway's standalone binary, runs it in the background, and connects your agents.

To run it yourself, use [Bun](https://bun.sh) 1.3 or later, or the standalone binary for your platform from the [releases](https://github.com/mupt-ai/dari/releases). A config file is optional: without `DARI_GATEWAY_CONFIG` or a `dari-gateway.yaml` in the working directory, the gateway serves a default router of current Anthropic and OpenAI models, each once its provider has a subscription or API key. To choose models, write a `dari-gateway.yaml` (start from [`dari-gateway.example.yaml`](dari-gateway.example.yaml)). Then:

```bash
export DARI_GATEWAY_KEYS="$(openssl rand -hex 24)" # keys your clients send
export ANTHROPIC_API_KEY=... OPENAI_API_KEY=...    # optional with subscriptions
bunx @mupt-ai/dari-gateway
```

Or with Docker:

```bash
docker run -p 8080:8080 \
  -e DARI_GATEWAY_KEYS -e ANTHROPIC_API_KEY \
  -v "$PWD/dari-gateway.yaml:/config/dari-gateway.yaml" \
  -v dari-gateway-data:/data \
  ghcr.io/mupt-ai/dari-gateway
```

| Variable | Meaning |
| --- | --- |
| `DARI_GATEWAY_KEYS` | Required. Comma-separated bearer keys clients authenticate with. |
| `DARI_GATEWAY_CONFIG` | Router config file. Default `dari-gateway.yaml`. |
| `DARI_GATEWAY_DB` | SQLite database for subscriptions, model lists saved with `dari gateway models`, and conversation state. Default `dari-gateway.db`. It stores subscription tokens in plaintext; protect it like a secret. |
| `DARI_AUTO_ROUTING_API_KEY` | Optional. Select among a router's models with Dari Auto Routing. |
| `PORT` | Listen port. Default `8080`. |
| `DARI_GATEWAY_HOST` | Listen address. Default `127.0.0.1`, so only this machine can connect. The container image sets `0.0.0.0`; set it yourself to expose a process on your network. |
| Provider keys | Each provider's standard variable, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `META_API_KEY`, or `OPENROUTER_API_KEY`. The gateway checks each key at startup and will not start if a provider rejects one. |

## Configure

```yaml
routers:
  default:                 # serves /v1/...
    models:
      - anthropic/claude-sonnet-5-5
      - id: openai/gpt-6.1-sol
        thinking: [medium, high]
    agentModels:           # optional: a coding agent's own list, in place of `models`
      codex: [openai/gpt-6.1-sol, openai/gpt-6.1-terra]
    subscriptions: true    # prefer connected subscriptions over API keys
    sessionPinning: false  # route each session and subagent once, then keep its model
  local:                   # serves /local/v1/...
    models: [local/qwen3-coder]

providers:                 # endpoints outside the built-in catalog
  local:
    baseUrl: http://localhost:8000/v1
    apiKeyEnv: LOCAL_API_KEY
```

Model ids are `provider/model`. Clients send `model: "dari/routing"` to let the router choose, or `model: "dari/model/<id>"` to pin one of its models. A Claude Code subscription serves Anthropic models only for Claude Code itself; a ChatGPT subscription serves OpenAI models for every client. Each coding agent is offered the router's models that a credential can serve it, or its own `agentModels` list (`claude_code`, `codex`, `muse_code`, `opencode`, `pi`, `openclaw`, `hermes`) when the router has one.

`dari gateway models` changes either list on a running gateway, with any gateway key: `dari gateway models --agent codex openai/gpt-6.1-sol`, or no models for the picker. It calls `PUT` and `DELETE /v1/router/models[/<agent>]` (`GET /v1/router/models` reads them). The gateway saves the list in its database and serves it at once in place of the config file's, until `--reset` removes it.

### Model catalog

`GET /v1/models?detail=1` (any gateway key; optionally `&provider=openrouter,meta`) and `listModelCatalog({ providers?, fetch?, signal? })` list each provider's tool-capable models as `dari/model/<id>`-ready ids with context window, max output tokens, input modalities, accepted thinking levels, and list prices in USD per million tokens (input, output, cache read, cache write, long-context tiers) with `price_as_of`. OpenRouter and Vercel AI Gateway are read live from their public models endpoints; other providers (default: OpenAI, Anthropic, Meta, xAI, Fireworks) come from the bundled Pi catalog.

## Coding agents

```bash
export DARI_GATEWAY_URL=http://localhost:8080
export DARI_GATEWAY_KEY=<one of DARI_GATEWAY_KEYS>

dari credentials subscription connect claude-code   # or codex or muse-code; repeat to pool plans
dari claude
```

In gateway mode the CLI makes no calls to Dari's hosted API, and `dari activity` is unavailable.

## Embed

Deployments with their own storage and accounting compose the runtime with a `GatewayPlatform` (router resolution, conversation state, session pins, subscription holds, request records, error reporting) and a selector backend:

```ts
import { createPrioritySelectorBackend, createRequestHandler } from "@mupt-ai/dari-gateway";

const handler = createRequestHandler({ platform, selectorBackend: createPrioritySelectorBackend() });
Bun.serve({ port: 8080, fetch: handler, idleTimeout: 0 });
```

The root entry needs no Bun APIs, so any runtime with web-standard `fetch`, `Request`, and `Response` can serve the handler. `startServer` and `startSelfHostedGateway` (Bun.serve and bun:sqlite) are in `@mupt-ai/dari-gateway/bun`. `src/self_host/` is the reference platform.

Platforms can also:

- implement `resolveProviderCredential({ provider, model, routerId, organizationId, apiKey, clientHarness? })` to supply a per-request `{ apiKey, baseUrl?, headers?, subscription? }`, such as a tenant's own key, in place of the router's resolved key. With `subscription` (`"openai_codex"`, `"anthropic_claude_code"`, or `"meta_muse"`), `apiKey` is that plan's access token: Codex's `auth.json` `tokens.access_token`, the token `claude setup-token` prints, or the Model API key a Meta sign-in mints. The platform keeps it fresh. Strict routers serve these supplied plans, but never subscriptions the gateway resolved itself. A plan serves only its own provider's models; a Claude Code plan serves only Claude Code clients, and a Muse Code plan only Muse Code clients (recognized by their `x-client-id`);
- resolve routers with `strict: true` to serve only the requested `dari/model/<id>` at the requested thinking level, with no selector, lease, or personal subscription. Set `strict_providers: ["openai"]` on the resolved router to permit any bundled-catalog model from that provider without enumerating `enabled_models`. Use `dari/model/openai/gpt-6.1-sol`; bare IDs and unknown models remain refused. This grant is ignored on non-strict routers and does not discover uncatalogued models;
- resolve routers with `session_pinning: true` to route each session once and serve that pair for the rest of the session. Each subagent (Claude Code agent id, Codex subagent thread, OpenCode child session) is routed once on its own. Pins are kept through `readSessionPin` and `writeSessionPin`, keyed by router and an opaque pin key; background requests and `dari/model/<id>` requests never use them;
- read exact usage from `recordRequest`: the summary carries input, output, cache-read, and cache-write tokens and `total_cost_usd`, preferring the provider's billed cost (`cost_source: "provider"`, from OpenRouter and Vercel AI Gateway). Each record also carries the router's non-secret routing settings as `router` (enabled models, thinking levels, and the strict, speculative-routing, and session-pinning flags). Failed and aborted requests are recorded too;
- attribute cost with `X-Dari-Tags: run=r1,trial=3`, which is parsed into `RequestRecord.tags` and the `recordUsage` payload's `tags`.

## Development

The gateway and router share one workspace at the repository root, so the gateway always runs on the router beside it:

```bash
bun install --frozen-lockfile              # from the repository root
(cd packages/router && bun run build)
cd packages/gateway
bun run typecheck
bun test
```

Tests make no provider or network calls.

## License

[Apache-2.0](LICENSE) © 2026 Mupt AI.
