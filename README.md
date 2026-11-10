<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dari-logo-dark.svg">
    <img src="assets/dari-logo-light.svg" alt="Dari" width="72">
  </picture>
</p>

<h1 align="center">Dari</h1>

<p align="center">
  <b>Run your coding agents through Dari: hosted, fully local, or on your own server.</b><br>
  The Dari CLI, the self-hostable Dari Gateway, and the Dari router framework, released together.
</p>

<p align="center">
  <a href="https://docs.dari.dev"><img src="https://img.shields.io/badge/Documentation-docs.dari.dev-111111?style=for-the-badge" alt="Documentation at docs.dari.dev"></a>
  <a href="https://github.com/mupt-ai/dari/releases/latest"><img src="https://img.shields.io/github/v/release/mupt-ai/dari?style=for-the-badge&label=Download&color=16A34A" alt="Latest release"></a>
</p>

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/mupt-ai/dari/main/install.sh | bash
```

Set `DARI_INSTALL_DIR` to install elsewhere, or download an archive from [Releases](https://github.com/mupt-ai/dari/releases). `dari update` updates it.

## What's Here

| Path | What it is | Distribution |
| --- | --- | --- |
| [`cmd/`](cmd), [`internal/`](internal) | The `dari` CLI | Release archives, `install.sh` |
| [`packages/gateway`](packages/gateway) | The Dari Gateway: one endpoint for Anthropic and OpenAI protocols, with subscription pooling and failover | [`@mupt-ai/dari-gateway`](https://www.npmjs.com/package/@mupt-ai/dari-gateway), release binaries, `ghcr.io/mupt-ai/dari-gateway` |
| [`packages/router`](packages/router) | The router framework: model selection, leases, cache-aware cost | [`@mupt-ai/dari-router`](https://www.npmjs.com/package/@mupt-ai/dari-router) |

All three ship at one version; see [RELEASING.md](RELEASING.md).

## Coding Agents

```bash
dari claude      # also: codex, opencode, pi, openclaw, hermes
```

The first launch asks where agents route, signs you in if needed, and offers to connect your Claude Code or ChatGPT subscription. Every argument after the agent name is passed through:

```bash
dari claude --print "Review this diff"
dari codex exec "Fix the failing tests"
```

The agent must be on `PATH`, or set `DARI_<AGENT>_PATH`. Status lines show the serving model, thinking level, and lease turns left.

**Running the agent directly.** Each launch of `claude`, `codex`, `pi`, or `opencode` also writes Dari into that agent's own config, so running it without `dari` routes the same way. Each launch refreshes that config, so it follows `dari gateway setup`. Each launch starts on the model you last picked with the agent's `/model`, while the router still offers it. `dari <agent> --remove-setup` undoes the change and restores what was there. A local gateway must be running for direct runs: `dari gateway start`.

**Desktop apps.** `dari claude --setup` and `dari codex --setup` write Dari into the Claude and Codex apps' config; `--remove-setup` undoes it. OpenClaw and Hermes Agent always use this setup, since their long-lived gateways read their own config.

**Subscriptions.** Connect several plans per provider to pool them. Routing stays on one until it hits its limit, then moves on:

```bash
dari credentials subscription list
dari credentials subscription connect claude-code   # or codex
```

## Where Agents Route

`dari gateway setup` picks the mode; `dari gateway status` shows it.

> [!IMPORTANT]
> **Observability needs Hosted.** Activity, per-request costs, and usage analytics only exist for requests that go through hosted Dari. Local and self-hosted gateways keep requests off Dari, so none of that is recorded.

| Mode | What runs where | Activity & team features |
|---|---|---|
| **Hosted** (default) | Dari runs the gateway. | Yes: Activity, team sharing, Dari billing. |
| **Fully local** | The CLI runs the gateway on `127.0.0.1:7340`, matching the CLI's version. Requests go straight to providers, using only keys saved on its Accounts page, never keys exported in your shell. | No. `dari activity` and request costs are unavailable. |
| **Self-hosted** | Your team runs the gateway. Set its URL and one of its `DARI_GATEWAY_KEYS`. | No. Requests never reach Dari. |

A local gateway serves only subscriptions and provider keys saved with `dari gateway accounts` (Anthropic, OpenAI, DeepSeek, xAI, Meta, and Fireworks), never keys exported in your shell.

`DARI_GATEWAY_URL` and `DARI_GATEWAY_KEY` override the saved choice for one shell. In gateway modes, launchers make no hosted API calls.

```bash
dari gateway start | stop | restart | logs
dari gateway accounts                     # connect subscriptions, save provider keys
dari gateway models                        # choose the local gateway's models
dari gateway auto-routing <dari-api-key>   # route with Dari's policy; `off` disables
```

## Hosted Commands

These use the hosted Dari API. Sign in with `dari auth login`, or set `DARI_API_KEY` to a Management key for CI.

```bash
dari router list | get | create | update | delete
dari router create ./router.yml
dari credentials provider add openrouter "OpenRouter" --value-stdin
dari activity overview --from 2026-07-01T00:00:00Z --to 2026-07-08T00:00:00Z
dari eval create --name "SWE-bench" --min-score 0 --max-score 100 --file scores.csv
dari api-keys create
```

Run `dari <command> --help` for every flag, and `dari --skill` for instructions a coding agent can follow. Full guides are at [docs.dari.dev](https://docs.dari.dev).

## Development

```bash
go test ./... && go build ./cmd/dari
bun install
(cd packages/router && bun run build && bun test)
(cd packages/gateway && bun test)
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE) © 2026 Mupt AI.
