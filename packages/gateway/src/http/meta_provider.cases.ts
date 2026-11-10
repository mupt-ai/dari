import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import { createRequestHandler } from "./handler.js";
import type { RequestRecord } from "../platform/platform.js";
import { createPrioritySelectorBackend } from "../strategies/priority_selector.js";
import { testPlatform } from "../test_support/platform.js";
import type { ResolvedRouter } from "../types.js";

// Meta's Model API as a built-in provider on a strict router: the platform
// supplies only the key, and the gateway brings Meta's endpoint, wire API,
// thinking levels, and pricing.
type MetaCall = { url: string; authorization: string | null; apiKey: string | null; body: Record<string, unknown> };

const calls: MetaCall[] = [];
const records: RequestRecord[] = [];
const realFetch = globalThis.fetch;
let handler: (request: Request) => Promise<Response>;
let router: ResolvedRouter;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.json() as Record<string, unknown>;
    calls.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      apiKey: request.headers.get("x-api-key"),
      body,
    });
    return new URL(request.url).pathname.endsWith("/messages")
      ? messagesResponse(String(body.model))
      : responsesResponse(String(body.model));
  }) as typeof fetch;
  handler = createRequestHandler({
    platform: testPlatform({
      resolveRouter: async () => router,
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
  router = metaRouter({});
});

test("a strict router serves dari/model/meta/<id> on Meta's Responses API", async () => {
  const response = await chat({ model: "dari/model/meta/muse-spark-1.3", reasoning_effort: "xhigh" });
  expect(response.status).toBe(200);
  await response.text();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://api.meta.ai/v1/responses");
  expect(calls[0]!.authorization).toBe("Bearer meta-key");
  expect(calls[0]!.body).toMatchObject({ model: "muse-spark-1.3", reasoning: { effort: "xhigh" } });
  await waitFor(() => records.length === 1);
  expect(records[0]!.summary).toMatchObject({
    status: "completed",
    selected_provider: "meta",
    selected_reasoning_effort: "xhigh",
    cost_source: "pricing",
    pricing_known: true,
  });
  expect(records[0]!.summary.total_cost_usd).toBeGreaterThan(0);
});

test("Muse serves every effort from none through max", async () => {
  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    calls.length = 0;
    const response = await chat({ model: "dari/model/meta/muse-wonder-1.0", reasoning_effort: effort });
    expect({ effort, status: response.status }).toEqual({ effort, status: 200 });
    await response.text();
    const reasoning = calls[0]!.body.reasoning as { effort?: string } | undefined;
    expect({ effort, wire: reasoning?.effort }).toEqual({ effort, wire: effort });
  }
});

test("Meta's Anthropic Messages endpoint takes the key as a bearer token", async () => {
  router = metaRouter({
    model_configs: {
      "meta/muse-spark-1.3": {
        provider: "meta",
        native_model_id: "muse-spark-1.3",
        api: "anthropic-messages",
        base_url: "https://api.meta.ai",
        cost: { input: 1.25, output: 4.25 },
      },
    },
  });
  const response = await chat({ model: "dari/model/meta/muse-spark-1.3" });
  expect(response.status).toBe(200);
  await response.text();
  expect(calls[0]!.url).toStartWith("https://api.meta.ai/v1/messages");
  expect(calls[0]!.authorization).toBe("Bearer meta-key");
  expect(calls[0]!.apiKey).toBeNull();
});

test("a Muse id newer than the Pi registry still serves none through max", async () => {
  router = metaRouter({ enabled_models: ["meta/muse-future-9.0"] });
  for (const effort of ["none", "low", "high", "max"]) {
    calls.length = 0;
    const response = await chat({ model: "dari/model/meta/muse-future-9.0", reasoning_effort: effort });
    expect({ effort, status: response.status }).toEqual({ effort, status: 200 });
    await response.text();
    expect(calls[0]!.url).toBe("https://api.meta.ai/v1/responses");
    const reasoning = calls[0]!.body.reasoning as { effort?: string } | undefined;
    expect({ effort, wire: reasoning?.effort }).toEqual({ effort, wire: effort });
  }
});

function metaRouter(overrides: Partial<ResolvedRouter>): ResolvedRouter {
  return {
    router_id: "rtr_meta",
    organization_id: "org_meta",
    api_key_id: null,
    attributed_user_id: null,
    enabled_models: ["meta/muse-spark-1.3", "meta/muse-wonder-1.0"],
    provider_keys: { meta: "meta-key" },
    strict: true,
    primary_retries: 0,
    lease_context_enabled: false,
    routing_strategy: "dari",
    ...overrides,
  };
}

async function chat(args: { model: string; reasoning_effort?: string }): Promise<Response> {
  return await handler(new Request("http://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer gw-key", "content-type": "application/json" },
    body: JSON.stringify({
      model: args.model,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
      ...(args.reasoning_effort ? { reasoning_effort: args.reasoning_effort } : {}),
    }),
  }));
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
    { type: "response.content_part.added", sequence_number: 2, output_index: 0, item_id: "msg_1", content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", sequence_number: 3, output_index: 0, item_id: "msg_1", content_index: 0, delta: "hi" },
    { type: "response.output_text.done", sequence_number: 4, output_index: 0, item_id: "msg_1", content_index: 0, text: "hi" },
    { type: "response.content_part.done", sequence_number: 5, output_index: 0, item_id: "msg_1", content_index: 0, part: message.content[0] },
    { type: "response.output_item.done", sequence_number: 6, output_index: 0, item: message },
    {
      type: "response.completed",
      sequence_number: 7,
      response: {
        ...response,
        status: "completed",
        output: [message],
        usage: {
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 100,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 1100,
        },
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
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 100 } },
    { type: "message_stop" },
  ]);
}
