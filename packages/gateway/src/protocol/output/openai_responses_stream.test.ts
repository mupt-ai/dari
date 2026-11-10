import { expect, test } from "bun:test";

import { decodeUntrustedProviderContinuationState } from "../../interaction/provider_continuation_state.js";
import { openAIResponsesSseStream } from "./openai_responses_stream.js";
import type { InteractionRequest, ProviderIdentity } from "../../interaction/types.js";

const OPENAI: ProviderIdentity = { provider: "openai", api: "openai-responses", model: "gpt-5.5" };
const OPENAI_CODEX: ProviderIdentity = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  model: "gpt-5.6-sol",
};
const REQUEST: InteractionRequest = {
  sourceProtocol: "openai_responses",
  model: "dari/routing",
  items: [],
  tools: [],
  parallelToolCalls: false,
  generation: {},
  stream: true,
};

test("reconciles streamed tools with text present only in the terminal message", async () => {
  const events = await streamEvents([
    {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { id: "call_read", name: "read_file", arguments: { path: "README.md" } },
    },
    {
      type: "done",
      message: piMessage([
        { type: "toolCall", id: "call_read", name: "read_file", arguments: { path: "README.md" } },
        { type: "text", text: "Reading the file." },
      ], "toolUse"),
    },
  ]);

  expect(outputDone(events)).toMatchObject([
    { output_index: 0, item: { type: "function_call", call_id: "call_read" } },
    { output_index: 1, item: { type: "message", content: [{ text: "Reading the file." }] } },
  ]);
  expect(completed(events).output).toHaveLength(2);
});

test("reconciles terminal reasoning that precedes an indexed streamed tool", async () => {
  const reasoning = {
    type: "thinking",
    thinking: "Inspect first.",
    thinkingSignature: JSON.stringify({
      type: "reasoning",
      id: "rs_provider",
      summary: [{ type: "summary_text", text: "Inspect first." }],
      content: [],
      encrypted_content: "provider-ciphertext",
    }),
  };
  const tool = { type: "toolCall", id: "call_read", name: "read_file", arguments: { path: "README.md" } };
  const terminal = piMessage([reasoning, tool], "toolUse");
  const events = await streamEvents([
    { type: "toolcall_end", contentIndex: 1, toolCall: tool, partial: terminal },
    { type: "done", message: terminal },
  ]);

  expect(events.filter((event) => event.event === "response.failed")).toHaveLength(0);
  expect(completed(events).output).toMatchObject([
    { type: "reasoning", id: "rs_provider" },
    { type: "function_call", call_id: "call_read" },
  ]);
});

test("fails malformed provider item events without contentIndex", async () => {
  const events = await streamEvents([
    {
      type: "toolcall_end",
      toolCall: { id: "call_read", name: "read_file", arguments: { path: "README.md" } },
    },
  ]);

  expect(events.filter((event) => event.event === "response.failed")).toHaveLength(1);
});

test("streams reasoning once and preserves its terminal continuation state", async () => {
  const reasoning = {
    type: "reasoning",
    id: "rs_provider",
    summary: [{ type: "summary_text", text: "Inspect first." }],
    content: [],
    encrypted_content: "provider-ciphertext",
  };
  const events = await streamEvents([
    { type: "thinking_start", contentIndex: 0 },
    { type: "thinking_delta", contentIndex: 0, delta: "Inspect " },
    { type: "thinking_delta", contentIndex: 0, delta: "first." },
    {
      type: "thinking_end",
      contentIndex: 0,
    },
    {
      type: "done",
      message: piMessage([
        { type: "thinking", thinking: "Inspect first.", thinkingSignature: JSON.stringify(reasoning) },
      ]),
    },
  ]);

  const reasoningDone = outputDone(events).filter((event) => item(event).type === "reasoning");
  expect(reasoningDone).toHaveLength(1);
  expect(item(reasoningDone[0]).id).toBe("rs_resp_request_123_0");
  expect(item(reasoningDone[0]).summary).toEqual([{ type: "summary_text", text: "Inspect first." }]);
  expect(decodeUntrustedProviderContinuationState(String(item(reasoningDone[0]).encrypted_content))).toEqual({
    kind: "openai_reasoning",
    source: OPENAI,
    encryptedContent: "provider-ciphertext",
    providerItemId: "rs_provider",
  });
  expect(events.filter((event) => event.event === "response.reasoning_summary_text.delta")).toHaveLength(2);
  expect(events.filter((event) => event.event === "response.reasoning_summary_text.done")).toHaveLength(1);
  expect(events.map((event) => event.data.sequence_number)).toEqual(events.map((_, index) => index));
});

test("emits terminal-only text and exactly one completion", async () => {
  const events = await streamEvents([
    { type: "done", message: piMessage([{ type: "text", text: "Terminal only." }]) },
    { type: "done", message: piMessage([{ type: "text", text: "Ignored duplicate." }]) },
  ]);

  expect(outputDone(events)).toMatchObject([
    { output_index: 0, item: { type: "message", content: [{ text: "Terminal only." }] } },
  ]);
  expect(events.filter((event) => event.event === "response.completed")).toHaveLength(1);
  const created = responseFor(events, "response.created");
  const terminal = responseFor(events, "response.completed");
  expect(terminal.id).toBe(created.id);
  expect(terminal.parallel_tool_calls).toBe(false);
});

test("emits the complete output-text content lifecycle", async () => {
  const events = await streamEvents([
    { type: "text_start", contentIndex: 0 },
    { type: "text_delta", contentIndex: 0, delta: "Hello" },
    { type: "text_delta", contentIndex: 0, delta: " there." },
    { type: "text_end", contentIndex: 0 },
    { type: "done", message: piMessage([{ type: "text", text: "Hello there." }]) },
  ]);

  expect(events.map((event) => event.event)).toEqual([
    "response.created",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ]);
  expect(eventData(events, "response.content_part.added")).toMatchObject({
    item_id: "msg_resp_request_123_0",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
  expect(eventData(events, "response.output_text.done")).toMatchObject({
    item_id: "msg_resp_request_123_0",
    output_index: 0,
    content_index: 0,
    text: "Hello there.",
  });
  expect(eventData(events, "response.content_part.done")).toMatchObject({
    item_id: "msg_resp_request_123_0",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "Hello there.", annotations: [] },
  });
});

test("announces a message with the phase it ends with", async () => {
  const signature = JSON.stringify({ v: 1, id: "msg_provider", phase: "commentary" });
  const block = { type: "text", text: "Looking.", textSignature: signature };
  const events = await streamEvents([
    { type: "text_start", contentIndex: 0, partial: { content: [{ type: "text", text: "", textSignature: signature }] } },
    { type: "text_delta", contentIndex: 0, delta: "Looking." },
    { type: "text_end", contentIndex: 0, partial: piMessage([block]) },
    { type: "done", message: piMessage([block]) },
  ]);

  expect(eventData(events, "response.output_item.added")).toMatchObject({
    item: { type: "message", id: "msg_provider", phase: "commentary" },
  });
  expect(outputDone(events)).toMatchObject([
    { item: { type: "message", id: "msg_provider", phase: "commentary" } },
  ]);
});

test("streams hosted search lifecycle and citations at native output indexes", async () => {
  const reasoning = {
    type: "reasoning",
    id: "rs_provider",
    status: "completed",
    summary: [{ type: "summary_text", text: "Search first." }],
    encrypted_content: "opaque-reasoning",
  };
  const search = {
    type: "web_search_call",
    id: "ws_provider",
    status: "completed",
    action: {
      type: "search",
      queries: ["OpenAI Responses search docs"],
      sources: [{ type: "url", url: "https://developers.openai.com/api/docs/guides/tools-web-search" }],
    },
  };
  const citation = {
    type: "url_citation",
    start_index: 18,
    end_index: 21,
    url: "https://developers.openai.com/api/docs/guides/tools-web-search",
    title: "Web search",
  };
  const message = {
    type: "message",
    id: "msg_provider",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "See the web docs.[1]", annotations: [citation] }],
  };
  const providerResponse = {
    id: "resp_provider",
    created_at: 1_750_000_000,
    status: "completed",
    output: [reasoning, search, message],
  };
  const events = await streamEvents([
    { type: "provider_event", event: { type: "response.output_item.added", output_index: 0, item: reasoning } },
    { type: "thinking_start", contentIndex: 0 },
    { type: "thinking_delta", contentIndex: 0, delta: "Search first." },
    { type: "provider_event", event: { type: "response.output_item.done", output_index: 0, item: reasoning } },
    { type: "thinking_end", contentIndex: 0 },
    {
      type: "provider_event",
      event: {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "web_search_call", id: "ws_provider", status: "in_progress" },
      },
    },
    {
      type: "provider_event",
      event: { type: "response.web_search_call.searching", output_index: 1, item_id: "ws_provider" },
    },
    { type: "provider_event", event: { type: "response.output_item.done", output_index: 1, item: search } },
    { type: "provider_event", event: { type: "response.output_item.added", output_index: 2, item: message } },
    { type: "text_start", contentIndex: 1 },
    { type: "text_delta", contentIndex: 1, delta: "See the web docs.[1]" },
    {
      type: "provider_event",
      event: {
        type: "response.output_text.annotation.added",
        output_index: 2,
        content_index: 0,
        item_id: "msg_provider",
        annotation: citation,
      },
    },
    { type: "provider_event", event: { type: "response.output_item.done", output_index: 2, item: message } },
    { type: "text_end", contentIndex: 1 },
    { type: "provider_event", event: { type: "response.completed", response: providerResponse } },
    {
      type: "done",
      message: piMessage([
        { type: "thinking", thinking: "Search first.", thinkingSignature: JSON.stringify(reasoning) },
        { type: "text", text: "See the web docs.[1]", textSignature: "msg_provider" },
      ]),
    },
  ]);

  expect(events.filter((event) => event.event === "response.web_search_call.searching")).toHaveLength(1);
  expect(events.filter((event) => event.event === "response.output_text.annotation.added")).toHaveLength(1);
  const completedReasoning = (completed(events).output as Array<Record<string, unknown>>)[0];
  expect(completedReasoning.type).toBe("reasoning");
  if (typeof completedReasoning.encrypted_content !== "string") throw new Error("missing continuation state");
  expect(decodeUntrustedProviderContinuationState(completedReasoning.encrypted_content)).toMatchObject({
    kind: "openai_reasoning",
    hostedToolCallIds: ["ws_provider"],
  });
  expect(outputDone(events).find((event) => event.output_index === 1)?.item).toEqual(search);
  expect(outputDone(events).find((event) => event.output_index === 2)?.item).toMatchObject({
    type: "message",
    id: "msg_provider",
    content: [{ annotations: [citation] }],
  });
  expect(completed(events).output).toEqual([
    expect.objectContaining({ type: "reasoning", id: "rs_provider" }),
    search,
    expect.objectContaining({
      type: "message",
      id: "msg_provider",
      content: [{ type: "output_text", text: "See the web docs.[1]", annotations: [citation] }],
    }),
  ]);
});

test("does not overwrite hosted search when Pi text precedes the provider message item", async () => {
  const search = {
    type: "web_search_call",
    id: "ws_provider",
    status: "completed",
    action: { type: "search", query: "latest result" },
  };
  const message = {
    type: "message",
    id: "msg_provider",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Search answer.", annotations: [] }],
  };
  const events = await streamEvents([
    {
      type: "provider_event",
      event: {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "web_search_call", id: "ws_provider", status: "in_progress" },
      },
    },
    { type: "text_start", contentIndex: 0 },
    { type: "text_delta", contentIndex: 0, delta: "Search answer." },
    {
      type: "provider_event",
      event: { type: "response.output_item.added", output_index: 1, item: message },
    },
    { type: "text_end", contentIndex: 0 },
    {
      type: "provider_event",
      event: {
        type: "response.completed",
        response: { id: "resp_provider", status: "completed", output: [search, message] },
      },
    },
    { type: "done", message: piMessage([{ type: "text", text: "Search answer." }]) },
  ]);

  expect(events.filter((event) => event.event === "response.failed")).toHaveLength(0);
  expect(outputDone(events)).toMatchObject([
    { output_index: 1, item: { type: "message", content: [{ text: "Search answer." }] } },
    { output_index: 0, item: { type: "web_search_call", id: "ws_provider" } },
  ]);
  expect(completed(events).output).toMatchObject([
    { type: "web_search_call", id: "ws_provider" },
    { type: "message", content: [{ text: "Search answer." }] },
  ]);
});

test("emits an incomplete terminal response when the provider reaches its length limit", async () => {
  const events = await streamEvents([
    { type: "done", message: piMessage([{ type: "text", text: "Partial" }], "length") },
  ]);

  expect(events.filter((event) => event.event === "response.completed")).toHaveLength(0);
  expect(responseFor(events, "response.incomplete")).toMatchObject({
    id: "resp_request_123",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "message", status: "incomplete" }],
  });
});

test("fails when terminal output changes an already-streamed item identity", async () => {
  const events = await streamEvents([
    { type: "text_delta", contentIndex: 0, delta: "Started as text." },
    {
      type: "done",
      message: piMessage([
        { type: "toolCall", id: "call_changed", name: "read_file", arguments: { path: "README.md" } },
      ], "toolUse"),
    },
  ]);

  expect(events.filter((event) => event.event === "response.failed")).toHaveLength(1);
  expect(events.filter((event) => event.event === "response.completed")).toHaveLength(0);
});

test("fails when terminal output changes a streamed hosted-search ID", async () => {
  const events = await streamEvents([
    {
      type: "provider_event",
      event: {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "web_search_call", id: "ws_streamed", status: "in_progress" },
      },
    },
    {
      type: "provider_event",
      event: {
        type: "response.completed",
        response: {
          id: "resp_provider",
          status: "completed",
          output: [{ type: "web_search_call", id: "ws_terminal", status: "completed" }],
        },
      },
    },
    { type: "done", message: piMessage([]) },
  ]);

  expect(events.filter((event) => event.event === "response.failed")).toHaveLength(1);
  expect(events.filter((event) => event.event === "response.completed")).toHaveLength(0);
});

test("fails when terminal output omits a streamed output item", async () => {
  const events = await streamEvents([
    { type: "text_delta", contentIndex: 0, delta: "Reading." },
    {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: { id: "call_read", name: "read_file", arguments: { path: "README.md" } },
    },
    { type: "done", message: piMessage([{ type: "text", text: "Reading." }]) },
  ]);

  expect(events.filter((event) => event.event === "response.failed")).toHaveLength(1);
  expect(events.filter((event) => event.event === "response.completed")).toHaveLength(0);
});

test("reconciles Codex terminal events that omit their streamed output array", async () => {
  const search = { type: "web_search_call", id: "ws_codex", status: "completed" };
  const message = {
    type: "message",
    id: "msg_codex",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Search answer.", annotations: [] }],
  };
  const events = await streamEvents([
    {
      type: "provider_event",
      event: {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...search, status: "in_progress" },
      },
    },
    {
      type: "provider_event",
      event: { type: "response.output_item.done", output_index: 0, item: search },
    },
    {
      type: "provider_event",
      event: {
        type: "response.output_item.added",
        output_index: 1,
        item: { ...message, status: "in_progress", content: [] },
      },
    },
    { type: "text_start", contentIndex: 0 },
    { type: "text_delta", contentIndex: 0, delta: "Search answer." },
    { type: "text_end", contentIndex: 0 },
    {
      type: "provider_event",
      event: { type: "response.output_item.done", output_index: 1, item: message },
    },
    {
      type: "provider_event",
      event: {
        type: "response.completed",
        response: { id: "resp_codex", status: "completed", output: [] },
      },
    },
    { type: "done", message: piMessage([{ type: "text", text: "Search answer." }]) },
  ], OPENAI_CODEX);

  expect(events.filter((event) => event.event === "response.failed")).toHaveLength(0);
  expect(completed(events).output).toMatchObject([
    { type: "web_search_call", id: "ws_codex" },
    { type: "message", id: "msg_codex", content: [{ text: "Search answer." }] },
  ]);
});

async function streamEvents(
  events: Array<Record<string, unknown>>,
  source: ProviderIdentity = OPENAI
): Promise<StreamEvent[]> {
  const stream = openAIResponsesSseStream({
    id: "request_123",
    model: "dari/routing",
    routing: {
      selectedModel: "openai/gpt-5.5",
      reasoningEffort: "medium",
      reason: "selected",
    },
    events: asyncEvents(events),
    source,
    request: REQUEST,
  });
  return parseSse(await new Response(stream).text());
}

async function* asyncEvents(events: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  yield* events;
}

function piMessage(content: Array<Record<string, unknown>>, stopReason = "stop"): Record<string, unknown> {
  return {
    responseId: "resp_provider",
    timestamp: 1_750_000_000_000,
    stopReason,
    usage: { input: 4, output: 2, totalTokens: 6 },
    content,
  };
}

type StreamEvent = { event: string; data: Record<string, unknown> };

function parseSse(text: string): StreamEvent[] {
  return text.trim().split("\n\n").map((frame) => {
    const lines = frame.split("\n");
    return {
      event: lines[0].slice("event: ".length),
      data: JSON.parse(lines[1].slice("data: ".length)) as Record<string, unknown>,
    };
  });
}

function outputDone(events: StreamEvent[]): Array<Record<string, unknown>> {
  return events.filter((event) => event.event === "response.output_item.done").map((event) => event.data);
}

function completed(events: StreamEvent[]): Record<string, unknown> {
  return responseFor(events, "response.completed");
}

function eventData(events: StreamEvent[], eventName: string): Record<string, unknown> {
  const event = events.find((candidate) => candidate.event === eventName);
  if (!event) throw new Error(`Missing ${eventName} event.`);
  return event.data;
}

function responseFor(events: StreamEvent[], eventName: string): Record<string, unknown> {
  const event = events.find((candidate) => candidate.event === eventName);
  if (!event || !isRecord(event.data.response)) throw new Error(`Missing ${eventName} response.`);
  return event.data.response;
}

function item(event: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(event.item)) throw new Error("Missing output item.");
  return event.item;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
