import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import type { ProviderCredentialRequest, RequestRecord, SubscriptionHold } from "../platform/platform.js";
import { createPrioritySelectorBackend } from "../strategies/priority_selector.js";
import { testPlatform } from "../test_support/platform.js";
import type { ProviderCredential, ResolvedRouter } from "../types.js";
import { createRequestHandler } from "./handler.js";

// An embedder supplies a subscription per request through
// resolveProviderCredential; a strict router serves its pinned model on it.
type ProviderCall = { url: string; authorization: string | null; apiKey: string | null; model: unknown; clientId?: string };

const calls: ProviderCall[] = [];
const records: RequestRecord[] = [];
const holds: SubscriptionHold[] = [];
const credentialRequests: ProviderCredentialRequest[] = [];
const resolvedRouterIds: string[] = [];
const resolvedHarnesses: unknown[] = [];
const realFetch = globalThis.fetch;
let supplied: Record<string, ProviderCredential> = {};
let handler: (request: Request) => Promise<Response>;
let router: ResolvedRouter;

const CLAUDE = "anthropic/claude-sonnet-5-5";
const MUSE = "meta/muse-spark-1.3";
const GPT = "openai/gpt-5.5";
// A ChatGPT access token carries its account id; Pi reads it from the JWT.
const CODEX_TOKEN = [
  "e30",
  Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } })).toString("base64url"),
  "sig",
].join(".");

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await jsonBody(request);
    calls.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      apiKey: request.headers.get("x-api-key"),
      model: body.model,
      ...(request.headers.has("x-client-id") ? { clientId: request.headers.get("x-client-id")! } : {}),
    });
    return new URL(request.url).pathname.endsWith("/messages")
      ? messagesResponse(String(body.model))
      : responsesResponse(String(body.model));
  }) as typeof fetch;
  handler = createRequestHandler({
    platform: testPlatform({
      resolveRouter: async (request) => {
        resolvedRouterIds.push(request.routerId);
        resolvedHarnesses.push(request.clientHarness);
        return router;
      },
      async resolveProviderCredential(request) {
        credentialRequests.push(request);
        return supplied[request.model];
      },
      async markSubscriptionUnavailable(hold) {
        holds.push(hold);
        return false;
      },
      recordRequest: (record) => {
        records.push(record);
      },
    }),
    selectorBackend: createPrioritySelectorBackend(),
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls.length = 0;
  records.length = 0;
  holds.length = 0;
  credentialRequests.length = 0;
  resolvedRouterIds.length = 0;
  resolvedHarnesses.length = 0;
  supplied = {};
  router = strictRouter({});
});

test("a strict router serves Muse Code its pinned model on a platform-supplied Meta sign-in", async () => {
  supplied = { [MUSE]: { apiKey: "muse-minted-key", subscription: "meta_muse" } };
  const response = await chat(MUSE, { museCode: true });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-dari-provider-key-source")).toBe("subscription");
  await response.text();
  expect(calls).toEqual([{
    url: "https://api.meta.ai/v1/responses",
    authorization: "Bearer muse-minted-key",
    apiKey: null,
    model: "muse-spark-1.3",
    clientId: "tbh:exec",
  }]);
  expect(credentialRequests[0]!.clientHarness).toBe("muse_code");
  await waitFor(() => records.length === 1);
  expect(records[0]!.summary.provider_key_source).toBe("subscription");
});

test("a supplied plan keeps serving once the org's credits are exhausted", async () => {
  supplied = { [MUSE]: { apiKey: "muse-minted-key", subscription: "meta_muse" } };
  router = strictRouter({ credit_exhausted: true });
  const response = await chat(MUSE, { museCode: true });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-dari-provider-key-source")).toBe("subscription");
  await response.text();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ authorization: "Bearer muse-minted-key" });
});

test("a supplied API key stays gated once the org's credits are exhausted", async () => {
  supplied = { [MUSE]: { apiKey: "meta-tenant-key" } };
  router = strictRouter({ credit_exhausted: true });
  const response = await chat(MUSE);
  expect(response.status).toBe(402);
  await response.text();
  expect(calls).toEqual([]);
});

test("a supplied ChatGPT plan serves OpenAI models through the Codex backend", async () => {
  supplied = { [GPT]: { apiKey: CODEX_TOKEN, subscription: "openai_codex" } };
  const response = await chat(GPT);
  expect(response.status).toBe(200);
  await response.text();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    url: "https://chatgpt.com/backend-api/codex/responses",
    authorization: `Bearer ${CODEX_TOKEN}`,
  });
});

test("a supplied ChatGPT plan keeps the router's catalog limits", async () => {
  supplied = { [GPT]: { apiKey: CODEX_TOKEN, subscription: "openai_codex" } };
  router = strictRouter({
    model_configs: {
      [GPT]: {
        provider: "openai",
        native_model_id: "gpt-5.5",
        api: "openai-responses",
        standard_context_limit: 1,
        cost: { input: 5, output: 30 },
      },
    },
  });
  // The standard-price limit prunes the model before any provider call.
  const response = await chat(GPT);
  expect(response.status).toBe(400);
  expect((await response.json() as { error: { code: string } }).error.code).toBe("model_unavailable");
  expect(calls).toEqual([]);
});

test("a supplied Claude Code plan serves Claude Code clients", async () => {
  supplied = { [CLAUDE]: { apiKey: "sk-ant-oat01-plan", subscription: "anthropic_claude_code" } };
  const response = await messages(CLAUDE, { claudeCode: true });
  expect(response.status).toBe(200);
  await response.text();
  expect(credentialRequests[0]!.clientHarness).toBe("claude_code");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ authorization: "Bearer sk-ant-oat01-plan", apiKey: null });
});

test("a supplied Claude Code plan never serves other clients", async () => {
  supplied = { [CLAUDE]: { apiKey: "sk-ant-oat01-plan", subscription: "anthropic_claude_code" } };
  const response = await messages(CLAUDE, { claudeCode: false });
  expect(response.status).toBe(200);
  await response.text();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ authorization: null, apiKey: "anthropic-key" });
});

test("a supplied Muse Code plan never serves other clients", async () => {
  supplied = { [MUSE]: { apiKey: "muse-minted-key", subscription: "meta_muse" } };
  const response = await chat(MUSE);
  expect(response.status).toBe(200);
  await response.text();
  expect(credentialRequests[0]!.clientHarness).toBeUndefined();
  expect(calls).toEqual([{
    url: "https://api.meta.ai/v1/responses",
    authorization: "Bearer meta-key",
    apiKey: null,
    model: "muse-spark-1.3",
  }]);
});

test("Muse Code is recognized on the Responses API too", async () => {
  supplied = { [MUSE]: { apiKey: "muse-minted-key", subscription: "meta_muse" } };
  const response = await handler(new Request("http://gateway.test/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gw-key", "content-type": "application/json", "x-client-id": "tbh:tui" },
    body: JSON.stringify({ model: `dari/model/${MUSE}`, stream: true, input: "hello" }),
  }));
  expect(response.status).toBe(200);
  await response.text();
  expect(calls[0]).toMatchObject({ authorization: "Bearer muse-minted-key", clientId: "tbh:tui" });
});

test("Muse Code's origin-root model list serves the router's models under the routing key", async () => {
  const response = await handler(new Request("http://gateway.test/muse-code/models", {
    headers: { authorization: "Bearer gw-key", "x-client-id": "tbh:exec" },
  }));
  expect(response.status).toBe(200);
  const body = await response.json() as { data: Array<{ id: string; is_default: boolean }> };
  expect(body.data.map((row) => row.id)).toEqual([
    "dari/routing",
    `dari/model/${CLAUDE}`,
    `dari/model/${MUSE}`,
    `dari/model/${GPT}`,
  ]);
  expect(body.data[0]!.is_default).toBe(true);
  expect(resolvedRouterIds).toEqual(["default"]);
  expect(resolvedHarnesses).toEqual(["muse_code"]);
});

test("a named router's Muse Code model list resolves that router", async () => {
  const response = await handler(new Request("http://gateway.test/rtr_bench/muse-code/models", {
    headers: { authorization: "Bearer gw-key" },
  }));
  expect(response.status).toBe(200);
  expect(((await response.json()) as { data: unknown[] }).data).toHaveLength(4);
  expect(resolvedRouterIds).toEqual(["rtr_bench"]);
});

test("a plan for another provider is ignored", async () => {
  supplied = { [GPT]: { apiKey: "muse-minted-key", subscription: "meta_muse" } };
  const response = await chat(GPT);
  expect(response.status).toBe(200);
  await response.text();
  expect(calls[0]).toMatchObject({ url: "https://api.openai.com/v1/responses", authorization: "Bearer openai-key" });
});

test("strict routers still refuse subscriptions the platform did not supply", async () => {
  router = strictRouter({ provider_key_sources: { meta: "subscription" } });
  const response = await chat(MUSE);
  expect(response.status).toBe(400);
  expect((await response.json() as { error: { code: string } }).error.code).toBe("strict_subscription_refused");
  expect(calls).toEqual([]);
});

test("a supplied plan at its usage limit is reported, not held", async () => {
  supplied = { [GPT]: { apiKey: CODEX_TOKEN, subscription: "openai_codex" } };
  router = strictRouter({ attributed_user_id: "user_1" });
  const recording = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(
    { error: { code: "usage_limit_reached", message: "You've hit your usage limit." } },
    { status: 429 },
  )) as unknown as typeof fetch;
  try {
    const response = await chat(GPT);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).toContain("subscription_usage_limit");
  } finally {
    globalThis.fetch = recording;
  }
  expect(holds).toEqual([]);
});

function strictRouter(overrides: Partial<ResolvedRouter>): ResolvedRouter {
  return {
    router_id: "rtr_bench",
    organization_id: "org_bench",
    api_key_id: null,
    attributed_user_id: null,
    enabled_models: [CLAUDE, MUSE, GPT],
    provider_keys: { anthropic: "anthropic-key", meta: "meta-key", openai: "openai-key" },
    strict: true,
    primary_retries: 0,
    lease_context_enabled: false,
    routing_strategy: "dari",
    ...overrides,
  };
}

async function chat(model: string, args: { museCode?: boolean } = {}): Promise<Response> {
  return await handler(new Request("http://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer gw-key",
      "content-type": "application/json",
      ...(args.museCode ? { "x-client-id": "tbh:exec" } : {}),
    },
    body: JSON.stringify({
      model: `dari/model/${model}`,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  }));
}

async function messages(model: string, args: { claudeCode: boolean }): Promise<Response> {
  const claudeCodeHeaders = {
    "user-agent": "claude-cli/2.1.300 (external, cli)",
    "x-app": "cli",
    "x-claude-code-session-id": "8f0c2a4e-1b3d-4c5e-9f60-7a8b9c0d1e2f",
  };
  return await handler(new Request("http://gateway.test/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": "gw-key",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      ...(args.claudeCode ? claudeCodeHeaders : {}),
    },
    body: JSON.stringify({
      model: `dari/model/${model}`,
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  }));
}

// The Codex backend takes zstd-compressed bodies; only JSON bodies are read.
async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return await request.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(condition()).toBe(true);
}

function sse(events: Array<Record<string, unknown>>): Response {
  const text = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

function responsesResponse(model: string): Response {
  const message = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "hi", annotations: [] }],
  };
  const response = { id: "resp_1", object: "response", model, status: "in_progress", output: [] };
  return sse([
    { type: "response.created", sequence_number: 0, response },
    { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", sequence_number: 2, output_index: 0, item_id: "msg_1", content_index: 0, delta: "hi" },
    { type: "response.output_item.done", sequence_number: 3, output_index: 0, item: message },
    {
      type: "response.completed",
      sequence_number: 4,
      response: {
        ...response,
        status: "completed",
        output: [message],
        usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, total_tokens: 12 },
      },
    },
  ]);
}

function messagesResponse(model: string): Response {
  return sse([
    {
      type: "message_start",
      message: {
        id: "msg_1", type: "message", role: "assistant", model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ]);
}
