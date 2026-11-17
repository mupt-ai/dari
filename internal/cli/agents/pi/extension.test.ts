import { afterEach, expect, test } from "bun:test";
import extension from "./extension";

for (const outcome of ["session_compact", "session_compact_failed"]) {
  test(`Pi tags compaction until ${outcome}, then returns to main turns`, async () => {
    const handlers = new Map<string, Function>();
    extension({
      registerProvider() {},
      on(name: string, handler: Function) { handlers.set(name, handler); },
    });
    let sessionId = "session-one";
    const ctx = {
      model: { provider: "dari" },
      sessionManager: { getSessionId: () => sessionId },
    };
    const emit = async (name: string, event = {}) => handlers.get(name)?.(event, ctx);
    const headers = async () => {
      const event = { headers: { "x-session-affinity": "provider-cache-key" } };
      await emit("before_provider_headers", event);
      return event.headers;
    };
    expect(await headers()).toMatchObject({
      "x-pi-session-id": "session-one",
      "x-pi-request-kind": "turn",
      "x-session-affinity": "provider-cache-key",
    });
    await emit("session_before_compact");
    // Split-turn summaries and retries must all remain compaction requests.
    for (let i = 0; i < 2; i++) {
      expect(await headers()).toMatchObject({ "x-pi-request-kind": "compaction" });
    }
    await emit(outcome);
    expect(await headers()).toMatchObject({ "x-pi-request-kind": "turn" });
    sessionId = "session-two";
    expect(await headers()).toMatchObject({ "x-pi-session-id": "session-two" });
    ctx.model.provider = "other";
    expect(await headers()).toEqual({ "x-session-affinity": "provider-cache-key" });
  });
}

// The web search tool, driven with a stubbed fetch standing in for the router.
afterEach(() => { delete process.env.DARI_ROUTING_API_KEY; });

function searchTool(models: string[], others: Array<{ name: string }> = []) {
  process.env.DARI_MODELS = JSON.stringify(models);
  process.env.DARI_ROUTING_BASE_URL = "https://router.test/rtr_1";
  process.env.DARI_ROUTING_API_KEY = "dak_test";
  let tool: any;
  try {
    // The tool is offered once the session starts, after every extension has loaded.
    const starts: Function[] = [];
    extension({
      registerProvider() {},
      on(name: string, handler: Function) { if (name === "session_start") starts.push(handler); },
      getAllTools: () => others,
      registerTool(definition: any) { tool = definition; },
    });
    for (const start of starts) start();
  } finally {
    delete process.env.DARI_MODELS;
    delete process.env.DARI_ROUTING_BASE_URL;
  }
  return tool;
}

const OPENAI_ANSWER = {
  output: [
    { type: "web_search_call", status: "completed" },
    { type: "message", content: [{ type: "output_text", text: "Dari is an LLM router.", annotations: [
      { type: "url_citation", title: "dari.dev", url: "https://dari.dev/" },
      { type: "url_citation", title: "dari.dev", url: "https://dari.dev/" },
    ] }] },
  ],
};
const CLAUDE_ANSWER = {
  content: [
    { type: "server_tool_use", name: "web_search" },
    { type: "text", text: "Dari routes requests " },
    { type: "text", text: "across models." },
    { type: "web_search_tool_result", content: [{ type: "web_search_result", title: "Dari docs", url: "https://docs.dari.dev/" }] },
  ],
};

async function runSearch(models: string[], answers: Record<string, { status: number; body: unknown }>) {
  const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const answer = answers[new URL(url).pathname.split("/").at(-1)!]!;
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as any;
  try {
    const ctx = { sessionManager: { getSessionId: () => "session-one" } };
    const result = await searchTool(models).execute("call_1", { query: "dari.dev LLM router" }, undefined, undefined, ctx)
      .then((value: any) => value.content[0].text, (error: Error) => error);
    return { requests, result };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const BOTH = ["dari/routing", "dari/model/deepseek/deepseek-flash", "dari/model/anthropic/claude-haiku-5-5", "dari/model/openai/gpt-6-luna"];
const LIMIT = { status: 429, body: { error: { message: "Your ChatGPT subscription usage limit is reached." } } };

test("Pi searches with OpenAI first, as a search request for dari/routing", async () => {
  const { requests, result } = await runSearch(BOTH, { responses: { status: 200, body: OPENAI_ANSWER } });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe("https://router.test/rtr_1/v1/responses");
  expect(requests[0]!.headers).toMatchObject({
    authorization: "Bearer dak_test",
    "x-pi-session-id": "session-one",
    "x-pi-request-kind": "search",
  });
  expect(requests[0]!.body).toMatchObject({ model: "dari/routing", tools: [{ type: "web_search" }] });
  expect(result).toBe('Web search results for "dari.dev LLM router":\n\nDari is an LLM router.\n\nLinks:\n- dari.dev: https://dari.dev/');
});

test("Pi searches with Claude when the router has no OpenAI model", async () => {
  const { requests, result } = await runSearch(BOTH.filter((id) => !id.includes("openai")), { messages: { status: 200, body: CLAUDE_ANSWER } });
  expect(requests.map((request) => request.url)).toEqual(["https://router.test/rtr_1/v1/messages"]);
  expect(requests[0]!.headers).toMatchObject({ "x-api-key": "dak_test", "x-pi-request-kind": "search" });
  expect(requests[0]!.body).toMatchObject({ model: "dari/routing", tools: [{ type: "web_search_20250305", name: "web_search" }] });
  expect(result).toBe('Web search results for "dari.dev LLM router":\n\nDari routes requests across models.\n\nLinks:\n- Dari docs: https://docs.dari.dev/');
});

test("Pi's search moves to the next provider when one cannot serve it", async () => {
  const { requests, result } = await runSearch(BOTH, { responses: LIMIT, messages: { status: 200, body: CLAUDE_ANSWER } });
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/rtr_1/v1/responses", "/rtr_1/v1/messages"]);
  expect(result).toContain("Dari routes requests across models.");
});

test("Pi's search reports every provider's reason when none can serve it", async () => {
  const { result } = await runSearch(BOTH, { responses: LIMIT, messages: { status: 502, body: { type: "error", error: { message: "Anthropic is unavailable." } } } });
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toBe("Web search failed. Your ChatGPT subscription usage limit is reached. Anthropic is unavailable.");
});

test("Pi gets no search tool when no model on the router can search", () => {
  expect(searchTool(["dari/routing", "dari/model/deepseek/deepseek-flash"])).toBeUndefined();
});

// Pi refuses to start on two tools of one name.
test("Pi keeps a web_search tool the user already has", () => {
  expect(searchTool(BOTH, [{ name: "read" }, { name: "web_search" }])).toBeUndefined();
  expect(searchTool(BOTH, [{ name: "read" }])?.name).toBe("web_search");
});
