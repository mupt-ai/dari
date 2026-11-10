<h1 align="center">Dari Router</h1>

---

<p align="center">
  <strong>Route each request to a model you choose, behind one endpoint.</strong><br>
  A TypeScript framework that puts several language models behind one web-standard <code>fetch</code> handler. It accepts OpenAI Chat Completions and Anthropic Messages requests, lets a policy choose an eligible model, and runs that model through an executor you control.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mupt-ai/dari-router"><img src="https://img.shields.io/badge/npm-Install-CB3837?style=for-the-badge&logo=npm&logoColor=white" alt="Install from npm"></a>
  <a href="https://docs.dari.dev/framework/quickstart"><img src="https://img.shields.io/badge/Docs-Quickstart-0f9d76?style=for-the-badge" alt="Read the quickstart"></a>
  <a href="https://docs.dari.dev/framework/overview"><img src="https://img.shields.io/badge/Docs-Framework-111111?style=for-the-badge" alt="Read the framework documentation"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mupt-ai/dari-router"><img src="https://img.shields.io/npm/v/@mupt-ai/dari-router" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/mupt-ai/dari-router" alt="License: Apache-2.0"></a>
</p>

> [!WARNING]
> `@mupt-ai/dari-router` is pre-1.0. Its APIs may change between minor versions.

## How it works

A router is three pieces you supply, plus the HTTP surface that ties them together:

- **Models** declare candidates: an ID, the reasoning levels they accept, and capabilities such as image input, tool use, structured output, and streaming.
- **Policies** choose one eligible model per request. A policy can be a local function, a service you run, the deterministic policy in `/policy-engine`, or Dari's hosted [Auto Router](#hosted-auto-router).
- **Executors** call the chosen model. Use [`createGatewayExecutor`](#execute-on-a-dari-gateway) to run it on a Dari gateway, or implement `RouterExecutor` for your provider's SDK or API; see [Connecting a provider](#connecting-a-provider).

`router.fetch` accepts `POST /v1/chat/completions` and `POST /v1/messages` and responds in the same protocol as the request. Each response reports the routing decision in two places: the `dari_routing` field of the body, and the `X-Router-Selected-Model` and `X-Router-Reasoning-Effort` headers.

Your application keeps its own provider credentials, persistence, and infrastructure. The framework does not choose a provider for you.

## Install

```bash
npm install @mupt-ai/dari-router
```

Requires Node.js 22.19 or later, or Bun. The package is ESM and has no provider SDK dependencies.

## Quick start

This server routes between one model and serves a canned reply, so it needs no provider key:

```ts
// server.ts
import { createRouter, type RouterExecutor } from "@mupt-ai/dari-router";

const executor: RouterExecutor = {
  execute({ model }) {
    return {
      type: "complete",
      output: {
        content: [{ type: "text", text: `Served by ${model.id}` }],
        finishReason: "stop",
      },
    };
  },
};

const router = createRouter({
  models: [{ id: "demo/model", executor: "demo" }],
  executors: { demo: executor },
  policy: ({ candidates }) => ({
    model: candidates[0]!.id,
    reason: "Use the only eligible candidate.",
  }),
});

Bun.serve({ port: 3000, fetch: router.fetch });
```

Start it and send a request:

```bash
bun run server.ts

curl -s http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"dari/routing","messages":[{"role":"user","content":"hi"}]}'
```

The response contains `"content":"Served by demo/model"` and a `dari_routing` object with `"selected_model":"demo/model"`. Send the same body to `/v1/messages` with `max_tokens` set to receive an Anthropic Messages response instead.

To see the routing and executor path without a server, run the offline example from a checkout of this repository:

```bash
bun run example
```

## Execute on a Dari gateway

`createGatewayExecutor` runs each selection on a Dari gateway (`@mupt-ai/dari-gateway`). The router chooses the model; the gateway holds provider credentials and subscriptions and makes the provider call. Each request is sent as a pinned `dari/model/<id>` call, so the gateway serves exactly the router's choice without selecting again.

```ts
import { createGatewayExecutor, createRouter } from "@mupt-ai/dari-router";

const gateway = createGatewayExecutor({
  baseUrl: "http://localhost:8080",
  apiKey: process.env.DARI_GATEWAY_KEY!,
  defaultMaxOutputTokens: 8192,
});

const router = createRouter({
  models: [
    { id: "openai/gpt-6-luna", executor: "gateway" },
    { id: "anthropic/claude-fable-5-1", executor: "gateway" },
  ],
  executors: { gateway },
  policy: ({ candidates }) => ({ model: candidates[0]!.id }),
  fallback: { enabled: true },
});
```

Declare only models the gateway router enables, with the reasoning levels it serves. The gateway retries a failing provider call within the pinned model; switching to another model is the router's `fallback`.

The executor speaks the gateway's Anthropic Messages wire, so reasoning continuations round-trip on every turn and stream in order. That wire cannot express a few requests, which fail with a `gateway_unrepresentable_request` error instead of being changed silently: `minimal` reasoning effort, `json_object` response formats (use `json_schema`), temperatures above 1, system messages after the conversation starts, and provider-hosted tool calls. Requests without an output limit use `defaultMaxOutputTokens`, and fail when it is unset.

## Connecting a provider

An executor receives the routed request, the selected model, and the routing decision. It returns either a complete response or a stream of events. The quick start above returns a canned reply; a real executor calls your provider's SDK or HTTP API with credentials your application holds.

Each model names the executor that serves it, so one router can mix providers:

```ts
declare const openAIExecutor: RouterExecutor;
declare const anthropicExecutor: RouterExecutor;

const router = createRouter({
  models: [
    { id: "openai/gpt-6-luna", executor: "openai" },
    { id: "anthropic/claude-fable-5-1", executor: "anthropic" },
  ],
  executors: { openai: openAIExecutor, anthropic: anthropicExecutor },
  policy: ({ candidates }) => ({ model: candidates[0]!.id }),
});
```

The [custom executors guide](https://docs.dari.dev/framework/custom-executors) covers the full contract, including streaming and cache keys.

## Hosted Auto Router

`createAutoRouter` is a hosted policy. You keep the router and executors; Dari makes the selection:

```ts
import { createAutoRouter, createRouter, type RouterExecutor } from "@mupt-ai/dari-router";

declare const executor: RouterExecutor; // see "Connecting a provider"

const router = createRouter({
  models: [
    { id: "openai/gpt-6-luna", executor: "provider" },
    { id: "anthropic/claude-fable-5-1", executor: "provider" },
  ],
  executors: { provider: executor },
  policy: createAutoRouter({ apiKey: process.env.DARI_API_KEY! }),
});
```

- It requires a Dari API key with billing enabled. Each selection call costs $0.01, billed to your organization.
- The selection request sends the conversation and eligible candidates to Dari. Provider credentials, request metadata, and user identity are not sent. Readable message content, tool arguments and results, and readable reasoning may be. Review this before enabling it for sensitive traffic.
- Provider calls still happen in your process, with your credentials.

For a fully hosted endpoint, with Dari handling credentials and execution too, see the [Managed Router](https://docs.dari.dev/router/overview). Runnable managed manifests are in [`examples/managed/`](examples/managed/).

## Operations

`createRouter` accepts optional operational settings:

- **`leaseStore`** keeps, per `cacheKey` (OpenAI `prompt_cache_key`), the leases a policy commits with `leaseTurnsRemaining` > 0, so the conversation's next turns stay on the same model without calling the policy again, plus session pins, speculative previous decisions, and prefetched successors when those options are on. Leases count completed assistant turns in the request's history, not requests, so retries do not use a turn and the position survives restarts. The default store is in memory with a 30-minute TTL. Inject a persistent store to share leases across processes.
- **`fallback`** (off by default) retries one eligible alternate model when the primary executor fails before any output reaches the client. A stream that fails after its first event ends with an error instead.
- **`speculative`** serves a conversation's previous decision immediately and runs the policy in the background; its answer serves the next turn. It applies to requests with a `cacheKey`, after the first turn. Leases take precedence, and a failed background selection keeps the previous model.
- **`leasePrefetchTurns`** selects a lease's successor in the background when the lease has that many turns left, so the turn after the lease ends does not wait for the policy.
- **`sessionPinKey`** returns a session key for a request. Each session routes once and keeps that model and reasoning level, bypassing leases and speculation.
- **`strict`** serves only requests that name a model as `dari/model/<id>`. Any router serves such a request as named, without the policy.
- **`hooks`** receive selection and request events for telemetry, billing, or logging. They are fire-and-forget. Each selection reports its `source`: `policy`, `explicit_model`, `strict_model`, `session_pin`, `lease_hold`, `prefetched_lease`, `speculative`, or `fallback`.

`router.evaluatePolicy()` previews a decision without touching leases or hooks. `router.select()` makes the same lease-aware selection that `router.fetch()` uses. See the [operations guide](https://docs.dari.dev/framework/operations) for details.

## Advanced subpaths

The root export is the framework. These subpaths expose the parts it is built from. Most applications do not need them.

**`@mupt-ai/dari-router/policy-engine`** is deterministic and has no provider SDK dependencies. It contains route preparation and finalization (`prepareRoute`, `finalizeRoute`), cache-aware evidence, selector parsing, anonymous actions, and the optional Dari policy:

```ts
import { prepareRoute, finalizeRoute } from "@mupt-ai/dari-router/policy-engine";
```

**`@mupt-ai/dari-router/protocols`** provides pure OpenAI Chat Completions and Anthropic Messages adapters (`openAIChatRequest`, `openAIChatResponse`, `anthropicRequest`, `anthropicResponse`), plus helpers for continuation and reasoning state.

**`@mupt-ai/dari-router/eval-score-imputation`** is browser-safe and needs no provider SDKs. It estimates missing benchmark scores across reasoning levels:

```ts
import {
  createThinkingLevelRatios,
  resolveRouterEvalScore,
} from "@mupt-ai/dari-router/eval-score-imputation";
```

Imputation learns a separate thinking-level graph for each model owner (the canonical ID namespace, such as `openai` or `anthropic`), not for each serving provider. Measured scores and calibration data are never changed. Estimated scores are made nondecreasing with reasoning effort. The graph algorithm lives in `src/thinking_level_graph.ts`, and eval parsing and normalization live in `src/eval_score_imputation.ts`.

The `dari-gateway` package builds on this package's `/policy-engine` and `/protocols` subpaths and imports `RouterFrameworkError` from the root entry. It does not use `createRouter`.

## Examples

The [`examples/`](examples/) directory holds runnable TypeScript examples:

| Script | Entry point | Needs |
| --- | --- | --- |
| `bun run example` | `examples/create_router.ts` | Nothing. Runs in-process. |
| `bun run example:decision-pipeline` | `examples/basic_route.ts` | Nothing. Scripted selector. |
| `bun run example:dari-policy` | `examples/dari_policy.ts` | Nothing. Scripted selector and local executor. |
| `bun run example:lease-stores` | `examples/lease_stores.ts` | Nothing. In-file fake stores. |

`examples/auto_router.ts` shows the hosted Auto Router. It needs a Dari API key and uses a local stub executor, which you replace with a provider call.

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun run test:package   # builds, packs, and smoke-tests the package in a clean consumer
```

Releases are published from the public mirror of this package; see [RELEASING.md](RELEASING.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
