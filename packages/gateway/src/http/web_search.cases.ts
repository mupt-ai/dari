import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import type { SelectorBackend } from "../strategies/routing.js";
import { testPlatform } from "../test_support/platform.js";
import type { ResolvedRouter } from "../types.js";
import { createRequestHandler } from "./handler.js";

// Claude Code's web search end to end through the real handler: a background
// request with Anthropic's `web_search` tool, answered by a Claude API upstream.
const HAIKU = "anthropic/claude-haiku-4-5";
const OPUS = "anthropic/claude-opus-4-8";
const GPT = "openrouter/acme/model-a";
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

const upstreamBodies: Array<{ model: string; tools?: unknown[] }> = [];
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
      return new Response(sse(body.model), { headers: { "content-type": "text/event-stream" } });
    },
  });
  handler = createRequestHandler({
    platform: testPlatform({
      resolveRouter: async () => router,
      resolveProviderCredential: async () => ({ apiKey: "upstream-key", baseUrl: `http://127.0.0.1:${upstream.port}` }),
      recordRequest: () => {},
    }),
    selectorBackend: selector,
  });
});

afterAll(async () => {
  await upstream.stop(true);
});

beforeEach(() => {
  upstreamBodies.length = 0;
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
  // The tool reaches Anthropic as the client defined it, plus Pi's cache marker.
  expect(upstreamBodies[0]!.tools).toEqual([{ ...WEB_SEARCH_TOOL, cache_control: { type: "ephemeral" } }]);

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
  const prices: NonNullable<ResolvedRouter["model_prices"]> = { [HAIKU]: { input: 1, output: 5 }, [OPUS]: { input: 5, output: 25 }, [GPT]: { input: 0.1, output: 0.1 } };
  return {
    router_id: "rtr_search",
    organization_id: "org_search",
    api_key_id: null,
    attributed_user_id: null,
    enabled_models: models,
    provider_keys: { anthropic: "resolved-key", openrouter: "resolved-key" },
    primary_retries: 0,
    lease_context_enabled: false,
    routing_strategy: "dari",
    model_thinking_levels: Object.fromEntries(models.map((model) => [model, configs[model]!.supported_thinking_levels!])),
    model_prices: Object.fromEntries(models.map((model) => [model, prices[model]!])),
    model_configs: Object.fromEntries(models.map((model) => [model, configs[model]!])),
  };
}
