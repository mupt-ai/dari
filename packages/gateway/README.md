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
- **Activity.** Every request's model, tokens, cost, conversation, and tool and skill use is kept in the gateway database and read at `GET /v1/organizations/current/routing/activity/...` (overview, series, models, people-keys, conversations, tools-skills, and the rest) with a gateway key, or with `dari activity`. It is the same code that serves Activity on hosted Dari.

Dari Auto Routing (choosing among a router's models with Dari's trained policy) is optional and needs a Dari API key; without it, `dari/routing` serves the router's first available model.

## Run

> [!IMPORTANT]
> **Activity stays on your gateway.** Requests through your own gateway never reach Dari. The gateway keeps their Activity itself, read with `dari activity` or the Activity API; the Activity dashboard and billing are hosted only (`dari gateway setup --mode hosted`).

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
| `DARI_GATEWAY_ROUTERS_DIR` | Optional. A directory of [router specs](#router-specs), read at startup: each `<id>.yaml` or `<id>.yml` is router `<id>`. |
| `DARI_GATEWAY_DB` | SQLite database for subscriptions, Dari Link grants, model lists saved with `dari gateway models`, router specs saved through the API, conversation state, and Activity (each request's log row and, outside ZDR routers, its request and response bodies). Default `dari-gateway.db`. Without `DARI_GATEWAY_ENCRYPTION_KEY` it stores subscription tokens in plaintext; protect it like a secret either way. |
| `DARI_GATEWAY_ENCRYPTION_KEY` | Encrypts the subscription tokens, pending sign-ins, and API keys in the database: a 32-byte key in base64 (`openssl rand -base64 32`). Each value is sealed with AES-256-GCM and bound to its own row, so a copied database, or a token moved into another row, is useless without the key. Keep the key outside the database's storage and backups (a secret manager, not the same disk). To rotate, list the new key first and the old one after a comma, start the gateway once (it re-encrypts everything under the first), then drop the old one. Required for Dari Link: without it the approval page takes nobody's subscriptions or keys. Losing the key loses the stored subscriptions; users connect again. |
| `DARI_LINK_SESSION_SECRET` | Signs the cookie that remembers the user of Dari Link's approval and connections pages. Unset, each gateway process makes its own, so a restart forgets who connected which plans. Set it on any gateway that serves Dari Link. |
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
      - id: openai/gpt-6.2-sol
        thinking: [medium, high]
    agentModels:           # optional: a coding agent's own list, in place of `models`
      codex: [openai/gpt-6.2-sol, openai/gpt-6.1-terra]
    subscriptions: true    # prefer connected subscriptions over API keys
    sessionPinning: false  # route each session and subagent once, then keep its model
    nativeCompaction: false # let Codex compact server-side; compacted requests route only to supporting models
    roleModels:            # optional: serve the main agent or subagents one model, without routing
      subagent: openai/gpt-6.2-sol
    rolePrompts:           # optional: append to the main agent's or subagents' system prompt
      main: Delegate codebase exploration to subagents.
  local:                   # serves /local/v1/...
    models: [local/qwen3-coder]

providers:                 # endpoints outside the built-in catalog
  local:
    baseUrl: http://localhost:8000/v1
    apiKeyEnv: LOCAL_API_KEY
```

Model ids are `provider/model`. Clients send `model: "dari/routing"` to let the router choose, or `model: "dari/model/<id>"` to pin one of its models. A Claude Code subscription serves Anthropic models only for Claude Code itself; a ChatGPT subscription serves OpenAI models for every client. Each coding agent is offered the router's models that a credential can serve it, or its own `agentModels` list (`claude_code`, `codex`, `muse_code`, `opencode`, `pi`, `openclaw`, `hermes`) when the router has one.

`dari gateway models` changes either list on a running gateway, with any gateway key: `dari gateway models --agent codex openai/gpt-6.2-sol`, or no models for the picker. It calls `PUT` and `DELETE /v1/router/models[/<agent>]` (`GET /v1/router/models` reads them). The gateway saves the list in its database and serves it at once in place of the config file's, until `--reset` removes it.

### Router specs

A router spec is a whole router as one YAML file with no credentials, the same file hosted Dari applies:

```yaml
name: Opus 5.5 + DeepSeek Subagents
models:
  - anthropic/claude-opus-5-5
  - id: deepseek-ai/DeepSeek-V4.1-Flash-1017
    thinking: [high]
    provider: opencode-go   # served by this provider, not the one its id names
roles:
  main: { model: anthropic/claude-opus-5-5 }
  subagent: { model: deepseek-ai/DeepSeek-V4.1-Flash-1017, prompt: Be brief. }
routing: { session_pinning: false, retries: 1 }
payment: { allow: [subscription, key] }   # without subscription, only API keys pay
native_compaction: false
agents: { codex: [openai/gpt-6.1-sol] }
```

The gateway pays with connected subscriptions when `payment.allow` lists `subscription`, and otherwise with provider API keys; it has no Dari credits. `hosted` settings and a model's `fast` apply only on hosted Dari and are ignored here; `routing.rules` runs only on hosted Dari and is refused. A model's `provider` must be one that serves it, such as `opencode-go` or `fireworks` for the DeepSeek, Kimi, and GLM models.

With any gateway key:

- `PUT /v1/routers/<id>` with `{"spec_yaml": "<the file's text>"}` (or `{"spec": {...}}`) checks the spec, saves it, and serves it at once at `/<id>/v1/...` (`default` at `/v1/...`), in place of any router of that id. It answers `{"id", "name"}`, or 400 with the reason.
- `GET /v1/routers` lists `{"routers": [{"id", "name", "source"}]}`, `source` being `saved` or `config` (the config file or `DARI_GATEWAY_ROUTERS_DIR`).
- `GET /v1/routers/<id>` answers the spec as `application/yaml`: a saved or file spec as written, and a config file router as the spec it amounts to.
- `DELETE /v1/routers/<id>` removes a saved spec, so a config router of that id serves again. Routers from files are changed in their files.

### Model catalog

`GET /v1/models?detail=1` (any gateway key; optionally `&provider=openrouter,meta`) and `listModelCatalog({ providers?, fetch?, signal? })` list each provider's tool-capable models as `dari/model/<id>`-ready ids with context window, max output tokens, input modalities, accepted thinking levels, and list prices in USD per million tokens (input, output, cache read, cache write, long-context tiers) with `price_as_of`. OpenRouter and Vercel AI Gateway are read live from their public models endpoints; other providers (default: OpenAI, Anthropic, Meta, xAI, Fireworks) come from the bundled Pi catalog.

## Coding agents

```bash
export DARI_GATEWAY_URL=http://localhost:8080
export DARI_GATEWAY_KEY=<one of DARI_GATEWAY_KEYS>

dari accounts subscription connect claude-code   # or codex or muse-code; repeat to pool plans
dari claude
```

In gateway mode the CLI makes no calls to Dari's hosted API; `dari activity` reads the gateway's own Activity.

## Dari Link

Dari Link lets another app send one user's model requests through the gateway on only the subscriptions that user grants it: never an API key, credits, or any other plan.

**Which plans serve which apps.** A ChatGPT plan (`openai_codex`) serves any app, including a plain OpenAI `chat/completions` or Responses client, through the Codex backend. A Claude Pro/Max/Ultra plan (`anthropic_claude_code`) serves only Claude Code itself, and a Muse Code plan only Muse Code; the gateway never presents another app as those clients. An OpenCode Go plan (`opencode_go`) serves any app its `opencode-go` models. So an app that calls the API itself needs the user to grant a ChatGPT or OpenCode Go plan, or an API key. The approval page offers only what the app can use: a Claude or Muse plan appears when the app runs Claude Code or Muse Code itself and says so with `client` on the authorize request.

**API keys.** A user without a plan can add an API key on the same page instead: one per model provider (Anthropic, OpenAI, Meta, Moonshot AI, xAI) or gateway (OpenRouter, Vercel AI Gateway). A key is shared like a plan, shows on the grant as `kind: "api_key"` with `provider` (never the key itself), and serves that provider's catalog models to any app, so an Anthropic key serves a plain client where a Claude plan would not. A gateway key serves any model of its gateway named by its full id, such as `openrouter/anthropic/claude-sonnet-4.5`; the grant's `models` lists none of them. A child token can be pinned to such a model the same way (`model=openrouter/anthropic/claude-sonnet-4.5`). Such a plan entry carries `model_prefix` (`"openrouter/"`): any id the gateway lists, with that prefix, is a model name here, sent as `dari/model/openrouter/<id>` or just `openrouter/<id>`. Every plan entry has a `title` to show ("Claude", "ChatGPT", "OpenRouter"). Where a grant holds both a plan and a key for a provider, the plan serves first. The usage a provider bills on the user's key is the user's cost. `plans` on the authorize request lists what the app wants offered, plan kinds and `api_key`; omit it to offer everything the app can use. `key_providers` (`keyProviders` in the client) narrows the API keys to the providers the app can run, such as `anthropic openrouter`, so a user is never offered, or shown ticked, a key the app cannot use. A user can connect as many plans and keys as they like, several accounts of one kind included, and share any of them.

**Connect with Dari.** For the user it is one button. It opens Dari in a popup, where they connect a Claude or ChatGPT subscription by signing in to it (or already have), pick which plans the app may use, and approve; the popup closes and the app has a code. Nobody pastes a key, and nobody needs the CLI.

An app with a server (a confidential client) is a button, one endpoint, and one string stored per user:

```ts
// In your app's bundle. The client uses only fetch and Web Crypto.
import { DariLink } from "@mupt-ai/dari-gateway/link/client";

DariLink.renderButton(document.getElementById("connect-dari"), {
  onClick: async () => {
    const { code, codeVerifier } = await DariLink.open({
      gatewayUrl: "https://routing.dari.dev",
      clientId: "lnk_…",
      redirectUri: "https://app.example.com/dari/callback",
      onExit: ({ error, step }) => analytics.track("dari_link_exit", { error, step }),
    });
    await fetch("/api/dari/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, codeVerifier }),
    });
  },
});
```

Your server redeems the code and keeps the grant's refresh token with the user. It never changes and is useless without the client secret, and every later call takes it:

```ts
import { exchange, linkFetch } from "@mupt-ai/dari-gateway/link/client";

const client = { gatewayUrl: "https://routing.dari.dev", clientId, clientSecret };
const { refreshToken } = await exchange({ ...client, redirectUri, code: req.body.code, codeVerifier: req.body.codeVerifier });
// Save refreshToken to your database, with the signed-in user.

const dari = linkFetch({ ...client, refreshToken });
await dari("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "dari/routing", messages }) });
```

The gateway refuses a model the grant cannot serve, a plan at its limit, a spent budget, and a revoked grant on every request, each with its own code (see the error table below), so the app checks none of them first.

- `DariLink.open` makes the PKCE pair in the page and resolves with `{ code, state, codeVerifier }`. That needs a secure page (https, or localhost); elsewhere it rejects with `insecure_context` before opening anything. To keep the verifier off the page, or to connect from a page that is not secure, make the pair on your server with `createAuthorization()`, keep `codeVerifier` and `state` with the user's session, and pass `codeChallenge` and `state` to `DariLink.open`: it then resolves with a null `codeVerifier`, and your server checks `state` and redeems the code with the verifier it kept.
- The endpoint that redeems the code changes the user's account, so protect it from cross-site requests like any other.
- A browser-only app (a public client) has no secret and redeems the code itself; its refresh token rotates on every use, so it keeps the whole token set and passes `loadTokens` and `saveTokens` wherever a server passes `refreshToken`.
- Get `clientId` (and a server's `clientSecret`) by registering the app: on hosted Dari under **Settings → Dari Link Apps**, or with the API or CLI in step 1 below.
- Call `DariLink.open` from the click handler, so the browser allows the popup. It opens the popup before awaiting anything, so its options may be a function returning a promise (`DariLink.open(async () => ({ ...await fetchConfig() }))`), fetched after the popup is open; Safari blocks a popup opened after an `await`. It rejects with a `LinkError`: `access_denied` when the user denies, `popup_closed`, or `popup_blocked`.
- `onEvent(step)` hears each step the user reaches in the popup (`connect_subscription` when they have no plan to share yet, `choose_plans`), and `onExit({ error, step })` says where they left before it rejects (`step` is `denied` when they denied, null when they reached none), so you can tell "closed while connecting a plan" from "closed after seeing the plans". The popup posts each step as `{"type": "dari-link-event", "version": "1", "event": "<step>", "state"}` to your redirect URI's origin; only the result is `{"type": "dari-link", ...}`, with `code` or `error`. A client reading the messages itself should ignore any other type, and any `dari-link` message with neither `code` nor `error`.
- The popup posts its result to your window with `response_mode=web_message`, readable only by your redirect URI's origin; `DariLink.open` accepts it only from the popup, from the origin the gateway's metadata names (`web_message_origin`), and with the state it made.
- Put `DariLink.callback()` on your redirect URI's page. A popup that sent the user to a provider's sign-in along the way can lose its link to your window; the approval then arrives on that page inside the popup, and `callback()` hands it to the window that opened it and closes the popup. A page whose CSP keeps it from bundling the client can load `<script src="<gateway>/v1/link/callback.js"></script>` (the metadata's `callback_script`) instead. The contract is stable: on the `BroadcastChannel` named `dari-link`, the page posts `{"type": "dari-link", "state", "code"}` or `{"type": "dari-link", "state", "error", "error_description"}`, then closes.
- Users see the apps they connected on the gateway's connections page, `/v1/link/connections`, in the browser they connected from: what each shares and used, its budget, and Disconnect, and the plans and keys they can remove. Link there with the grant's `manage_url` (that app's card) or the metadata's `connected_apps_uri`.
- **Update mode.** To let the user change which plans an app has, open the same flow with `grantId` (`grant_id=<lgr_…>` on the authorize request): the page is titled "Update Plans For <App>", starts with the grant's plans and budget, and saves to the same grant. Its id and every token it issued keep working; the new code redeems for more tokens of it, which you may keep or drop. A `grant_id` that is not this browser's user's grant for this app (another browser, cleared cookies) starts a new connection instead, and leaves that grant as it was.
- One grant may back several records in your app (one per plan, say) only with a confidential client: a public client's refresh token rotates on every use, so two records holding it race.

**Flow** (OAuth 2.0 authorization code with PKCE S256; `GET /.well-known/oauth-authorization-server` lists the endpoints):

1. Register once.
   - A browser, desktop, or CLI app is a public client: `POST /v1/link/register` with `{"client_name", "redirect_uris"}` (RFC 7591; no key; https URIs or http on localhost; 20 registrations a minute per gateway) returns `{"client_id", ...}`. A self-hosted gateway also allows http on the private dev hosts its config lists under `link.allowHttpRedirectHosts` (exact names, or `*.example.ts.net` for any subdomain); by default there are none.
   - On hosted Dari, an organization owner or admin can register either kind under **Settings → Dari Link Apps** instead.
   - A server is a confidential client: the same `POST /v1/link/register` with `"token_endpoint_auth_method": "client_secret_basic"`, or `POST /v1/link/apps` with your key and `"confidential": true` (hosted Dari: **Settings → Dari Link Apps**), also returns a `client_secret` (`dlk_cs_…`), shown once. The app sends it with HTTP Basic (`client_id:client_secret`) on every `/v1/link/token` and `/v1/link/revoke` call. Registering hands out no access: the user still approves every grant.
2. Send the user to `GET /v1/link/authorize?response_type=code&client_id=…&redirect_uri=…&state=…&code_challenge=…&code_challenge_method=S256`. Optional parameters:
   - `scope=route`, the only scope.
   - `client`: the clients the app runs, space-separated, such as `client=claude_code codex`. Naming `claude_code` or `muse_code` lets the user grant plans that serve only that client.
   - `plans`: the plan kinds to offer, such as `plans=openai_codex`; the page lists only those.
   - `purpose_any_app`, `purpose_claude_code`, `purpose_muse_code`: up to 200 characters each, shown beside the plans of that audience as what the app says it does with them.
   - `response_mode=web_message`: for a page opened as a popup. The result is posted to the window that opened it (`{"type": "dari-link", "code" | "error", "state"}`, addressed to the redirect URI's origin) instead of sent on a redirect; a page with no opener left redirects to `redirect_uri` instead. `DariLink.open` does this for you.
   - `grant_id`: update mode (above).

   The gateway serves the page itself, hosted and self-hosted alike. A new user sees what connecting means, picks a subscription (Claude, ChatGPT, Meta Muse, OpenCode Go) or a provider to add an API key for, signs in to that provider (Claude shows a code to paste back; the others take a code the page shows and continue on their own), and allows the app with what they connected ticked. A self-hosted gateway needs no sign-in: their first plan or key makes them a user. A platform with accounts (`LinkApprovalPage.signIn`; on hosted Dari, the user's Dari account) has them sign in first, and they are that account, with the plans it already has. Either way the gateway remembers them in a signed HttpOnly cookie, so the next app that asks finds their plans connected and takes one click: for a year without accounts, since the cookie is who they are; for 30 days with them, and they can sign out from the approval and connections pages. A self-hosted gateway takes their subscriptions and keys only when it encrypts what it stores (`DARI_GATEWAY_ENCRYPTION_KEY`). A plan a user connects this way is theirs alone: it serves only the grants they approve, never a gateway key, and the gateway owner's own plans are never offered on the page.

   The user approves; they can later cap the tokens the app may use per 5 hours and per week (see **Budgets**). The app gets `code` and `state`, or `error=access_denied`, on `redirect_uri` or as the popup's message.
3. `POST /v1/link/token` (form or JSON; CORS open) with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier` returns an access token (`dlk_at_…`, one hour) and a refresh token (`dlk_rt_…`), with the grant's fields below. `grant_type=refresh_token` with `refresh_token` returns a new access token:
   - Every access token lives until its own expiry, so requests in flight on an older one complete.
   - A public client's refresh token rotates on every use. Presenting the rotated one again within a minute is refused as `invalid_grant` with `"error_code": "refresh_race"` and nothing is revoked: use the tokens the winning request received. Presenting it later revokes the grant.
   - A confidential client's refresh token never rotates, so any number of instances can refresh one grant.
4. Call the gateway's ordinary endpoints (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/models`) with `Authorization: Bearer dlk_at_…`. A link token serves only the default router, and is served exactly what it names:
   - `dari/routing` chooses among the router's models that a granted plan serves.
   - Any other name is a model, served as exactly that model: any catalog model of a granted plan's provider, whether or not the user's router lists it. It may be named `dari/model/<provider>/<model>`, by its bare id (`gpt-5.5`, `claude-sonnet-5-5`), or as a dated snapshot of either (`claude-haiku-4-5-20251001` is `claude-haiku-4-5`), so an app forwarding Claude Code or Codex traffic needs no model map. A name no catalog model has, or one two models share, fails with `model_not_granted`. It is served with the client's own thinking settings: a level the request names is served exactly or refused (400 `thinking_level_unavailable`); Anthropic's `thinking: {"type": "disabled"}` is sent as it is, on every Claude model (`X-Dari-Thinking-Level: off`); a thinking budget (`thinking: {"type": "enabled", "budget_tokens": 8000}`) is sent as it is (`X-Dari-Thinking-Level: budget:8000`); and when it names none, none is chosen for it and the provider's default applies (`X-Dari-Thinking-Level: default`). `X-Dari-Thinking-Level` is what the provider was sent: a level, `off`, `default`, or `budget:<tokens>`. It never fails over to another model: a provider failure is returned as it is. Only when a granted plan hits its usage limit and the grant holds another plan for the same provider is the request retried there, on the same model.
   - `opus`, `sonnet`, `haiku`, and the other Anthropic tier names route, as `dari/routing` does.
   - `POST /v1/messages/count_tokens` is not served: it answers an Anthropic-shaped 404, on which Claude Code estimates locally.
   - A non-streamed response carries `X-Dari-Usage: {"input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"}` (input excludes cache reads and writes) beside `X-Dari-Selected-Model` and `X-Dari-Thinking-Level`, the same whatever protocol the app speaks. A stream reports usage in its protocol's own final event; `GET /v1/link/usage` has both.
5. The app ends its grant with `POST /v1/link/revoke` (RFC 7009: `client_id` and `token`, any of the grant's tokens; always 200). The user disconnects an app and changes its budget on the connections page. With a key, `GET` and `DELETE /v1/link/grants[/<id>]` and `PUT /v1/link/grants/<id>/budget` do the same: on hosted Dari a personal key manages its own user's grants, and on a self-hosted gateway a gateway key manages every grant. A revoked grant's tokens, access tokens included, stop working at once.

**The grant.** The token response and `GET /v1/link/grant` (bearer: the access token) describe the grant:

```json
{
  "grant_id": "lgr_…", "client_id": "lnk_…", "app_name": "Notes", "created_at": "…", "scope": "route",
  "budget": [{"window_minutes": 10080, "max_tokens": 5000000, "used_tokens": 312000, "resets_at": null}],
  "state": "ready", "available_at": null,
  "manage_url": "https://routing.dari.dev/v1/link/connections#lgr_…",
  "plans": [{
    "id": "…", "kind": "openai_codex", "plan": "ChatGPT Plus/Pro", "label": "a@example.com", "account_email": "a@example.com",
    "serves": "any_app", "state": "ready", "available_at": null, "unavailable_until": null,
    "usage": [{"window_minutes": 300, "utilization": 0.42, "resets_at": "…"}, {"window_minutes": 10080, "utilization": 0.1, "resets_at": "…"}],
    "models": [{"id": "dari/model/openai/gpt-5.5", "name": "GPT-5.5"}, {"id": "dari/model/openai/gpt-6.2-sol", "name": "GPT-6.2 Sol"}]
  }],
  "models": [{"id": "dari/model/openai/gpt-5.5", "name": "GPT-5.5"}, {"id": "dari/model/openai/gpt-6.2-sol", "name": "GPT-6.2 Sol"}],
  "routes": true
}
```

`serves` is `any_app`, `claude_code_only`, or `muse_code_only`. A plan's `state` is the one answer to "can this plan serve the app now": `ready`, or `plan_limit`, the plan is at its own usage limit; `available_at` is when it serves again (null when ready or unknown). The grant's own `state` is `budget_limit` while a window of its budget is at its cap, until `available_at` (see **Budgets**). `label` is the user's name for the plan, else its account. `usage` lists the quota windows the plan last reported (five hours and a week for these plans), each with the share used from 0 to 1 and when it resets; it is empty until the plan has served a request through Dari (any request, not only this app's, including the user's own Claude Code or Codex through Dari), because plans report their windows only on responses. Dari does not read a fresh plan's windows when it connects: that takes a call to the provider with the user's credential that neither Claude nor ChatGPT documents for third parties, so a just-connected plan shows no usage until its first request. A plan's `models` are those it serves its clients now, each with the name a request uses (`id`) and the catalog's display name (`name`); the top-level `models` are what a plain API client can name now, and `routes` says whether `dari/routing` serves it. `GET /v1/models` with a link token lists the same models in the OpenAI list shape, empty when none can serve. `GET /v1/link/grant` makes no provider call, so it is the cheap check before a long run: a dead grant answers 401, and `unavailable_until` and `usage` say whether the plans have room.

**Budgets.** A user can cap the tokens an app may use per five hours and per week: on the connections page, or with `PUT /v1/link/grants/<id>/budget` and `{"budget": [{"window_minutes": 10080, "max_tokens": 5000000}]}` (the user's key; `window_minutes` is `300` or `10080`; `[]` removes it). The budget covers the whole grant: all its plans and API keys together.

Tokens are what Dari recorded for the grant's requests, child tokens' included: input + output + cache read + cache write, the same total `GET /v1/link/usage` and the connections page show. Windows roll: a window's `used_tokens` are those of requests received in its last `window_minutes`. Before each request, a grant with any window at its cap is refused with 424 `grant_budget_exhausted`, with `resets_at` (and `Retry-After`) set to when enough of the window's oldest requests roll off to bring it under the cap; a budget window's `resets_at` is that same time, and null while under the cap. A request is counted once it finishes, so requests in flight may take a window past its cap.

**Usage.** Every request a grant's tokens make, child tokens' included, streamed or not, is recorded once it finishes (a moment after the response). `GET /v1/link/usage` (bearer: the access token; CORS open) reads it back:

- `tag=<key>=<value>`, repeatable: only requests carrying every given tag, from `X-Dari-Tags` or the child token's `tags`;
- `since`, `until`: ISO 8601 times bounding when a request was received (`since` inclusive, `until` exclusive);
- `group_by=tag:<key>`: also total per value of that tag, in `by_tag` (`value` null for requests without it).

Every response to a link token carries `X-Request-Id`. `GET /v1/link/usage/requests/<id>` (same bearer) answers that one request's usage in the same shape once it is recorded, and 404 until then.

```json
{
  "requests": 7, "errors": 1, "input_tokens": 70, "output_tokens": 14, "cache_read_tokens": 28, "cache_write_tokens": 2,
  "complete_through": "2026-11-14T07:00:00.000Z",
  "by_model": [{"model": "openai/gpt-5.5", "thinking": "high", "requests": 4, "errors": 0, "input_tokens": 40, "output_tokens": 8, "cache_read_tokens": 16, "cache_write_tokens": 0}],
  "by_tag": [{"value": "7", "requests": 3, "errors": 0, "input_tokens": 30, "output_tokens": 6, "cache_read_tokens": 12, "cache_write_tokens": 0}]
}
```

`errors` counts the requests the provider or Dari failed (they count in `requests` too); a request the client aborted is not an error. `complete_through` says how far the counts are complete: every request received before it has been recorded. On the self-hosted gateway, which serves and records every request itself, it is the time the oldest request still being served was received, or 30 seconds ago when none is (a request still resolving has not started being tracked). On hosted Dari it is `null`: requests are recorded from several instances after they finish, so no instance can say; read again until the counts stop changing.

Token counts mean the same for every protocol: `input_tokens` excludes cache reads and writes (an OpenAI response's cached tokens are moved out of its input count). `by_model` has one entry per model and thinking level served (`thinking` as `X-Dari-Thinking-Level` reported it), most requests first. A provider failure counts in `requests` and `errors`, with the tokens the provider reported, if any; a request refused before any provider call (such as a 424) is not counted. A child token cannot read usage (403 `permission_denied`). So a server that gives each trial a child token tagged `trial=<id>` gets that trial's cost with `?tag=trial=<id>`, with no relay in between.

**Child tokens.** A server that hands work to sandboxes or workers trades its access token for a child token (RFC 8693) instead of relaying their traffic: `POST /v1/link/token` with `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token=<dlk_at_…>`, `subject_token_type=urn:ietf:params:oauth:token-type:access_token`, and

- `model` (required, repeatable up to 16 times): the models the token serves, each named as a request may name it (`dari/model/openai/gpt-5.5`, `gpt-5.5`, a dated snapshot); each must be one the grant serves now, or the whole mint fails with `invalid_target`;
- `thinking`: the level requests for a model are served at, whatever the request asks for. Give it once to pin every model to it, or once per `model` in the same order, with `default` for a model left unpinned (`model=a&thinking=high&model=b&thinking=default`). A level a model does not offer fails with `invalid_target`;
- `expires_in`: 60 to 43200 seconds (default 3600), so it can outlive the access token that minted it;
- `tags`: labels for its requests, like the `X-Dari-Tags` header (`run=r1,trial=7`).

It returns `{"access_token": "dlk_ct_…", "issued_token_type", "token_type": "Bearer", "expires_in", "grant_id", "models": [{"model", "thinking"}], "tags"}`, each `model` by its catalog name and `thinking` null when not pinned. A child token serves only those models on the gateway's ordinary endpoints, and `GET /v1/models` lists just them: any other model, and `dari/routing`, fail with `model_not_granted`. It cannot refresh, mint another token, or read `/v1/link/grant`, and it stops working when the grant is revoked.

A sandbox given a child token needs to reach only the gateway's host (for hosted Dari, `routing.dari.dev`) over HTTPS; it never talks to a provider, the approval page, or the app.

**Errors.** Token and revocation endpoints answer in the OAuth shape, `{"error", "error_description"}`; every other endpoint in the gateway's, `{"error": {"code", "message", ...}}`.

| Status | Code | Meaning | What to do |
| --- | --- | --- | --- |
| 400 | `invalid_grant` | The code or refresh token is used, expired, or revoked | Send the user through approval again |
| 400 | `invalid_grant` + `error_code: refresh_race` | Another request rotated this refresh token a moment ago | Use the tokens that request saved |
| 400 | `invalid_target` | The grant serves no model by the child token's `model` now, or the model lacks its `thinking` level | Mint for a model in the grant's `models`, at a level it offers |
| 400 | `invalid_request`, `unsupported_grant_type` | A missing or malformed parameter | Fix the request |
| 401 | `invalid_client` | Unknown client, or a missing or wrong client secret | Check the client id and secret |
| 401 | `link_token_expired` | The access or child token passed its expiry | Refresh (or mint a new child token) and retry |
| 401 | `grant_revoked` | The grant is gone; `revoked_by` is `user`, `app`, or `reuse_detected`, and `revoked_at` says when | Show the user Reconnect |
| 403 | `permission_denied` | A child token read the grant or its usage | Use the access token |
| 400 | `thinking_level_unavailable`, `unsupported_reasoning_effort` | The model does not offer the level the request names | Name a level the model supports |
| 424 | `grant_budget_exhausted` | The plans that serve this client are at the budget the user set for this app; `resets_at` and `Retry-After` say when the first is back, when known | Wait for the window, or ask the user to raise the budget |
| 424 | `subscription_exhausted` | The plans that serve this client are at their limits; `resets_at` and `Retry-After` say when the first is back, when known | Wait, or ask the user for another plan |
| 424 | `subscription_client_mismatch` | The granted plans serve only another client | Ask the user to grant a plan that serves any app |
| 424 | `model_not_granted` | The name is no catalog model, or no granted plan serves it, or any model the router lists | Name a model in the grant's `models` |
| 5xx | `link_request_failed` and others | The gateway failed; the message carries only a `request_id`, which its log line has with the cause | Retry, and report the request id |

Error text replaces anything shaped like an `sk-` key with `sk-…`, and responses replace the serving plan's own credential wherever it appears.

**Client.** `@mupt-ai/dari-gateway/link/client` (fetch and Web Crypto only; browsers, Node, Bun, Deno; erasable TypeScript only, so `node` runs the `.ts` file as is) has `DariLink` (`open`, `callback`, `renderButton`), `exchange`, `linkFetch`, `grant`, `childToken`, `usage`, `revoke`, `refresh`, `createAuthorization` (a PKCE pair and state made on your server), `registerClient`, and `authorizeUrl` (the approval URL without a popup; takes `clients`, `plans`, `purposes`, and `grantId`). Every call takes `clientSecret` for a confidential client.

`linkFetch`, `grant`, `childToken`, and `usage` take one grant's tokens in either of two ways:

- `refreshToken`, for a confidential client: its refresh token never rotates, so it is all the app stores. The client makes an access token from it, keeps it in the process, replaces it before it expires or once after a 401 for an expired token, and shares one refresh among concurrent calls. Any number of processes can do this at once.
- `loadTokens` and `saveTokens`, for a public client, whose refresh token rotates on every use: your storage is the source of truth. The client reads the token set with `loadTokens` on every call and passes every new one to `saveTokens` before using it, so processes that share the storage share the rotation. `loadTokens` returning null throws `LinkError` `not_linked`, with no call to the gateway.

`grant` returns what `GET /v1/link/grant` does, with its top-level fields in camelCase (`grantId`, `availableAt`, `manageUrl`). `usage({ tags, since, until, groupByTag })` reads the grant's usage, and `childToken({ models: [{ model, thinking? }] })` mints for several models at once. `grant` and `usage` also take a `linkFetch` you already made as `fetcher` in place of the tokens, and `childToken` an `accessToken`. `registerClient({ ..., confidential: true })` returns a `clientSecret` too.

A refused call throws a `LinkError` with the most specific `code`. Its `unlinked` is true when the grant is gone (`invalid_grant` from a refresh, `grant_revoked`, or `not_linked`): show the user Reconnect. `linkFetch` is a fetch, so a revoked grant's 401 `grant_revoked` comes back as the response it is, with no refresh attempted.

A server-side integration, start to finish:

```ts
import { childToken, exchange, grant, LinkError, revoke, usage } from "@mupt-ai/dari-gateway/link/client";

// Registered once, under Settings → Dari Link Apps or with POST /v1/link/register.
const client = { gatewayUrl, clientId, clientSecret: process.env.DARI_LINK_CLIENT_SECRET };

// 1. Redeem the code Connect with Dari handed your page, and store the refresh token.
const { refreshToken } = await exchange({ ...client, redirectUri, code, codeVerifier });
// Save refreshToken to your database, with the signed-in user.

// 2. From any instance: what the user shared, the cheap check before a long run.
const { plans, models, manageUrl } = await grant({ ...client, refreshToken });

// 3. Hand a sandbox one model for one trial; it calls the gateway itself.
const sandbox = await childToken({
  ...client,
  refreshToken,
  models: [{ model: models[0].id, thinking: "high" }],
  expiresIn: 6 * 3600,
  tags: { run, trial },
});

// 4. What the trial used.
const used = await usage({ ...client, refreshToken, tags: { trial } });

// 5. When the user disconnects in the app.
await revoke({ ...client, token: refreshToken });

// Anywhere: the grant is gone, so offer Reconnect.
if (error instanceof LinkError && error.unlinked) await markUnlinked(userId);
```

**Forwarding proxy.** An app that fronts real Claude Code or Codex processes (agents it runs for the user) forwards their requests to the gateway as they are:

- pass the client's own headers through, dropping only hop-by-hop headers (`host`, `connection`, `content-length`, `transfer-encoding`, `keep-alive`, `upgrade`, `te`, `trailer`, `proxy-*`) and the client's own auth (`authorization`, `x-api-key`), and set `Authorization: Bearer dlk_…`;
- keep the model as the client named it: bare and dated ids are served as exactly that model;
- never add or change `user-agent`, `x-app`, or other client headers. A Claude Code plan serves only what really is Claude Code; anything else that sends Claude Code's headers is impersonating it;
- treat a `LinkError` whose `unlinked` is true, and a 401 `grant_revoked` response, as unlinked: stop the agent and show Reconnect.

```ts
import { LinkError, linkFetch } from "@mupt-ai/dari-gateway/link/client";

const DROP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer", "authorization", "x-api-key"]);

// user: your own record of the signed-in user, with the refresh token you saved.
async function forward(request: Request, user: { id: string; refreshToken: string }): Promise<Response> {
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!DROP.has(name) && !name.startsWith("proxy-")) headers.set(name, value);
  });
  const gatewayFetch = linkFetch({ ...client, refreshToken: user.refreshToken });
  const { pathname, search } = new URL(request.url);
  try {
    // linkFetch sets the bearer and refreshes; the body (and its model) is unchanged.
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const response = await gatewayFetch(`${pathname}${search}`, { method: request.method, headers, body });
    if (response.status === 401 && (await response.clone().json()).error?.code === "grant_revoked") await markUnlinked(user.id);
    return response;
  } catch (error) {
    if (error instanceof LinkError && error.unlinked) await markUnlinked(user.id);
    throw error;
  }
}
```

A child token is simpler still when the agent runs somewhere you control: give the agent the `dlk_ct_…` token as its API key and base URL, and it calls the gateway itself.

**Connect with Dari button.** Use `DariLink.renderButton(container, { onClick, theme })`, or this markup, rather than drawing your own: the Dari mark (`DARI_MARK_SVG` from the client) at 20px, then "Connect with Dari" in your UI font at 14px, medium weight; 40px tall, 8px radius, 12px padding before the mark and 16px after the text, 8px between them. `theme: "dark"` (the default, for light pages) is a black button with white text and an inverted mark; `light` (for dark pages) is white with black text and a light gray border. Keep the words "Connect with Dari" (or "Reconnect Dari" for a revoked grant), and do not recolor the mark.

```html
<button type="button" style="display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 16px 0 12px;border-radius:8px;border:1px solid #000;background:#000;color:#fff;font:500 14px/1 system-ui,sans-serif;cursor:pointer">
  <!-- DARI_MARK_SVG, with its disc white and its figure black on this dark button -->
  Connect with Dari
</button>
```

**Users with their own gateway.** A user who runs their own gateway links it the same way: ask for its base URL, read `GET <base>/.well-known/oauth-authorization-server`, and register there with `POST /v1/link/register` (a server registers as a confidential client with `"token_endpoint_auth_method": "client_secret_basic"`). Keep each registration (client id, endpoints) keyed by the metadata's `issuer`, and show the issuer's host to the user wherever the link appears, so they can see which gateway an app is using.

**Testing an integration.** `startStubGateway` from `@mupt-ai/dari-gateway/self_host/stub_gateway` (Bun) runs a self-hosted gateway on stand-in plans, for example `{ plans: ["openai_codex"] }`, whose provider calls go to a local stand-in that answers "hi" (or your `upstream`), so tests make no paid calls. `gateway.app` is a server app already registered on it (`gatewayUrl`, `clientId`, `clientSecret`, `redirectUri`: your app's Dari Link settings in the test), and `gateway.connect({ credentialIds?, deny?, clients?, plans?, keyProviders?, grantId? })` is its user approving it: it resolves with what `DariLink.open` hands your page, `{ code, codeVerifier, state }`, or rejects with the `LinkError` it would. For an app you registered yourself, `gateway.approve(authorizeUrl, { credentialIds?, deny? })` goes through the approval page as a user would and returns what it hands your app, `{message, targetOrigin}` (the popup's `web_message` post, or the redirect's query), also kept in `gateway.messages`. `gateway.setState({ limited: true })` makes every provider call a usage-limit refusal (plans go `plan_limit` with `unavailable_until`, requests get 424 `subscription_exhausted`), and `{ five_hour: 0.4, weekly: 0.9 }` makes each reply report that plan usage (filling `plans[].usage`, and against a grant's budget leading to `grant_budget_exhausted`). `gateway.calls` records each provider call's path, model, thinking settings, the effort it is served at (for Claude models that take a per-turn effort, the latest effort message, not the top-level `output_config.effort` that stays fixed for caching), and client headers, to assert on. Under any other test runner, run it as a process: `dari-gateway-stub --plans openai_codex,anthropic_claude_code` (Bun runs it) prints one JSON line, `{"baseUrl", "gatewayKey", "planIds", "userCookie", "controlUrl", "app"}` (the stand-in plans belong to the approval page's user, and `userCookie` is the `Cookie` header that opens the page as them); `POST <controlUrl>/connect` takes `connect`'s options in snake case and answers `{"code", "code_verifier", "state"}`, `GET <controlUrl>/served` answers `{"calls": [...]}`, `POST <controlUrl>/approve` with `{"url", "credential_ids"?, "deny"?}` answers `{"message", "target_origin"}` (listed at `GET <controlUrl>/messages`), and `POST <controlUrl>/state` takes the same fields as `setState`. A gateway config can send ChatGPT plan traffic elsewhere the same way, with `providers.openai-codex.baseUrl`.

## Embed

Deployments with their own storage and accounting compose the runtime with a `GatewayPlatform` (router resolution, conversation state, session pins, subscription holds, request records, error reporting, and optionally Dari Link grants through `link`) and a selector backend:

```ts
import { createPrioritySelectorBackend, createRequestHandler } from "@mupt-ai/dari-gateway";

const handler = createRequestHandler({ platform, selectorBackend: createPrioritySelectorBackend() });
Bun.serve({ port: 8080, fetch: handler, idleTimeout: 0 });
```

The root entry needs no Bun APIs, so any runtime with web-standard `fetch`, `Request`, and `Response` can serve the handler. `startServer` and `startSelfHostedGateway` (Bun.serve and bun:sqlite) are in `@mupt-ai/dari-gateway/bun`. `src/self_host/` is the reference platform.

Platforms can also:

- implement `resolveProviderCredential({ provider, model, routerId, organizationId, apiKey, clientHarness? })` to supply a per-request `{ apiKey, baseUrl?, headers?, subscription? }`, such as a tenant's own key, in place of the router's resolved key. With `subscription` (`"openai_codex"`, `"anthropic_claude_code"`, or `"meta_muse"`), `apiKey` is that plan's access token: Codex's `auth.json` `tokens.access_token`, the token `claude setup-token` prints, or the Model API key a Meta sign-in mints. The platform keeps it fresh. Strict routers serve these supplied plans, but never subscriptions the gateway resolved itself. A plan serves only its own provider's models; a Claude Code plan serves only Claude Code clients, and a Muse Code plan only Muse Code clients (recognized by their `x-client-id`);
- resolve routers with `strict: true` to serve only the requested `dari/model/<id>` at the requested thinking level, with no selector, lease, or personal subscription. Set `strict_providers: ["openai"]` on the resolved router to permit any bundled-catalog model from that provider without enumerating `enabled_models`. Use `dari/model/openai/gpt-6.2-sol`; bare IDs and unknown models remain refused. This grant is ignored on non-strict routers and does not discover uncatalogued models;
- resolve routers with `session_pinning: true` to route each session once and serve that pair for the rest of the session. Each subagent (Claude Code agent id, Codex subagent thread, OpenCode child session) is routed once on its own. Pins are kept through `readSessionPin` and `writeSessionPin`, keyed by router and an opaque pin key; background requests and `dari/model/<id>` requests never use them;
- resolve routers with `native_compaction: true` to let Codex compact context server-side with the provider's native compaction. Requests carrying compaction state are routed only to models that support it;
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
