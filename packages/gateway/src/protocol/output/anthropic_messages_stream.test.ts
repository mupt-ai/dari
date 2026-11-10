import { expect, test } from "bun:test";

import { decodeUntrustedProviderContinuationState } from "../../interaction/provider_continuation_state.js";
import { decodeUntrustedPortableReasoningState } from "../../interaction/portable_reasoning_state.js";
import type { InteractionRequest, ProviderIdentity } from "../../interaction/types.js";
import { anthropicMessagesSseStream } from "./anthropic_messages_stream.js";

const CLAUDE: ProviderIdentity = {
  provider: "anthropic",
  api: "anthropic-messages",
  model: "claude-sonnet-4-6",
};
const REQUEST: InteractionRequest = {
  sourceProtocol: "anthropic_messages",
  model: "dari/routing",
  items: [],
  tools: [],
  generation: { maxOutputTokens: 4096 },
  stream: true,
};

test("streams Anthropic thinking signatures, text, tools, and terminal usage", async () => {
  const reasoning = { type: "thinking", thinking: "Inspect first.", thinkingSignature: "native-signature" };
  const text = { type: "text", text: "Reading." };
  const tool = { type: "toolCall", id: "toolu_read", name: "read_file", arguments: { path: "README.md" } };
  const terminal = piMessage([reasoning, text, tool]);
  const stream = anthropicMessagesSseStream({
    id: "request_123",
    model: "anthropic/claude-sonnet-4-6",
    routing: {
      selectedModel: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "high",
      reason: "selected",
    },
    source: CLAUDE,
    request: REQUEST,
    events: asyncEvents([
      { type: "thinking_start", contentIndex: 0, partial: terminal },
      { type: "thinking_delta", contentIndex: 0, delta: "Inspect first.", partial: terminal },
      { type: "thinking_end", contentIndex: 0, partial: terminal },
      { type: "text_start", contentIndex: 1, partial: terminal },
      { type: "text_delta", contentIndex: 1, delta: "Reading.", partial: terminal },
      { type: "text_end", contentIndex: 1, partial: terminal },
      { type: "toolcall_start", contentIndex: 2, partial: terminal },
      { type: "toolcall_end", contentIndex: 2, toolCall: tool, partial: terminal },
      { type: "done", message: terminal },
    ]),
  });

  const events = parseSse(await new Response(stream).text());
  expect(events.map((event) => event.event)).toContain("message_stop");
  expect(events.find((event) => event.data.type === "message_delta")?.data).toMatchObject({
    delta: { stop_reason: "tool_use" },
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
      output_tokens: 4,
    },
  });
  const signatureEvent = events.find((event) => {
    const delta = event.data.delta;
    return delta && typeof delta === "object" && (delta as Record<string, unknown>).type === "signature_delta";
  });
  const signature = (signatureEvent?.data.delta as Record<string, unknown>).signature;
  expect(decodeUntrustedProviderContinuationState(String(signature))).toEqual({
    kind: "anthropic_thinking",
    source: CLAUDE,
    thinking: "Inspect first.",
    signature: "native-signature",
  });
});

test("streams scrubbed provider error details", async () => {
  const message = {
    stopReason: "error",
    errorMessage: "503 provider overloaded",
    content: [],
  };
  const stream = anthropicMessagesSseStream({
    id: "request_error",
    model: "anthropic/claude-sonnet-4-6",
    routing: {
      selectedModel: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "high",
      reason: "selected",
    },
    source: CLAUDE,
    request: REQUEST,
    events: asyncEvents([{ type: "error", error: message }]),
  });

  const events = parseSse(await new Response(stream).text());
  expect(events.find((event) => event.event === "error")?.data).toMatchObject({
    error: { type: "api_error", message: "503 provider overloaded" },
  });
});

test("streams a portable signature instead of an empty fallback envelope", async () => {
  const terminal = piMessage([{ type: "thinking", thinking: "Portable thought." }]);
  const stream = anthropicMessagesSseStream({
    id: "request_portable",
    model: "anthropic/claude-sonnet-4-6",
    routing: {
      selectedModel: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "high",
      reason: "selected",
    },
    source: CLAUDE,
    request: REQUEST,
    events: asyncEvents([
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_delta", contentIndex: 0, delta: "Portable thought." },
      { type: "thinking_end", contentIndex: 0 },
      { type: "done", message: terminal },
    ]),
  });

  const events = parseSse(await new Response(stream).text());
  const signatureEvent = events.find((event) => {
    const delta = event.data.delta;
    return delta && typeof delta === "object" && (delta as Record<string, unknown>).type === "signature_delta";
  });
  const signature = String((signatureEvent?.data.delta as Record<string, unknown>).signature);
  expect(decodeUntrustedPortableReasoningState(signature)).toEqual({
    source: CLAUDE,
  });
});

async function* asyncEvents(events: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  yield* events;
}

function piMessage(content: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    responseId: "provider_response",
    timestamp: 1_750_000_000_000,
    stopReason: "toolUse",
    usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17 },
    content,
  };
}

function parseSse(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text.trim().split("\n\n").map((frame) => {
    const lines = frame.split("\n");
    return {
      event: lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "",
      data: JSON.parse(lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "{}") as Record<string, unknown>,
    };
  });
}
