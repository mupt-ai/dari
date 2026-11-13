import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import { createRequestHandler } from "./handler.js";
import { createPrioritySelectorBackend } from "../strategies/priority_selector.js";
import { testPlatform } from "../test_support/platform.js";
import type { ResolvedRouter } from "../types.js";

// Codex's native compaction end to end: the priority selector would pick
// Claude first, so a request served by OpenAI proves the compaction filter
// narrowed the candidates, and the upstream body proves the opaque state was
// relayed verbatim.
const CLAUDE = "anthropic/claude-sonnet-5-5";
const GPT = "openai/gpt-5.5";
const COMPACTION = { type: "compaction", id: "cmp_1", encrypted_content: "provider-ciphertext" };

type Call = { url: string; body: Record<string, unknown> };
const calls: Call[] = [];
const realFetch = globalThis.fetch;
let handler: (request: Request) => Promise<Response>;
let router: ResolvedRouter;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, body: await request.json() as Record<string, unknown> });
    return compactionResponse();
  }) as typeof fetch;
  handler = createRequestHandler({
    platform: testPlatform({ resolveRouter: async () => router }),
    selectorBackend: createPrioritySelectorBackend(),
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls.length = 0;
  router = compactionRouter({ native_compaction: true });
});

test("a compaction trigger routes only to native-compaction models and relays the compaction item", async () => {
  const response = await responses([
    { role: "user", content: "hello" },
    { type: "compaction_trigger" },
  ]);
  const body = await response.text();
  expect({ status: response.status, body: response.status === 200 ? "" : body }).toEqual({ status: 200, body: "" });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses");
  expect(calls[0]!.body.input).toContainEqual({ type: "compaction_trigger" });
  expect(completedOutput(body)).toEqual([COMPACTION]);
});

test("a non-streaming compaction returns the compaction item", async () => {
  const response = await responses([{ role: "user", content: "hello" }, { type: "compaction_trigger" }], false);
  expect(response.status).toBe(200);
  expect(((await response.json()) as { output: unknown }).output).toEqual([COMPACTION]);
});

test("compacted history reaches the provider verbatim", async () => {
  const response = await responses([COMPACTION, { role: "user", content: "continue" }]);
  expect(response.status).toBe(200);
  await response.text();
  expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses");
  expect(calls[0]!.body.input).toContainEqual(COMPACTION);
});

test("a router without native compaction refuses compaction state", async () => {
  router = compactionRouter({});
  const response = await responses([{ role: "user", content: "hello" }, { type: "compaction_trigger" }]);
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("native_compaction_disabled");
  expect(calls).toHaveLength(0);
});

test("a router with no native-compaction model refuses compaction state", async () => {
  router = compactionRouter({ native_compaction: true, enabled_models: [CLAUDE] });
  const response = await responses([COMPACTION, { role: "user", content: "continue" }]);
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("no_native_compaction_candidates");
  expect(calls).toHaveLength(0);
});

function compactionRouter(overrides: Partial<ResolvedRouter>): ResolvedRouter {
  return {
    router_id: "rtr_compaction",
    organization_id: "org_compaction",
    api_key_id: null,
    attributed_user_id: null,
    enabled_models: [CLAUDE, GPT],
    provider_keys: { anthropic: "anthropic-key", openai: "openai-key" },
    strict: false,
    primary_retries: 0,
    lease_context_enabled: false,
    routing_strategy: "dari",
    ...overrides,
  };
}

async function responses(input: Array<Record<string, unknown>>, stream = true): Promise<Response> {
  return await handler(new Request("http://gateway.test/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer gw-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "dari/routing", stream, input }),
  }));
}

function completedOutput(body: string): unknown {
  for (const chunk of body.split("\n\n")) {
    const data = chunk.split("\n").find((line) => line.startsWith("data: "));
    if (!data) continue;
    const event = JSON.parse(data.slice("data: ".length)) as Record<string, unknown>;
    if (event.type === "response.completed") return (event.response as Record<string, unknown>).output;
  }
  throw new Error(`no response.completed in:\n${body}`);
}

function compactionResponse(): Response {
  const response = { id: "resp_1", object: "response", model: "gpt-5.5", status: "in_progress", output: [] };
  const events = [
    { type: "response.created", sequence_number: 0, response },
    { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: COMPACTION },
    { type: "response.output_item.done", sequence_number: 2, output_index: 0, item: COMPACTION },
    {
      type: "response.completed",
      sequence_number: 3,
      response: {
        ...response,
        status: "completed",
        output: [COMPACTION],
        usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100, input_tokens_details: { cached_tokens: 0 } },
      },
    },
  ];
  const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}
