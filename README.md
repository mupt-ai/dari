<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/dari-logo-dark.svg">
    <img src="assets/dari-logo-light.svg" alt="Dari" width="72">
  </picture>
</p>

<h1 align="center">Dari CLI</h1>

<p align="center">
  <b>Create routers, manage credentials and keys, and launch coding agents through Dari.</b><br>
  The command-line client for Dari routers, credentials, API keys, organizations, and evals.
</p>

<p align="center">
  <a href="https://docs.dari.dev"><img src="https://img.shields.io/badge/Documentation-docs.dari.dev-111111?style=for-the-badge" alt="Documentation at docs.dari.dev"></a>
  <a href="https://github.com/mupt-ai/dari-cli/releases/latest"><img src="https://img.shields.io/github/v/release/mupt-ai/dari-cli?style=for-the-badge&label=Download&color=16A34A" alt="Latest release"></a>
  <a href="https://startupscores.com/open-source/dari"><img src="https://startupscores.com/badge/dari.svg?style=shield&amp;v=combo&amp;theme=dark" alt="Dari on StartupScores" /></a>
</p>

<p align="center">
  <a href="#install">Install</a> · <a href="#sign-in">Sign In</a> · <a href="#coding-agents">Coding Agents</a> · <a href="#self-hosted-gateway">Self-Hosted Gateway</a> · <a href="#common-workflows">Workflows</a>
</p>

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/mupt-ai/dari-cli/main/install.sh | bash
```

To choose another destination:

```bash
curl -fsSL https://raw.githubusercontent.com/mupt-ai/dari-cli/main/install.sh | DARI_INSTALL_DIR="$HOME/bin" bash
```

You can also download a native archive from [Releases](https://github.com/mupt-ai/dari-cli/releases). Update an installed binary with `dari update`. Set `DARI_DISABLE_UPDATE_CHECK=1` to disable update notices.

## Sign In

Interactive commands use browser authentication:

```bash
dari auth login
dari auth status
```

For CI and scripts, set `DARI_API_KEY` to a Management key. It is used as the bearer credential and bypasses cached login state:

```bash
export DARI_API_KEY="dari_..."
dari router list
```

Create Management and Routing keys with `dari api-keys create`. Management keys authenticate CLI and management API operations; Routing keys authenticate requests sent to router endpoints. Keys are shown once, so store them in a secret manager.

## Coding Agents

Launch an installed coding agent through Dari:

```bash
dari claude
dari codex
dari opencode
dari pi
dari openclaw
dari hermes
```

On first launch, Dari signs you in if needed and creates and privately caches one Routing key. Subscription setup runs even if you already used `dari auth login` or have a cached router. Codex asks to connect your ChatGPT subscription, Claude asks to connect your Claude Code subscription, and OpenCode, Pi, OpenClaw, and Hermes Agent offer either a ChatGPT subscription or Dari managed billing. Subscription opt-outs are stored on the server per organization, user, and launcher, so another computer reuses the same choice. If it is not connected to Dari yet, the launcher opens the provider login and finishes the connection before continuing; later launches reuse it automatically. Personal subscriptions are part of Gateway and need no Dari plan. A router that chooses between more than one model or thinking level needs the organization's Autorouting plan; without it, onboarding lets you open the Usage page in the browser, recheck activation, or cancel. A router with one model and one thinking level runs on Gateway. The CLI never purchases a plan for you.

You can connect more than one subscription per provider, such as two Claude Max accounts. Routing uses one until it reaches its usage limit, holds it until its reset, and then stays on the next one in connection order. `dari credentials subscription list` shows which is active and which are held; `dari credentials subscription connect <claude-code|codex>` connects another (`--reconnect NAME` replaces one), `rename <claude-code|codex|NAME> <label>` gives one your own name, and `mark-available` / `disconnect` take a provider alias or, when several are connected, the subscription's name. `dari credentials subscription auto-reset <codex|NAME> on` lets Dari spend that ChatGPT account's banked Codex resets once every ChatGPT subscription is exhausted (off by default).

Launchers fetch router configuration from the server on every launch; machine-local setup markers do not decide whether to configure models. Codex, Pi, OpenCode, OpenClaw, Hermes Agent, and Muse reuse the organization's default router without replacing its configured models or thinking levels with launcher presets. If the default router has no models, initial setup offers the shared model preset. A connected Muse Code plan also opens setup when the router has no directly served Meta model; it preselects Meta models alongside existing models and preserves existing thinking levels. Once configured, other computers reuse that setup. Claude Code discovers its personal or managed router by its server-side client key and only offers model setup when that profile does not exist. New computers reuse existing server configuration. Use the dashboard or `dari router update` to change the shared model configuration. Local storage caches authentication and Routing keys only.

Subscription decisions are also server-owned. Old machine-local opt-outs are no longer used; a user who previously declined subscriptions may need to make that choice once to save it on the server.

Dari then supplies the appropriate router endpoint and `dari/routing` model without overwriting the agent's own configuration, except for [OpenClaw and Hermes Agent](#openclaw-and-hermes-agent). Later launches reuse setup while checking for a connected subscription. Set `DARI_ROUTING_API_KEY` to use an existing Routing key instead. Pi's footer, Claude Code's status line, Codex's footer, and OpenCode's prompt footer show the model serving each turn, its thinking level, turns left on the current routing lease (or `pinned` when the router pins the model per session), and a link to that turn's conversation in the Dari Activity dashboard. All four use the same status formatter.

Codex's footer requires Codex 0.162.1 or newer. Interactive launches use a session-local bridge that reads Dari response headers and updates only the UI's thread-name display; saved session names, resume lists, and routing requests are unchanged. This also affects other thread-name displays in the active UI, such as its terminal title. The bridge uses loopback-only listeners, requires the routing bearer key for HTTP and a separate capability for UI connections, streams responses without buffering, and stops with the launcher. UI reconnects preserve the local app server and active turns. Codex prints its standard remote-disconnect message on exit; its suggested direct reconnect URL expires when Dari exits, so resume with `dari codex resume` instead. Closing the launcher stops its local app server; it does not leave work running in a shared Codex daemon.

Set `DARI_CODEX_STATUS=0` to use Codex without the bridge and keep your existing footer layout. Explicit `--remote` or `--profile`/`-p` launches and non-interactive commands such as `exec` and `review` also keep their original execution path. Dari's interactive footer layout is session-scoped and does not rewrite your Codex configuration.

OpenCode receives its Dari provider, `dari/routing` model, and status plugin through `OPENCODE_CONFIG_CONTENT`, which replaces any value you set for that variable; files under `~/.config/opencode` and project config are unchanged. Interactive, `run`, `mini`, `api`, `models`, and `stats` launches add `--standalone` so a private server picks up that configuration instead of OpenCode's shared background service; `--server` and `pair` are rejected for the same reason (use `dari opencode serve` for other clients). Management commands such as `service`, `session`, and `auth` run without Dari's configuration so OpenCode's long-lived background service never picks it up. Built-in agents, subagents, and title, summary, and compaction tasks are pinned to `dari/routing`.

Every argument after the launcher subcommand is forwarded to the agent. This includes interactive and non-interactive modes, prompts, and agent-specific flags:

```bash
dari claude --print "Review this diff"
dari codex exec --sandbox workspace-write "Fix the failing tests"
dari opencode run "Explain this repository"
dari pi --tools read,grep,find,ls -p "Review this repository"
```

The launcher subcommand must be the first argument. Dari-owned provider and model settings take precedence if conflicting agent flags are passed, so the process remains routed through Dari. The native agent executable must already be installed and available on `PATH`, or set `DARI_<AGENT>_PATH` (for example `DARI_OPENCODE_PATH`) to its location.

### Desktop Apps

The Claude and Codex desktop apps never run through the launcher, so `--setup` writes Dari into the config each app reads:

```bash
dari claude --setup
dari codex --setup
```

Setup runs the same onboarding as a first launch, then exits without starting the agent. Restart the app to apply it. The app's model picker lists the same menu as the launcher; rerun `--setup` after changing the router's models. `--remove-setup` undoes it.

- `dari claude --setup` applies a Dari gateway entry in the Claude app's third-party inference configuration (`Claude-3p/configLibrary` in the app's data directory), which signs the app in through Dari instead of claude.ai. The Claude app lists only Claude models: routing appears as **Dari Routing**, and explicit models from other families are left out. It also sets `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` in Claude Code's user settings so subagents route independently.
- `dari codex --setup` makes Dari the default provider in `~/.codex/config.toml` (or `$CODEX_HOME`), which the Codex app and plain `codex` share. Replaced top-level keys are commented out and restored by `--remove-setup`. The model menu is written to `dari-models.json` beside it.

Both apps store the Routing key in these files because desktop apps do not inherit shell environment variables.

### OpenClaw and Hermes Agent

OpenClaw and Hermes Agent run every session, messaging channel, and scheduled task through one long-lived gateway that reads the agent's own config, so a launch cannot route only itself. `dari openclaw` and `dari hermes` therefore write the same setup `--setup` does, then start the agent with every following argument. `--setup` sets up without launching, and `--remove-setup` undoes it.

- `dari openclaw` adds a `dari` provider under `models.providers` and makes it the primary model in `agents.defaults.model`, keeping fallbacks. It writes through `openclaw config patch`, which validates the change and hot-reloads a running gateway.
- `dari hermes` adds a `dari` entry under `providers` in the config `hermes config path` reports and makes it the main model. It removes the main model's `base_url`, `api_key`, `api_mode`, and `context_length`, which would steer Dari's route. Run `hermes gateway restart` to move messaging sessions that are already open.

Both save the default model they replaced in `dari-setup.json` beside the agent's config, and `--remove-setup` restores it. Both store the Routing key in the agent's config because the gateway does not inherit the launcher's environment.

## Self-Hosted Gateway

Set `DARI_GATEWAY_URL` and `DARI_GATEWAY_KEY` to run the coding agents and subscription commands against a self-hosted Dari Gateway instead of the hosted API:

```bash
export DARI_GATEWAY_URL="http://localhost:8080"
export DARI_GATEWAY_KEY="your-gateway-key"
dari claude
```

In gateway mode, `dari claude`, `dari codex`, `dari opencode`, `dari pi`, `dari openclaw`, and `dari hermes` make no hosted API calls. They skip sign-in, router setup, and plan checks, then launch the agent against the gateway with `DARI_GATEWAY_KEY` as its routing key. The URL may end in `/v1`. Agents start on the gateway's `dari/routing` model, and their model pickers list the gateway router's models, read from its `/v1/models`. `--connect` manages hosted accounts, so it is rejected in gateway mode. `dari credentials subscription list`, `connect`, `rename`, `mark-available`, and `disconnect` also use the gateway, which stores connected subscriptions in its own database. `dari credentials subscription auto-reset` and `dari router request-costs` are hosted-only and fail in gateway mode. Other commands, such as `dari router`, still use the hosted API.

## Common Workflows

Create a router from flags:

```bash
dari router create "Production Router" \
  --model openai/gpt-5.6-sol \
  --model anthropic/claude-sonnet-5 \
  --managed-key openai \
  --managed-key anthropic \
  --strategy dari
```

Or create one from `router.yml`:

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

```bash
dari router create ./router.yml
```

Save BYOK values once, then reference their stable IDs in router configuration:

```bash
printf '%s' "$OPENROUTER_API_KEY" | \
  dari credentials provider add openrouter "OpenRouter Production" --value-stdin
```

```yaml
name: OpenRouter Production
enabled_models:
  - openrouter/openai/gpt-5.6-sol
provider_credential_ids:
  openrouter: cred_...
routing_strategy: dari
```

To serve OpenAI or Anthropic models from the attributed user's personal subscription, pass `--subscription openai` or `--subscription anthropic` (or set `subscription_providers` in `router.yml`). The provider's `--managed-key` or `--provider-credential` choice becomes the API fallback credential. Models passed with `--api-fallback MODEL` (or listed in `subscription_api_fallback_models`) run on it while the subscription is unavailable; the provider's other models pause until the subscription is back. On update, either flag replaces its list, an empty value clears it, and omitting it keeps the current list.

Use `dari credentials provider update` to change a saved credential without changing its ID. For AWS IAM credentials, pass only `--aws-region` to keep the stored keys, or include `--aws-access-key-id-env`, `--aws-secret-access-key-env`, and optional `--aws-session-token-env` to replace them. Run `dari router models` first to see the current catalog. `dari router request-costs <request_uuid>...` looks up content-free model reference costs for requests made by the `DARI_ROUTING_API_KEY`; set that environment variable to the key used for inference. Results are scoped to the key, may be delayed while telemetry lands, and are not a subscription cash charge.

Inspect and manage routers:

```bash
dari router list
dari router get <router_id_or_endpoint>
dari router update <router_id_or_endpoint> --model openai/gpt-5.6-sol
dari router delete <router_id_or_endpoint> --yes
```

Dari automatically picks the relevant evals for each request from your organization's evals and Public Evals. Use `dari eval` to manage your organization's eval scorecards; router configuration no longer selects them. Eval score imputation estimates a missing eval score for a model and thinking level from related measured scores; measured scores are never changed. It is on by default for new routers. Pass `--eval-score-imputation=false` to `dari router create` or `dari router update`, or set `eval_score_imputation: false` in `router.yml`, to turn it off; omitting the flag on update keeps the router's current setting.

Session pinning routes once when a session starts and keeps that model and thinking level for the whole session; each subagent is routed on its own when it starts, then keeps its model. Speculative routing and leases do not apply while it is on. It is off by default. Pass `--session-pinning` to `dari router create` or `dari router update`, or set `session_pinning: true` in `router.yml`; pass `--session-pinning=false` on update to turn it off.

Inspect activity and evals:

```bash
dari activity filter-options --from 2026-07-01T00:00:00Z --to 2026-07-08T00:00:00Z
dari activity overview --from 2026-07-01T00:00:00Z --to 2026-07-08T00:00:00Z
dari activity models --from 2026-07-01T00:00:00Z --to 2026-07-08T00:00:00Z
dari activity people --from 2026-07-01T00:00:00Z --to 2026-07-08T00:00:00Z
dari activity conversations --from 2026-07-01T00:00:00Z --to 2026-07-08T00:00:00Z
dari activity conversations get rreq_... --request-class main
dari activity conversations get rreq_... --request-class subagent --agent-id agent_...
dari activity tools list --from 2026-07-01T00:00:00Z --to 2026-07-08T00:00:00Z
dari activity skills list --from 2026-07-01T00:00:00Z --to 2026-07-08T00:00:00Z
dari eval list
dari eval list --model anthropic/claude-fable-5:medium,high --model openai/gpt-5.6-sol
dari eval get <eval_id>
```

Create an eval scorecard from a CSV:

```csv
model_id,score,thinking_level,notes
openai/gpt-5.6-sol,87,high,Strong public run
openai/gpt-5.6-sol,82,off,Non-reasoning run
anthropic/claude-fable-5,81,,Generic score
```

```bash
dari eval create \
  --name "SWE-bench Verified" \
  --description "Public benchmark scores." \
  --min-score 0 \
  --max-score 100 \
  --file scores.csv
```

`model_id` and `score` must be the first two columns. Optional columns are `thinking_level`, `notes`, and `metadata_json` (a JSON object). Each `(model_id, thinking_level)` pair must be unique. Use `--file -` to read the CSV from standard input.

## Agent Skill

Print managed-router instructions for a coding agent:

```bash
dari --skill
```

The command prints the managed-router workflow directly so an agent can load and follow it.

## Command Discovery

Run `dari --help` or `<command> --help` for the complete, version-specific command and flag reference. The [Dari documentation](https://docs.dari.dev) includes the managed router guides, API reference, public manifests, and coding-agent integrations.

## Development

```bash
go test ./...
go build ./cmd/dari
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contributor guidance.

## License

[Apache-2.0](LICENSE) © 2026 Mupt AI.

---

<p align="center">
  <a href="https://dari.dev">dari.dev</a> · <a href="https://docs.dari.dev">Docs</a> · <a href="https://github.com/mupt-ai/dari-cli/releases">Releases</a>
</p>
