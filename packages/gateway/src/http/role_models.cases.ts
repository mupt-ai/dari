import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import type { RequestRecord } from "../platform/platform.js";
import type { SelectorBackend } from "../strategies/routing.js";
import { testPlatform } from "../test_support/platform.js";
import type { ResolvedRouter } from "../types.js";
import { createRequestHandler } from "./handler.js";

// Role models end to end through the real handler: the selector always picks
// MODEL_C, so any other served model proves the router's role model held.
const MODEL_A = "openrouter/acme/model-a";
const MODEL_B = "openrouter/acme/model-b";
const MODEL_C = "openrouter/acme/model-c";
const SESSION = "4b1f0c3e-2a6d-4e8f-9b7a-1c2d3e4f5a6b";

const records: RequestRecord[] = [];
const upstreamBodies: Array<{ model: string; messages: Array<{ role: string; content: unknown }> }> = [];
let selections = 0;
let upstream: ReturnType<typeof Bun.serve>;
let handler: (request: Request) => Promise<Response>;
let router: ResolvedRouter;

const selector: SelectorBackend = {
  selectorModel: "test/fixed",
  contextWindowChars: async () => 1_000_000,
  prepareMessages: () => [],
  supportsSpeculativeRouting: false,
  select: async (args) => {
    selections += 1;
    const candidate = args.candidates.find((candidate) => candidate.model === MODEL_C)!;
    return {
      decision: { selectedModel: candidate.model, reasoningEffort: candidate.reasoningEffort, reason: "Test." },
      selectorModel: args.selectorModel,
      candidates: args.candidates,
      selectorInput: args.selectorInput,
      selectorRequest: args.selectorRequest,
      outputText: "",
      usage: null,
      latencyMs: 0,
    };
  },
};

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json() as (typeof upstreamBodies)[number];
      upstreamBodies.push(body);
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } },
      ].map((chunk) => `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 0, model: body.model, ...chunk })}\n\n`);
      return new Response(`${chunks.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  handler = createRequestHandler({
    platform: testPlatform({
      resolveRouter: async () => router,
      resolveProviderCredential: async () => ({
        apiKey: "upstream-key",
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      }),
      recordRequest: (record) => {
        records.push(record);
      },
    }),
    selectorBackend: selector,
  });
});

afterAll(async () => {
  await upstream.stop(true);
});

beforeEach(() => {
  records.length = 0;
  upstreamBodies.length = 0;
  selections = 0;
  router = resolvedRouter({ role_models: { main: MODEL_A, subagent: MODEL_B } });
});

test("each role is served its fixed model without the selector", async () => {
  expect(await served({ requestClass: "main" })).toBe(MODEL_A);
  expect(await served({ requestClass: "subagent", agentId: "agent_explore" })).toBe(MODEL_B);
  expect(await served({ requestClass: "workflow", agentId: "agent_step" })).toBe(MODEL_B);
  // Requests without Claude Code's role headers are the main agent.
  expect(await served({})).toBe(MODEL_A);
  expect(selections).toBe(0);

  await waitForRecords(4);
  expect(records.map((record) => record.row.decision_details)).toContainEqual(expect.objectContaining({
    decision_source: "role_model",
    explicit_model: { model: MODEL_B, reasoning_effort: "off", role: "subagent" },
  }));
});

test("a fixed role overrides the model the client asked for", async () => {
  expect(await served({ requestClass: "main", model: `dari/model/${MODEL_C}` })).toBe(MODEL_A);
});

test("a role without a fixed model is routed", async () => {
  router = resolvedRouter({ role_models: { main: null, subagent: MODEL_B } });
  expect(await served({ requestClass: "main" })).toBe(MODEL_C);
  expect(await served({ requestClass: "subagent", agentId: "agent_explore" })).toBe(MODEL_B);
  expect(selections).toBe(1);
});

test("background requests keep their own routing", async () => {
  router = resolvedRouter({ role_models: { main: MODEL_C, subagent: MODEL_C } });
  // MODEL_A is the cheapest, which background work is served.
  expect(await served({ requestClass: "auxiliary" })).toBe(MODEL_A);
});

test("routing rules do not hide a fixed role's model", async () => {
  router = resolvedRouter({
    role_models: { main: MODEL_A },
    routing_strategy: "custom",
    custom_config: { rules: [{ when: "everything", use: MODEL_C }] },
  });
  expect(await served({ requestClass: "main" })).toBe(MODEL_A);
});

test("each role's prompt ends its system prompt, routed or fixed", async () => {
  router = resolvedRouter({
    role_models: { subagent: MODEL_B },
    role_prompts: { main: "Delegate exploration to subagents.", subagent: "Report back briefly." },
  });
  await served({ requestClass: "main", system: "You are Claude Code." });
  await served({ requestClass: "subagent", agentId: "agent_explore", system: "You are Claude Code." });
  await served({ requestClass: "auxiliary", system: "You are Claude Code." });

  expect(upstreamBodies.map((body) => body.messages[0])).toEqual([
    { role: "system", content: "You are Claude Code.\n\nDelegate exploration to subagents." },
    { role: "system", content: "You are Claude Code.\n\nReport back briefly." },
    { role: "system", content: "You are Claude Code." },
  ]);
});

async function served(args: { requestClass?: string; agentId?: string; model?: string; system?: string }): Promise<string> {
  const response = await handler(new Request("http://gateway.test/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": "gw-key",
      "content-type": "application/json",
      "user-agent": "claude-cli/2.1.0 (external, cli)",
      "x-app": "cli",
      "x-claude-code-session-id": SESSION,
      ...(args.requestClass === undefined ? {} : { "x-claude-code-request-class": args.requestClass }),
      ...(args.agentId === undefined ? {} : { "x-claude-code-agent-id": args.agentId }),
    },
    body: JSON.stringify({
      model: args.model ?? "dari/routing",
      max_tokens: 64,
      ...(args.system === undefined ? {} : { system: args.system }),
      messages: [{ role: "user", content: `task for ${args.agentId ?? "main"}` }],
    }),
  }));
  const body = await response.json() as { dari_routing?: { selected_model?: string } };
  expect({ status: response.status, body: response.status === 200 ? null : body }).toEqual({ status: 200, body: null });
  return body.dari_routing!.selected_model!;
}

async function waitForRecords(count: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && records.length < count; attempt += 1) await Bun.sleep(5);
  expect(records).toHaveLength(count);
}

function resolvedRouter(overrides: Partial<ResolvedRouter>): ResolvedRouter {
  const config = (nativeId: string, price: number) => ({
    provider: "openrouter",
    native_model_id: nativeId,
    api: "openai-completions",
    supported_thinking_levels: ["off" as const],
    default_thinking_level: "off" as const,
    cost: { input: price, output: price, cached_input: price / 10, cache_write: price },
  });
  return {
    router_id: "rtr_roles",
    organization_id: "org_roles",
    api_key_id: null,
    attributed_user_id: null,
    enabled_models: [MODEL_A, MODEL_B, MODEL_C],
    provider_keys: { openrouter: "resolved-key" },
    primary_retries: 0,
    lease_context_enabled: false,
    routing_strategy: "dari",
    model_thinking_levels: { [MODEL_A]: ["off"], [MODEL_B]: ["off"], [MODEL_C]: ["off"] },
    model_prices: { [MODEL_A]: { input: 1, output: 1 }, [MODEL_B]: { input: 2, output: 2 }, [MODEL_C]: { input: 3, output: 3 } },
    model_configs: {
      [MODEL_A]: config("acme/model-a", 1),
      [MODEL_B]: config("acme/model-b", 2),
      [MODEL_C]: config("acme/model-c", 3),
    },
    ...overrides,
  };
}
