import { expect, test } from "bun:test";

import {
  createGatewayExecutor,
  createRouter,
  RouterFrameworkError,
  type CreateGatewayExecutorOptions,
} from "../src/index.js";
import {
  encodeProviderContinuationState,
  type ProviderContinuationState,
} from "../src/continuation_state.js";
import {
  gatewayCompletion,
  gatewayMessagesBody,
  gatewayStreamEvents,
} from "../src/gateway_executor.js";
import { anthropicRequest } from "../src/protocol_anthropic.js";
import { openAIChatRequest } from "../src/protocol_openai_chat.js";
import type { RouterRequest, RouterStreamEvent } from "../src/framework_types.js";

const SOURCE = { provider: "anthropic", api: "anthropic-messages", model: "claude-fable-5-1" };
const THINKING: ProviderContinuationState = {
  kind: "anthropic_thinking",
  source: SOURCE,
  thinking: "Look at it.",
  signature: "sig-1",
};
const REDACTED: ProviderContinuationState = {
  kind: "anthropic_redacted_thinking",
  source: SOURCE,
  data: "opaque",
};
const THINKING_ENVELOPE = encodeProviderContinuationState(THINKING);
const REDACTED_ENVELOPE = encodeProviderContinuationState(REDACTED);

function chatRequest(overrides: Record<string, unknown> = {}): RouterRequest {
  return openAIChatRequest({
    model: "dari/routing",
    messages: [
      { role: "system", content: "Be brief." },
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
      {
        role: "assistant",
        content: null,
        reasoning_content: "Look at it.",
        reasoning_details: [{ type: "reasoning.encrypted", id: "rs_1", data: THINKING_ENVELOPE }],
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"cat\"}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "A cat." },
    ],
    tools: [{
      type: "function",
      function: {
        name: "lookup",
        description: "Look something up.",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    }],
    tool_choice: "required",
    parallel_tool_calls: false,
    temperature: 0.5,
    top_p: 0.9,
    stop: "END",
    max_tokens: 256,
    prompt_cache_key: "conv-1",
    user: "u-1",
    ...overrides,
  });
}

function sse(frames: Array<[string, Record<string, unknown>]>): string {
  return frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`).join("");
}

function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

async function collect(events: AsyncIterable<RouterStreamEvent>): Promise<RouterStreamEvent[]> {
  const out: RouterStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const STREAM = sse([
  ["message_start", { message: { id: "msg_1", usage: { input_tokens: 0, output_tokens: 0 } } }],
  ["content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
  ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Hm" } }],
  ["content_block_delta", { index: 0, delta: { type: "signature_delta", signature: THINKING_ENVELOPE } }],
  ["content_block_stop", { index: 0 }],
  ["content_block_start", { index: 1, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { index: 1, delta: { type: "text_delta", text: "Hi" } }],
  ["content_block_stop", { index: 1 }],
  ["content_block_start", { index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} } }],
  ["content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: "{\"q\":" } }],
  ["content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: "\"x\"}" } }],
  ["content_block_stop", { index: 2 }],
  ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } }],
  ["message_stop", {}],
]);

test("serializes a chat request into a body the Anthropic parser reads back losslessly", () => {
  const request = chatRequest();
  const body = gatewayMessagesBody(request, { modelId: "anthropic/claude-fable-5-1", reasoningEffort: "high" });

  expect(body.model).toBe("dari/model/anthropic/claude-fable-5-1");
  expect(body.thinking).toEqual({ type: "adaptive" });
  expect(body.output_config).toEqual({ effort: "high" });
  expect(body.stop_sequences).toEqual(["END"]);
  expect(JSON.parse((body.metadata as { user_id: string }).user_id)).toEqual({ session_id: "conv-1", user_id: "u-1" });

  // The router's strict Anthropic parser rejects unknown fields, so a clean
  // parse proves the body is a valid Messages request.
  const parsed = anthropicRequest(body);
  expect(parsed.items).toEqual([
    { type: "message", role: "system", content: [{ type: "text", text: "Be brief." }] },
    {
      type: "message",
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        { type: "image", url: "data:image/png;base64,AAAA" },
      ],
    },
    { type: "reasoning", summary: ["Look at it."], content: [], source: SOURCE, continuation: THINKING },
    { type: "tool_call", id: "call_1", name: "lookup", arguments: { q: "cat" } },
    { type: "tool_result", toolCallId: "call_1", content: [{ type: "text", text: "A cat." }] },
  ]);
  expect(parsed.tools).toEqual(request.tools);
  expect(parsed.toolChoice).toBe("required");
  expect(parsed.parallelToolCalls).toBe(false);
  expect(parsed.generation).toEqual({ maxOutputTokens: 256, temperature: 0.5, topP: 0.9, stop: ["END"] });
  expect(parsed.reasoning).toEqual({ effort: "high", enabled: true });
});

test("sends off effort as disabled thinking and redacted thinking as redacted blocks", () => {
  const request: RouterRequest = {
    ...chatRequest(),
    items: [
      { type: "message", role: "user", content: [{ type: "text", text: "hi" }] },
      { type: "reasoning", content: [], source: SOURCE, continuation: REDACTED },
      { type: "message", role: "assistant", content: [{ type: "text", text: "Hello." }] },
      { type: "message", role: "user", content: [{ type: "text", text: "again" }] },
    ],
  };
  const body = gatewayMessagesBody(request, { modelId: "m", reasoningEffort: "off" });
  expect(body.thinking).toEqual({ type: "disabled" });
  expect(body.output_config).toBeUndefined();
  expect(body.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "redacted_thinking", data: REDACTED_ENVELOPE },
        { type: "text", text: "Hello." },
      ],
    },
    { role: "user", content: [{ type: "text", text: "again" }] },
  ]);
  expect(anthropicRequest(body).items[1]).toEqual({
    type: "reasoning",
    summary: [],
    content: [],
    source: SOURCE,
    continuation: REDACTED,
  });
});

test("rejects requests the gateway's Messages wire cannot express", () => {
  const cases: Array<[string, () => unknown]> = [
    ["minimal effort", () => gatewayMessagesBody(chatRequest(), { modelId: "m", reasoningEffort: "minimal" })],
    ["json_object", () => gatewayMessagesBody(
      chatRequest({ response_format: { type: "json_object" } }),
      { modelId: "m", reasoningEffort: "high" },
    )],
    ["temperature above 1", () => gatewayMessagesBody(chatRequest({ temperature: 1.5 }), { modelId: "m", reasoningEffort: "high" })],
    ["no output limit", () => gatewayMessagesBody(chatRequest({ max_tokens: undefined }), { modelId: "m", reasoningEffort: "high" })],
    ["late system message", () => gatewayMessagesBody(
      openAIChatRequest({
        model: "dari/routing",
        messages: [{ role: "user", content: "hi" }, { role: "system", content: "late" }],
      }),
      { modelId: "m", reasoningEffort: "high", defaultMaxOutputTokens: 100 },
    )],
  ];
  for (const [name, run] of cases) {
    let error: unknown;
    try {
      run();
    } catch (caught) {
      error = caught;
    }
    expect(error, name).toBeInstanceOf(RouterFrameworkError);
    expect((error as RouterFrameworkError).code, name).toBe("gateway_unrepresentable_request");
    expect((error as RouterFrameworkError).status, name).toBe(400);
  }
});

test("keeps a client's explicit thinking budget", () => {
  const request = anthropicRequest({
    model: "dari/routing",
    max_tokens: 8192,
    thinking: { type: "enabled", budget_tokens: 2048 },
    messages: [{ role: "user", content: "think" }],
  });
  const body = gatewayMessagesBody(request, { modelId: "m", reasoningEffort: "high" });
  expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  expect(body.output_config).toEqual({ effort: "high" });
  expect(anthropicRequest(body).reasoning).toEqual({ effort: "high", enabled: true, budgetTokens: 2048 });
});

test("uses defaultMaxOutputTokens only when the request sets no limit", () => {
  const unset = gatewayMessagesBody(chatRequest({ max_tokens: undefined }), {
    modelId: "m",
    reasoningEffort: "high",
    defaultMaxOutputTokens: 4096,
  });
  expect(unset.max_tokens).toBe(4096);
  const set = gatewayMessagesBody(chatRequest(), { modelId: "m", reasoningEffort: "high", defaultMaxOutputTokens: 4096 });
  expect(set.max_tokens).toBe(256);
});

test("maps a gateway message to a completion with continuations and cache usage", () => {
  expect(gatewayCompletion({
    id: "msg_1",
    type: "message",
    content: [
      { type: "thinking", thinking: "Hm", signature: THINKING_ENVELOPE },
      { type: "redacted_thinking", data: REDACTED_ENVELOPE },
      { type: "text", text: "Hi" },
      { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  })).toEqual({
    id: "msg_1",
    content: [
      { type: "reasoning", text: "Hm", source: SOURCE, continuation: THINKING },
      { type: "reasoning", text: "", redacted: true, source: SOURCE, continuation: REDACTED },
      { type: "text", text: "Hi" },
      { type: "tool_call", id: "toolu_1", name: "lookup", arguments: { q: "x" } },
    ],
    finishReason: "tool_calls",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 },
  });
});

test("maps a gateway stream to router events, across arbitrary chunk boundaries", async () => {
  const events = await collect(gatewayStreamEvents(chunked(STREAM, 7)));
  expect(events).toEqual([
    { type: "reasoning_delta", index: 0, delta: "Hm" },
    { type: "reasoning_end", index: 0, source: SOURCE, continuation: THINKING },
    { type: "text_delta", index: 1, delta: "Hi" },
    { type: "tool_call_start", index: 2, id: "toolu_1", name: "lookup" },
    { type: "tool_call_delta", index: 2, delta: "{\"q\":" },
    { type: "tool_call_delta", index: 2, delta: "\"x\"}" },
    { type: "tool_call_end", index: 2 },
    { type: "finish", finishReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } },
  ]);
});

test("surfaces gateway stream errors and truncated streams", async () => {
  const errored = sse([
    ["message_start", { message: { usage: { input_tokens: 0, output_tokens: 0 } } }],
    ["error", { error: { type: "api_error", message: "provider exploded" } }],
  ]);
  await expect(collect(gatewayStreamEvents(chunked(errored, 64)))).rejects.toMatchObject({
    kind: "executor",
    message: "provider exploded",
  });
  const truncated = sse([["message_start", { message: { usage: { input_tokens: 0, output_tokens: 0 } } }]]);
  await expect(collect(gatewayStreamEvents(chunked(truncated, 64)))).rejects.toMatchObject({
    code: "gateway_output_invalid",
  });
});

test("pins the selected model on the gateway and closes thinking before text for Anthropic clients", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const executor = createGatewayExecutor({
    baseUrl: "http://gateway.local/",
    apiKey: "gw-key",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(chunked(STREAM, 5), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const router = createRouter({
    models: [{ id: "anthropic/claude-fable-5-1", executor: "gateway", reasoningEfforts: ["high"], capabilities: { streaming: true, toolUse: true } }],
    executors: { gateway: executor },
    policy: ({ candidates }) => ({ model: candidates[0]!.id, reasoningEffort: "high" }),
  });

  const response = await router.fetch(new Request("http://router.local/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "dari/routing",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "lookup", input_schema: { type: "object" } }],
    }),
  }));
  expect(response.status).toBe(200);
  const text = await response.text();

  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("http://gateway.local/v1/messages");
  expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer gw-key");
  const sent = JSON.parse(String(calls[0]!.init.body));
  expect(sent.model).toBe("dari/model/anthropic/claude-fable-5-1");
  expect(sent.stream).toBe(true);
  expect(sent.output_config).toEqual({ effort: "high" });

  const signature = text.indexOf(`"signature":"${THINKING_ENVELOPE}"`);
  const firstText = text.indexOf("\"text_delta\"");
  expect(signature).toBeGreaterThan(-1);
  expect(firstText).toBeGreaterThan(signature);
  expect(text).toContain("\"stop_reason\":\"tool_use\"");
});

test("serves non-streaming chat clients through the gateway", async () => {
  const executor = createGatewayExecutor({
    baseUrl: "http://gateway.local",
    apiKey: "gw-key",
    defaultMaxOutputTokens: 1024,
    fetch: async () => Response.json({
      id: "msg_2",
      type: "message",
      content: [{ type: "text", text: "Served." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 4, output_tokens: 2 },
    }),
  });
  const router = createRouter({
    models: [{ id: "openai/gpt-6-luna", executor: "gateway", reasoningEfforts: ["low"] }],
    executors: { gateway: executor },
    policy: ({ candidates }) => ({ model: candidates[0]!.id }),
  });
  const response = await router.fetch(new Request("http://router.local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "dari/routing", messages: [{ role: "user", content: "hi" }] }),
  }));
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, any>;
  expect(body.choices[0].message.content).toBe("Served.");
  expect(body.usage).toMatchObject({ prompt_tokens: 4, completion_tokens: 2 });
  expect(body.dari_routing.selected_model).toBe("openai/gpt-6-luna");
});

test("classifies gateway HTTP and network failures", async () => {
  const run = async (fetchImpl: NonNullable<CreateGatewayExecutorOptions["fetch"]>) => {
    const executor = createGatewayExecutor({ baseUrl: "http://gateway.local", apiKey: "k", fetch: fetchImpl });
    return executor.execute({
      request: chatRequest(),
      model: { id: "m", provider: "p", providerModelId: "m", reasoningEfforts: ["high"], capabilities: {} } as never,
      decision: { selectedModel: "m", reasoningEffort: "high", reason: "" },
      signal: new AbortController().signal,
    });
  };
  const status = (code: number) => async () =>
    Response.json({ type: "error", error: { type: "x", message: `status ${code}` } }, { status: code });

  await expect(run(status(400))).rejects.toMatchObject({ kind: "invalid_request", code: "gateway_rejected_request" });
  await expect(run(status(401))).rejects.toMatchObject({ kind: "configuration", code: "gateway_unauthorized" });
  await expect(run(status(429))).rejects.toMatchObject({ kind: "executor", code: "gateway_http_error" });
  await expect(run(status(500))).rejects.toMatchObject({ kind: "executor", message: "Gateway returned HTTP 500: status 500" });
  await expect(run(async () => { throw new Error("connection refused"); })).rejects.toMatchObject({
    kind: "executor",
    code: "gateway_request_failed",
  });
});

test("requires a base URL and API key", () => {
  expect(() => createGatewayExecutor({ baseUrl: " ", apiKey: "k" })).toThrow("baseUrl");
  expect(() => createGatewayExecutor({ baseUrl: "http://g", apiKey: "" })).toThrow("apiKey");
  expect(() => createGatewayExecutor({ baseUrl: "http://g", apiKey: "k", defaultMaxOutputTokens: 0 })).toThrow("positive integer");
});

test("replays zero-argument tool calls as an empty input object", () => {
  const request = openAIChatRequest({
    model: "dari/routing",
    max_tokens: 64,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "now", arguments: "" } }] },
      { role: "tool", tool_call_id: "call_0", content: "noon" },
    ],
    tools: [{ type: "function", function: { name: "now", parameters: { type: "object" } } }],
  });
  const body = gatewayMessagesBody(request, { modelId: "m", reasoningEffort: "high" });
  expect((body.messages as any[])[1].content).toEqual([{ type: "tool_use", id: "call_0", name: "now", input: {} }]);
});
