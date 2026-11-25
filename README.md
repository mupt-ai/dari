<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dari-logo-dark.svg">
    <img src="assets/dari-logo-light.svg" alt="Dari" width="72">
  </picture>
</p>

<h1 align="center">Dari</h1>

<p align="center">
  <b>Use multiple models with the coding agents you already use.</b><br>
  Route between models, pool multiple subscriptions, and connect your own provider API keys.
</p>

<p align="center">
  <a href="https://docs.dari.dev"><img src="https://img.shields.io/badge/Documentation-docs.dari.dev-111111?style=for-the-badge" alt="Documentation at docs.dari.dev"></a>
  <a href="https://github.com/mupt-ai/dari/releases/latest"><img src="https://img.shields.io/github/v/release/mupt-ai/dari?style=for-the-badge&label=Download&color=16A34A" alt="Latest release"></a>
</p>

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/mupt-ai/dari/main/install.sh | bash
```

## Get Started

Install your preferred coding agent, then launch it through Dari:

```bash
dari claude
# Or: dari codex, dari opencode, dari pi, dari openclaw, dari hermes
```

The first launch asks where agents route, signs you in if needed, and offers to connect your Claude Code or ChatGPT subscription. No server setup is required for hosted Dari, the default.

## How It Works

Dari sits between your coding agent and the model providers. Your agent still handles files, tools, and terminal commands; Dari routes its model requests and returns responses in the protocol the agent expects.

With automatic routing, Dari chooses an eligible model and reasoning level for each request. You can also pick a model using the agent's `/model` command.

## Use Your Agent

Every argument after the agent name is passed through:

```bash
dari claude --print "Review this diff"
dari codex exec "Fix the failing tests"
```

The agent must be on `PATH`, or set `DARI_<AGENT>_PATH`. Supported status lines show the serving model, thinking level, and lease turns left (turns before the routing choice is reconsidered).

**Another organization.** A launch runs in your current organization, which `dari org switch` changes for every command. `--org <slug or ID>` runs one launch in another of your organizations and leaves the current one, and the agent run directly, as they are:

```bash
dari codex --org acme --router rtr_123 exec "Fix the failing tests"
```

Without `--router` the launch uses that organization's router for the agent. `--org` uses your browser sign-in on hosted Dari, so it does not go with `DARI_API_KEY`, `DARI_ROUTING_API_KEY`, a gateway, or `--default`. OpenClaw and Hermes Agent route on their own setup, so they do not take it.

**Running the agent directly.** A launch routes only its own session and leaves the agent's config alone. `dari setup <agent> --cli` (for `claude`, `codex`, `pi`, or `opencode`) writes Dari into that agent's own config, so running it without `dari` routes the same way, then exits. The config follows `dari gateway setup` between routing modes and keeps your last `/model` choice while that model remains available; rerun it after changing the router's models. Codex 0.156 or newer is the exception on gateways new enough to serve it its own list: it reads its `/model` list from the router and keeps it current while it runs (after its next turn, or within five minutes). `dari setup codex --refresh` updates it at once, on any gateway. `dari setup <agent> --remove` undoes it and restores what was there. A local gateway must be running for direct runs: `dari gateway start`.

**Desktop apps.** `dari setup claude --desktop` writes Dari into the Claude app's config; pass `--cli --desktop` to set up `claude` and the app. The Codex app reads the same `config.toml` as `codex`, so either flag sets up both. OpenClaw and Hermes Agent route only through this setup, since their long-lived gateways read their own config: `dari openclaw` and `dari hermes` refuse to start until `dari setup <agent> --cli` has run. Muse Code has no setup: it fetches its model list from its endpoint's root, so it routes only through `dari muse`.

## Pool Multiple Subscriptions

Connect multiple Claude Code or ChatGPT accounts instead of switching accounts manually when one runs out of usage:

```bash
dari accounts
```

Choose **Add a subscription** for each account you want to connect. You can connect more than one account per provider.

- **Keep conversations on one account** to preserve its prompt cache while capacity is available.
- **Switch accounts automatically** when a subscription hits a usage limit, retrying the request on another available account.
- **See your connected plans and usage** in `dari accounts`, where you can also add provider API keys and configure automatic routing.

Subscription restrictions still apply: Claude Code subscriptions serve Claude Code only; ChatGPT subscriptions can serve other supported agents. Pooling does not remove provider usage limits. See [subscriptions](https://docs.dari.dev/gateway/subscriptions) for account selection and fallback details.

For scripts, connect each account separately and list the pool:

```bash
dari accounts subscription connect claude-code   # repeat for another Claude account
dari accounts subscription connect codex         # repeat for another ChatGPT account
dari accounts subscription list
```

## Choose Where Requests Go

Hosted Dari is the default; no server setup is required. To change modes or check your current choice:

```bash
dari gateway setup
dari gateway status
```

You can also run fully locally or connect to a gateway your team hosts. Switching modes updates agents already configured with Dari. Accounts stay with the mode in which you connected them.

Activity, per-request costs, and usage analytics are available only in hosted mode. Local and self-hosted requests do not go through hosted Dari and are not recorded there.

See the [gateway quickstart](https://docs.dari.dev/gateway/quickstart) for local setup and the [self-hosting guide](https://docs.dari.dev/gateway/self-hosting) for running your own server. A local gateway uses credentials saved through `dari accounts`, not provider keys exported in your shell. Automatic routing in local mode requires a Dari API key.

## Manage Routers and Activity

These use the hosted Dari API. Sign in with `dari auth login`, or set `DARI_API_KEY` to a Management key for CI.

```bash
dari router list
dari router apply ./router.yaml
dari accounts provider add openrouter "OpenRouter" --value-stdin
dari activity overview --from 2026-07-01T00:00:00Z --to 2026-07-08T00:00:00Z
dari eval create --name "SWE-bench" --min-score 0 --max-score 100 --file scores.csv
dari api-keys create
```

Run `dari <command> --help` for every flag, and `dari --skill` for instructions a coding agent can follow. Full guides are at [docs.dari.dev](https://docs.dari.dev).

## Libraries and Development

Building your own integration? This repository also includes the [Dari Gateway](packages/gateway) and [router framework](packages/router), each with its own setup and usage guide. You do not need to install either package separately to use the CLI.

All three ship at one version; see [RELEASING.md](RELEASING.md).

```bash
go test ./... && go build ./cmd/dari
bun install
(cd packages/router && bun run build && bun test)
(cd packages/gateway && bun test)
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE) © 2026 Mupt AI.

## Local Inference (Apple Silicon)

Dari runs supported models on its own optimized Metal engine. No Ollama client, daemon, hosted account, or API key is involved.

```sh
dari pull inkling-2-mini       # Explicit download; skip if already installed
dari run inkling-2-mini        # Start the local model API on port 8081
```

`run` keeps the model server in the foreground until you stop it with Ctrl-C. No separate `serve` step or terminal chat client is needed. Use `dari list` to see installed models and `dari show inkling-2-mini` to inspect the weights and context limit. Only `pull` installs or downloads. To configure a larger context, start with `dari run inkling-2-mini --context-window 100000` (or set `DARI_CONTEXT_LENGTH`); 50,000 is the benchmarked default.

On Apple Silicon, install `uv` first (`brew install uv`). The first `dari pull` installs the [Python/Metal runtime](inference/README.md) from the same public Git tag as the CLI, then fetches the official weights. After a CLI upgrade, pull again to install the matching runtime; cached weights are reused. No PATH changes are needed. For a development build, set `DARI_INFERENCE_SOURCE` to the absolute path of `inference/` in this checkout. The standalone runtime works without the Go CLI. Pi can connect to `http://127.0.0.1:8081/v1`; native text clients can post to `/api/chat` or `/api/generate` on the same server.
