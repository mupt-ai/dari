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

**Running the agent directly.** Each launch of `claude`, `codex`, `pi`, or `opencode` also writes Dari into that agent's own config, so running it without `dari` routes the same way. The config follows your routing setup and remembers your last `/model` choice while that model remains available. `dari <agent> --remove-setup` undoes the change and restores what was there. A local gateway must be running for direct runs: `dari gateway start`.

**Desktop apps.** `dari claude --setup` and `dari codex --setup` write Dari into the Claude and Codex apps' config; `--remove-setup` undoes it. OpenClaw and Hermes Agent always use this setup, since their long-lived gateways read their own config.

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
dari credentials subscription connect claude-code   # repeat for another Claude account
dari credentials subscription connect codex         # repeat for another ChatGPT account
dari credentials subscription list
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
dari router create ./router.yml
dari credentials provider add openrouter "OpenRouter" --value-stdin
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
