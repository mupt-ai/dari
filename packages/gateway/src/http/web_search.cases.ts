import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import type { SelectorBackend } from "../strategies/routing.js";
import { testPlatform } from "../test_support/platform.js";
import type { ResolvedRouter } from "../types.js";
import { createRequestHandler } from "./handler.js";

// Web search end to end through the real handler. Claude Code sends a
// background request with Anthropic's `web_search` tool, answered by a Claude
// API upstream. The Dari extension's search tool for Pi sends that request or
// an OpenAI hosted search, whichever the router can serve.
const HAIKU = "anthropic/claude-haiku-4-5";
const OPUS = "anthropic/claude-opus-4-8";
const GPT = "openrouter/acme/model-a";
const TERRA = "openai/gpt-6.1-terra";
const LUNA = "openai/gpt-6-luna";
const SESSION = "4b1f0c3e-2a6d-4e8f-9b7a-1c2d3e4f5a6b";
const SEARCH_ID = "srvtoolu_01NopXPTJvT3AnKGm66Zzzca";
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 8, blocked_domains: ["example.com"] };
const RESULTS = [
  { type: "web_search_result", title: "dari.dev", url: "https://dari.dev/", encrypted_content: "EsENCioIFRgC", page_age: null },
  { type: "web_search_result", title: "Dari Overview", url: "https://docs.dari.dev/", encrypted_content: "ErkJCioIFRgC", page_age: "3 days ago" },
];

// Recorded shape of a Claude API stream answering Claude Code's web search.
const sse = (model: string) => [
  ["message_start", { type: "message_start", message: { model, id: "msg_1", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 2823, output_tokens: 16 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: SEARCH_ID, name: "web_search", input: {} } }],
  ["ping", { type: "ping" }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"query\": \"dari.dev LLM router\"}" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: SEARCH_ID, content: RESULTS, caller: { type: "direct" } } }],
  ["content_block_stop", { type: "content_block_stop", index: 1 }],
  ["content_block_start", { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Dari is " } }],
  ["content_block_stop", { type: "content_block_stop", index: 2 }],
  ["content_block_start", { type: "content_block_start", index: 3, content_block: { citations: [], type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 3, delta: { type: "citations_delta", citation: { type: "web_search_result_location", cited_text: "dari.dev is the routing layer", url: "https://dari.dev/", title: "dari.dev", encrypted_index: "Eo8BCioIFRgC" } } }],
  ["content_block_delta", { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "an LLM router." } }],
  ["content_block_stop", { type: "content_block_stop", index: 3 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 13111, output_tokens: 1368, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } } }],
  ["message_stop", { type: "message_stop" }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

// An OpenAI Responses stream answering a hosted web search.
const SEARCH_CALL = { id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "dari.dev LLM router" } };
const CITATION = { type: "url_citation", start_index: 0, end_index: 22, url: "https://dari.dev/", title: "dari.dev" };
const ANSWER = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Dari is an LLM router.", annotations: [CITATION] }] };
const responsesSse = (model: string) => {
  const response = { id: "resp_1", object: "response", model, status: "in_progress", output: [] };
  return [
    { type: "response.created", response },
    { type: "response.output_item.added", output_index: 0, item: { ...SEARCH_CALL, status: "in_progress" } },
    { type: "response.web_search_call.completed", output_index: 0, item_id: "ws_1" },
    { type: "response.output_item.done", output_index: 0, item: SEARCH_CALL },
    { type: "response.output_item.added", output_index: 1, item: { ...ANSWER, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 1, item_id: "msg_1", content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 1, item_id: "msg_1", content_index: 0, delta: "Dari is an LLM router." },
    { type: "response.output_text.annotation.added", output_index: 1, item_id: "msg_1", content_index: 0, annotation_index: 0, annotation: CITATION },
    { type: "response.output_text.done", output_index: 1, item_id: "msg_1", content_index: 0, text: "Dari is an LLM router." },
    { type: "response.content_part.done", output_index: 1, item_id: "msg_1", content_index: 0, part: ANSWER.content[0] },
    { type: "response.output_item.done", output_index: 1, item: ANSWER },
    { type: "response.completed", response: { ...response, status: "completed", output: [SEARCH_CALL, ANSWER], usage: { input_tokens: 9000, output_tokens: 40, total_tokens: 9040, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ].map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join("");
};

const upstreamBodies: Array<{ model: string; system?: unknown; tools?: unknown[] }> = [];
const records: Array<Record<string, any>> = [];
let upstream: ReturnType<typeof Bun.serve>;
let handler: (request: Request) => Promise<Response>;
let router: ResolvedRouter;

const selector: SelectorBackend = {
  selectorModel: "test/fixed",
  contextWindowChars: async () => 1_000_000,
  prepareMessages: () => [],
  supportsSpeculativeRouting: false,
  select: async () => {
    throw new Error("A background web search must not invoke the selector.");
  },
};

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json() as (typeof upstreamBodies)[number];
      upstreamBodies.push(body);
      const stream = new URL(request.url).pathname.endsWith("/responses") ? responsesSse(body.model) : sse(body.model);
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  handler = createRequestHandler({
    platform: testPlatform({
      resolveRouter: async () => router,
      resolveProviderCredential: async ({ provider }) => ({
        apiKey: "upstream-key",
        baseUrl: `http://127.0.0.1:${upstream.port}${provider === "openai" ? "/v1" : ""}`,
      }),
      recordRequest: (record) => { records.push(record as unknown as Record<string, any>); },
    }),
    selectorBackend: selector,
  });
});

afterAll(async () => {
  await upstream.stop(true);
});

beforeEach(() => {
  upstreamBodies.length = 0;
  records.length = 0;
  router = resolvedRouter([GPT, OPUS, HAIKU]);
});

test("a background web search runs on the cheapest Claude model and returns its results", async () => {
  // Claude Code names a session model; the search still runs on Haiku, not on
  // Opus and not on the cheaper model that Anthropic's API does not serve.
  const response = await search({ model: `dari/model/${OPUS}`, requestClass: "auxiliary" });
  expect(response.status).toBe(200);
  const events = sseEvents(await response.text());

  expect(upstreamBodies).toHaveLength(1);
  expect(upstreamBodies[0]!.model).toBe("claude-haiku-4-5");
  // The tool reaches Anthropic as the client defined it. Nothing is cached:
  // the results are read once, and Claude Code sends its search uncached too.
  expect(upstreamBodies[0]!.tools).toEqual([WEB_SEARCH_TOOL]);
  expect(JSON.stringify(upstreamBodies[0])).not.toContain("cache_control");

  const blocks = events.filter((event) => event.type === "content_block_start").map((event) => event.content_block);
  expect(blocks.map((block) => block.type)).toEqual(["server_tool_use", "text", "text", "web_search_tool_result"]);
  expect(blocks[0]).toMatchObject({ id: SEARCH_ID, name: "web_search" });
  expect(blocks[3]).toEqual({ type: "web_search_tool_result", tool_use_id: SEARCH_ID, content: RESULTS });
  // Every block has its own index and is closed, as Claude Code assembles them.
  const starts = events.filter((event) => event.type === "content_block_start").map((event) => event.index);
  const stops = events.filter((event) => event.type === "content_block_stop").map((event) => event.index);
  expect(starts).toEqual([0, 1, 2, 3]);
  expect(stops).toEqual([0, 1, 2, 3]);
  expect(events.at(-2)).toMatchObject({ type: "message_delta", delta: { stop_reason: "end_turn" } });
  expect(events.find((event) => event.type === "message_start")!.message.dari_routing.selected_model).toBe(HAIKU);
});

test("a non-streaming web search returns the result block too", async () => {
  const response = await search({ model: "dari/routing", requestClass: "auxiliary", stream: false });
  const body = await response.json() as { content: Array<Record<string, unknown>> };
  expect(response.status).toBe(200);
  expect(body.content.map((block) => block.type)).toEqual(["server_tool_use", "text", "text", "web_search_tool_result"]);
  expect(body.content[3]).toEqual({ type: "web_search_tool_result", tool_use_id: SEARCH_ID, content: RESULTS });
});

test("a web search outside background work keeps the model it names", async () => {
  const response = await search({ model: `dari/model/${OPUS}`, requestClass: "main" });
  expect(response.status).toBe(200);
  await response.text();
  expect(upstreamBodies[0]!.model).toBe("claude-opus-4-8");
  // A conversation that searches keeps prompt caching for its later turns.
  expect(upstreamBodies[0]!.tools).toContainEqual({ ...WEB_SEARCH_TOOL, cache_control: { type: "ephemeral" } });
});

test("a router without a Claude model says web search needs one", async () => {
  router = resolvedRouter([GPT]);
  for (const model of ["dari/routing", `dari/model/${GPT}`]) {
    const response = await search({ model, requestClass: "auxiliary" });
    const body = await response.json() as { error: { message: string } };
    expect(response.status).toBe(400);
    expect(body.error.message).toContain("Web search needs a Claude model served by the Anthropic API, and this router has none enabled.");
  }
  expect(upstreamBodies).toHaveLength(0);
});

// Pi's own turns are chat completions; its search tool asks for dari/routing
// on the endpoint of the provider that searches, marked as a search.
const PI_SEARCH = { "x-pi-session-id": "pi-session-1", "x-pi-request-kind": "search" };

test("Pi's search runs on the cheapest Claude model, with or without the Autorouting plan", async () => {
  for (const autorouting of [true, false]) {
    router = { ...resolvedRouter([GPT, OPUS, HAIKU]), autorouting_enabled: autorouting };
    upstreamBodies.length = 0;
    const response = await piSearch("messages", PI_SEARCH);
    const body = await response.json() as { content: Array<Record<string, unknown>>; dari_routing: { selected_model: string } };
    expect(response.status).toBe(200);
    expect(upstreamBodies.map((sent) => sent.model)).toEqual(["claude-haiku-4-5"]);
    // Like Claude Code's search, it is sent without prompt caching.
    expect(JSON.stringify(upstreamBodies[0])).not.toContain("cache_control");
    expect(body.dari_routing.selected_model).toBe(HAIKU);
    expect(body.content.at(-1)).toEqual({ type: "web_search_tool_result", tool_use_id: SEARCH_ID, content: RESULTS });
  }
});

test("Pi's search runs on the cheapest OpenAI model as a hosted search", async () => {
  for (const autorouting of [true, false]) {
    router = { ...resolvedRouter([GPT, TERRA, LUNA]), autorouting_enabled: autorouting };
    upstreamBodies.length = 0;
    const response = await piSearch("responses", PI_SEARCH);
    const body = await response.json() as { output: Array<Record<string, any>> };
    expect(response.status).toBe(200);
    expect(upstreamBodies.map((sent) => sent.model)).toEqual(["gpt-6-luna"]);
    expect(upstreamBodies[0]!.tools).toEqual([{ type: "web_search" }]);
    expect(body.output.map((item) => item.type)).toEqual(["web_search_call", "message"]);
    expect(body.output[1]!.content[0]).toMatchObject({ text: "Dari is an LLM router.", annotations: [CITATION] });
  }
});

test("a routed search that is not marked as one still needs the Autorouting plan", async () => {
  router = { ...resolvedRouter([GPT, OPUS, HAIKU, TERRA, LUNA]), autorouting_enabled: false };
  for (const endpoint of ["messages", "responses"] as const) {
    const response = await piSearch(endpoint, {});
    expect(response.status).toBe(402);
  }
  expect(upstreamBodies).toHaveLength(0);
});

// The provider's per-search fee is billed on top of tokens: the attempt's
// total is its token costs plus $0.01 a search.
async function searchFee(): Promise<number> {
  for (let tries = 0; records.length === 0 && tries < 100; tries++) await Bun.sleep(5);
  const [attempt] = records.at(-1)!.row.billing_provider_attempts as Array<Record<string, string | null>>;
  const parts = ["provider_input_cost_usd", "provider_cache_read_cost_usd", "provider_cache_write_cost_usd", "provider_output_cost_usd"]
    .reduce((sum, field) => sum + Number(attempt![field]), 0);
  return Math.round((Number(attempt!.provider_cost_usd) - parts) * 1e6) / 1e6;
}

test("each web search the provider ran is billed at its per-search fee", async () => {
  // Claude Code's search, streamed: Anthropic reports one search.
  await (await search({ model: `dari/model/${OPUS}`, requestClass: "auxiliary" })).text();
  expect(await searchFee()).toBe(0.01);
  // Pi's search on OpenAI: one completed web_search_call.
  records.length = 0;
  router = resolvedRouter([GPT, TERRA, LUNA]);
  await (await piSearch("responses", PI_SEARCH)).json();
  expect(await searchFee()).toBe(0.01);
  // A request without a search tool pays no fee.
  records.length = 0;
  router = resolvedRouter([GPT, OPUS, HAIKU]);
  await (await handler(new Request("http://gateway.test/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "gw-key", "content-type": "application/json" },
    body: JSON.stringify({ model: `dari/model/${HAIKU}`, max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
  }))).json();
  expect(await searchFee()).toBe(0);
});

async function piSearch(endpoint: "messages" | "responses", headers: Record<string, string>): Promise<Response> {
  const prompt = "Perform a web search for the query: dari.dev LLM router";
  return handler(new Request(`http://gateway.test/v1/${endpoint}`, {
    method: "POST",
    headers: { "x-api-key": "gw-key", authorization: "Bearer gw-key", "content-type": "application/json", ...headers },
    body: JSON.stringify(endpoint === "messages"
      ? { model: "dari/routing", max_tokens: 4096, messages: [{ role: "user", content: prompt }], tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }] }
      : { model: "dari/routing", input: prompt, tools: [{ type: "web_search" }] }),
  }));
}

async function search(args: { model: string; requestClass: string; stream?: boolean }): Promise<Response> {
  return handler(new Request("http://gateway.test/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": "gw-key",
      "content-type": "application/json",
      "user-agent": "claude-cli/2.1.326 (external, cli)",
      "x-app": "cli",
      "x-claude-code-session-id": SESSION,
      "x-claude-code-request-class": args.requestClass,
    },
    // The request Claude Code sends for a WebSearch tool call.
    body: JSON.stringify({
      model: args.model,
      max_tokens: 128000,
      stream: args.stream ?? true,
      system: [{ type: "text", text: "You run a web search for another Claude model. Search once, then reply with a brief summary of the results." }],
      messages: [{ role: "user", content: [{ type: "text", text: "Perform a web search for the query: dari.dev LLM router" }] }],
      tools: [WEB_SEARCH_TOOL],
      tool_choice: { type: "auto" },
      output_config: { effort: "xhigh" },
    }),
  }));
}

function sseEvents(text: string): Array<Record<string, any>> {
  return text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice("data:".length)));
}

function resolvedRouter(models: string[]): ResolvedRouter {
  const claude = (nativeId: string, price: number) => ({
    provider: "anthropic",
    native_model_id: nativeId,
    api: "anthropic-messages",
    supported_thinking_levels: ["off" as const, "high" as const],
    default_thinking_level: "off" as const,
    cost: { input: price, output: price * 5, cached_input: price / 10, cache_write: price },
  });
  const configs: NonNullable<ResolvedRouter["model_configs"]> = {
    [HAIKU]: claude("claude-haiku-4-5", 1),
    [OPUS]: claude("claude-opus-4-8", 5),
    [GPT]: {
      provider: "openrouter",
      native_model_id: "acme/model-a",
      api: "openai-completions",
      supported_thinking_levels: ["off" as const],
      default_thinking_level: "off" as const,
      cost: { input: 0.1, output: 0.1, cached_input: 0.01, cache_write: 0.1 },
    },
  };
  const openai = (nativeId: string, price: number) => ({
    provider: "openai",
    native_model_id: nativeId,
    api: "openai-responses",
    supported_thinking_levels: ["low" as const, "high" as const],
    default_thinking_level: "low" as const,
    cost: { input: price, output: price * 5, cached_input: price / 10, cache_write: price },
  });
  configs[TERRA] = openai("gpt-6.1-terra", 2);
  configs[LUNA] = openai("gpt-6-luna", 0.5);
  const prices: NonNullable<ResolvedRouter["model_prices"]> = {
    [HAIKU]: { input: 1, output: 5 }, [OPUS]: { input: 5, output: 25 }, [GPT]: { input: 0.1, output: 0.1 },
    [TERRA]: { input: 2, output: 10 }, [LUNA]: { input: 0.5, output: 2.5 },
  };
  return {
    router_id: "rtr_search",
    organization_id: "org_search",
    api_key_id: null,
    attributed_user_id: null,
    enabled_models: models,
    provider_keys: { anthropic: "resolved-key", openrouter: "resolved-key", openai: "resolved-key" },
    primary_retries: 0,
    lease_context_enabled: false,
    routing_strategy: "dari",
    model_thinking_levels: Object.fromEntries(models.map((model) => [model, configs[model]!.supported_thinking_levels!])),
    model_prices: Object.fromEntries(models.map((model) => [model, prices[model]!])),
    model_configs: Object.fromEntries(models.map((model) => [model, configs[model]!])),
  };
}
