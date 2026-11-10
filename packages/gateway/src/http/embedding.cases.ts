import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import { testPlatform } from "../test_support/platform.js";
import { createPrioritySelectorBackend } from "../strategies/priority_selector.js";
import type { ProviderCredentialRequest, RequestRecord } from "../platform/platform.js";
import type { ResolvedRouter } from "../types.js";
import { createRequestHandler } from "./handler.js";

// An embedder's view of the gateway: its own platform supplies per-request
// BYOK credentials and receives exact usage, against a local stand-in for
// OpenRouter that reports billed cost.
type UpstreamCall = { model: string; authorization: string | null; tenant: string | null };

const upstreamCalls: UpstreamCall[] = [];
const credentialRequests: ProviderCredentialRequest[] = [];
const records: RequestRecord[] = [];
let upstreamStatus = 200;
let supplyCredentials = true;
let upstream: ReturnType<typeof Bun.serve>;
let handler: (request: Request) => Promise<Response>;
let router: ResolvedRouter;

const MODEL_A = "openrouter/acme/model-a";
const MODEL_B = "openrouter/acme/model-b";

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json() as { model: string; stream?: boolean };
      upstreamCalls.push({
        model: body.model,
        authorization: request.headers.get("authorization"),
        tenant: request.headers.get("x-tenant"),
      });
      if (upstreamStatus !== 200) {
        return Response.json({ error: { message: "upstream unavailable" } }, { status: upstreamStatus });
      }
      return completionResponse(body.model, body.stream === true);
    },
  });
  handler = createRequestHandler({
    platform: testPlatform({
      resolveRouter: async () => router,
      async resolveProviderCredential(request) {
        credentialRequests.push(request);
        if (!supplyCredentials) return undefined;
        return {
          apiKey: `byok-${request.model}`,
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          headers: { "x-tenant": request.organizationId },
        };
      },
      recordRequest: (record) => {
        records.push(record);
      },
    }),
    selectorBackend: createPrioritySelectorBackend(),
  });
});

afterAll(async () => {
  await upstream.stop(true);
});

beforeEach(() => {
  upstreamCalls.length = 0;
  credentialRequests.length = 0;
  records.length = 0;
  upstreamStatus = 200;
  supplyCredentials = true;
  router = resolvedRouter({});
});

test("platform credentials replace the resolved key, endpoint, and headers", async () => {
  const response = await chat({ model: `dari/model/${MODEL_A}` });
  expect(response.status).toBe(200);
  await response.text();
  expect(upstreamCalls).toEqual([
    { model: "acme/model-a", authorization: `Bearer byok-${MODEL_A}`, tenant: "org_embed" },
  ]);
  expect(credentialRequests.map((request) => request.model).sort()).toEqual([MODEL_A, MODEL_B]);
  expect(credentialRequests[0]).toMatchObject({
    provider: "openrouter",
    routerId: "rtr_embed",
    organizationId: "org_embed",
    apiKey: "gw-key",
  });
});

test("records carry exact usage, provider-reported cost, and tags", async () => {
  const response = await chat({
    model: `dari/model/${MODEL_A}`,
    headers: { "x-dari-tags": "run=r1, trial=3,setting=low" },
  });
  expect(response.status).toBe(200);
  await response.text();
  await waitFor(() => records.length === 1);
  expect(records[0]!.tags).toEqual({ run: "r1", trial: "3", setting: "low" });
  expect(records[0]!.summary).toMatchObject({
    status: "completed",
    input_tokens: 5,
    cache_read_tokens: 2,
    cache_write_tokens: 1,
    output_tokens: 3,
    total_cost_usd: 0.0123,
    cost_source: "provider",
  });
});

test("records carry the router's non-secret routing settings", async () => {
  router = resolvedRouter({ speculative_routing: true, session_pinning: true });
  const response = await chat({ model: `dari/model/${MODEL_B}` });
  expect(response.status).toBe(200);
  await response.text();
  await waitFor(() => records.length === 1);
  expect(records[0]!.router).toEqual({
    enabledModels: [MODEL_A, MODEL_B],
    thinkingLevels: { [MODEL_A]: ["off"], [MODEL_B]: ["off", "high"] },
    defaultThinkingLevels: { [MODEL_A]: "off", [MODEL_B]: "off" },
    strict: false,
    speculativeRouting: true,
    sessionPinning: true,
  });
  expect(records[0]!.candidates).toHaveLength(3);
  expect(records[0]!.candidates).toEqual(expect.arrayContaining([
    { model: MODEL_A, reasoningEffort: "off" },
    { model: MODEL_B, reasoningEffort: "off" },
    { model: MODEL_B, reasoningEffort: "high" },
  ]));
});

test("malformed tags are refused before any provider call", async () => {
  const response = await chat({ model: `dari/model/${MODEL_A}`, headers: { "x-dari-tags": "no-equals" } });
  expect(response.status).toBe(400);
  expect((await response.json() as { error: { code: string } }).error.code).toBe("invalid_tags");
  expect(upstreamCalls).toEqual([]);
});

test("failed requests are recorded too", async () => {
  upstreamStatus = 500;
  const response = await chat({ model: `dari/model/${MODEL_A}` });
  expect(response.status).toBeGreaterThanOrEqual(400);
  await response.text();
  await waitFor(() => records.length === 1);
  expect(records[0]!.summary.status).toBe("provider_error");
  expect(records[0]!.summary.selected_model).toBe(MODEL_A);
});

test("a strict router refuses unpinned models and unavailable thinking levels", async () => {
  router = resolvedRouter({ strict: true });
  const routed = await chat({ model: "dari/routing" });
  expect(routed.status).toBe(400);
  expect((await routed.json() as { error: { code: string } }).error.code).toBe("strict_model_required");

  const effort = await chat({ model: `dari/model/${MODEL_A}`, reasoning_effort: "high" });
  expect(effort.status).toBe(400);
  expect((await effort.json() as { error: { code: string } }).error.code).toBe("model_unavailable");
  expect(upstreamCalls).toEqual([]);
});

test("provider-wide strict access serves a catalog model", async () => {
  router = resolvedRouter({ strict: true, strict_providers: ["openai"] });
  upstreamStatus = 500;
  const response = await chat({ model: "dari/model/openai/gpt-5.5" });
  expect(response.status).toBeGreaterThanOrEqual(400);
  await response.text();
  expect(credentialRequests.some((request) => request.model === "openai/gpt-5.5")).toBe(true);
  expect(upstreamCalls.length).toBeGreaterThan(0);
  expect(new Set(upstreamCalls.map((call) => call.model))).toEqual(new Set(["gpt-5.5"]));
});

test("a grant-only strict router refuses ungranted models with strict errors", async () => {
  router = resolvedRouter({ strict: true, strict_providers: ["openai"], enabled_models: [] });
  for (const [model, code] of [
    ["dari/routing", "strict_model_required"],
    ["dari/model/openai/not-a-real-model", "model_not_enabled"],
    [`dari/model/${MODEL_A}`, "model_not_enabled"],
  ]) {
    const response = await chat({ model });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe(code!);
  }
  expect(upstreamCalls).toEqual([]);
});

test("a strict router refuses personal subscriptions", async () => {
  router = resolvedRouter({ strict: true, provider_key_sources: { openrouter: "subscription" } });
  supplyCredentials = false;
  const response = await chat({ model: `dari/model/${MODEL_A}` });
  expect(response.status).toBe(400);
  expect((await response.json() as { error: { code: string } }).error.code).toBe("strict_subscription_refused");
  expect(upstreamCalls).toEqual([]);
});

function resolvedRouter(overrides: Partial<ResolvedRouter>): ResolvedRouter {
  const config = (nativeId: string) => ({
    provider: "openrouter",
    native_model_id: nativeId,
    api: "openai-completions",
    supported_thinking_levels: ["off" as const, "high" as const],
    default_thinking_level: "off" as const,
    cost: { input: 1, output: 1, cached_input: 0.1, cache_write: 1 },
  });
  return {
    router_id: "rtr_embed",
    organization_id: "org_embed",
    api_key_id: null,
    attributed_user_id: null,
    enabled_models: [MODEL_A, MODEL_B],
    provider_keys: { openrouter: "resolved-key" },
    primary_retries: 0,
    lease_context_enabled: false,
    routing_strategy: "dari",
    model_thinking_levels: { [MODEL_A]: ["off"], [MODEL_B]: ["off", "high"] },
    model_configs: { [MODEL_A]: config("acme/model-a"), [MODEL_B]: config("acme/model-b") },
    ...overrides,
  };
}

function chatRequest(args: {
  model: string;
  headers?: Record<string, string>;
  reasoning_effort?: string;
}): Request {
  return new Request("http://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gw-key", "content-type": "application/json", ...args.headers },
    body: JSON.stringify({
      model: args.model,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
      ...(args.reasoning_effort ? { reasoning_effort: args.reasoning_effort } : {}),
    }),
  });
}

async function chat(args: Parameters<typeof chatRequest>[0]): Promise<Response> {
  return await handler(chatRequest(args));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(condition()).toBe(true);
}

function completionResponse(model: string, stream: boolean): Response {
  const usage = {
    prompt_tokens: 8,
    completion_tokens: 3,
    total_tokens: 11,
    prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
    cost: 0.0123,
  };
  const text = `served by ${model}`;
  if (!stream) {
    return Response.json({
      id: "gen-1",
      object: "chat.completion",
      created: 0,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage,
    });
  }
  const chunks = [
    { choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage },
  ].map((chunk) => `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 0, model, ...chunk })}\n\n`);
  return new Response(`${chunks.join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}
