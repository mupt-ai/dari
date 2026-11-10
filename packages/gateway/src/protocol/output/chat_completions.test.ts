import { expect, test } from "bun:test";

import { chatCompletionResponse, chatCompletionsSseStream } from "./chat_completions.js";
import { isRecord } from "@mupt-ai/dari-router/policy-engine";
import type { InteractionOutput, InteractionRequest, ProviderIdentity } from "../../interaction/types.js";
import { decodeUntrustedProviderContinuationState } from "../../interaction/provider_continuation_state.js";

const routing = {
  selectedModel: "openai/gpt-4.1-mini",
  reasoningEffort: "off" as const,
  reason: "fast",
};
const streamContext: { source: ProviderIdentity; request: InteractionRequest } = {
  source: { provider: "openai", api: "openai-responses", model: "gpt-4.1-mini" },
  request: {
    sourceProtocol: "openai_chat",
    items: [],
    tools: [],
    generation: {},
    stream: true,
  },
};

test("maps tool-call messages to OpenAI chat completion shape", () => {
  const response = chatCompletionResponse({
    id: "req_1",
    model: "openai/gpt-4.1-mini",
    routing,
    output: interactionOutput({
      stopReason: "tool_use",
      createdAtMs: 1_700_000_000_000,
      usage: { ...zeroUsage(), input: 10, output: 3, totalTokens: 13 },
      items: [
        {
          type: "tool_call",
          callId: "call_1",
          kind: "function",
          name: "get_weather",
          input: { city: "Oakland" },
        },
      ],
    }),
  });

  expect(response).toMatchObject({
    id: "chatcmpl-req_1",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "openai/gpt-4.1-mini",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: JSON.stringify({ city: "Oakland" }) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    dari_routing: {
      requested_model: "dari/routing",
      selected_model: "openai/gpt-4.1-mini",
      reason: "fast",
    },
  });
});

test("recomputes total_tokens when cache tokens are folded into prompt_tokens", () => {
  const response = chatCompletionResponse({
    id: "req_cached",
    model: "openai/gpt-4.1-mini",
    routing,
    output: interactionOutput({
      usage: { ...zeroUsage(), input: 10, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 13 },
      items: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          contentShape: "parts",
        },
      ],
    }),
  });

  expect(response.usage).toEqual({
    prompt_tokens: 13,
    completion_tokens: 3,
    total_tokens: 16,
    prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
    cost: null,
  });
});

test("maps hosted search output to a Chat-visible tool call", () => {
  const payload = {
    type: "web_search_call",
    id: "ws_1",
    status: "completed",
    action: { type: "search", query: "Dari release notes" },
  };
  const response = chatCompletionResponse({
    id: "req_hosted_search",
    model: "openai/gpt-5.5",
    routing: { ...routing, selectedModel: "openai/gpt-5.5" },
    output: interactionOutput({
      items: [
        {
          type: "hosted_tool_call",
          id: "ws_1",
          tool: "web_search",
          providerType: "web_search_call",
          status: "completed",
          payload,
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Found them." }],
          contentShape: "parts",
        },
      ],
    }),
  });

  expect(response).toMatchObject({
    choices: [{
      message: {
        role: "assistant",
        content: "Found them.",
        tool_calls: [{
          id: "ws_1",
          type: "function",
          function: { name: "web_search", arguments: JSON.stringify(payload) },
        }],
      },
    }],
  });
});

test("normalizes hosted search metadata for replayable Chat output", () => {
  const response = chatCompletionResponse({
    id: "req_hosted_search_status",
    model: "openai/gpt-5.5",
    routing: { ...routing, selectedModel: "openai/gpt-5.5" },
    output: interactionOutput({
      items: [{
        type: "hosted_tool_call",
        id: "ws_canonical",
        tool: "web_search",
        providerType: "web_search_call",
        payload: {
          type: "web_search_call",
          id: "ws_provider_alias",
          status: null,
          action: { type: "search", query: "Dari release notes" },
        },
      }],
    }),
  });
  const message = (response.choices as Array<Record<string, unknown>>)[0]
    ?.message as Record<string, unknown>;
  const toolCall = (message.tool_calls as Array<Record<string, unknown>>)[0];
  const fn = toolCall.function as Record<string, unknown>;

  expect(JSON.parse(String(fn.arguments))).toEqual({
    type: "web_search_call",
    id: "ws_canonical",
    action: { type: "search", query: "Dari release notes" },
  });
});

test("carries provider thinking state beside Chat tool calls", () => {
  const source: ProviderIdentity = {
    provider: "anthropic",
    api: "anthropic-messages",
    model: "claude-sonnet-4-6",
  };
  const response = chatCompletionResponse({
    id: "req_reasoning",
    model: "anthropic/claude-sonnet-4-6",
    routing: { ...routing, selectedModel: "anthropic/claude-sonnet-4-6", reasoningEffort: "high" },
    output: interactionOutput({
      source,
      stopReason: "tool_use",
      items: [
        {
          type: "reasoning",
          summary: ["Inspect first."],
          content: [],
          source,
          continuation: {
            kind: "anthropic_thinking",
            source,
            thinking: "Inspect first.",
            signature: "native-signature",
          },
        },
        { type: "tool_call", callId: "call_1", kind: "function", name: "read_file", input: { path: "README.md" } },
      ],
    }),
  });

  const message = ((response.choices as Array<Record<string, unknown>>)[0].message) as Record<string, unknown>;
  expect(message).toMatchObject({
    reasoning_content: "Inspect first.",
    reasoning_details: [{ type: "reasoning.encrypted", id: "call_1" }],
  });
  const detail = (message.reasoning_details as Array<Record<string, unknown>>)[0];
  expect(decodeUntrustedProviderContinuationState(String(detail.data))).toEqual({
    kind: "anthropic_thinking",
    source,
    thinking: "Inspect first.",
    signature: "native-signature",
  });
});

test("carries provider thinking state on reasoning-only Chat turns", () => {
  const source: ProviderIdentity = {
    provider: "openai",
    api: "openai-responses",
    model: "gpt-5.5",
  };
  const response = chatCompletionResponse({
    id: "req_reasoning_only",
    model: "openai/gpt-5.5",
    routing: { ...routing, selectedModel: "openai/gpt-5.5", reasoningEffort: "high" },
    output: interactionOutput({
      source,
      items: [
        {
          type: "reasoning",
          id: "rs_provider",
          summary: ["Consider the answer."],
          content: [],
          source,
          continuation: {
            kind: "openai_reasoning",
            source,
            encryptedContent: "encrypted-state",
            providerItemId: "rs_provider",
          },
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          contentShape: "parts",
          source,
        },
      ],
    }),
  });

  const message = ((response.choices as Array<Record<string, unknown>>)[0].message) as Record<string, unknown>;
  expect(message).toMatchObject({
    content: "Done.",
    reasoning_content: "Consider the answer.",
    reasoning_details: [{ type: "reasoning.encrypted", id: "rs_provider" }],
  });
  const detail = (message.reasoning_details as Array<Record<string, unknown>>)[0];
  expect(decodeUntrustedProviderContinuationState(String(detail.data))).toEqual({
    kind: "openai_reasoning",
    source,
    encryptedContent: "encrypted-state",
    providerItemId: "rs_provider",
  });
});

test("assigns unique Chat detail ids when reasoning outnumbers tool calls", () => {
  const source: ProviderIdentity = {
    provider: "anthropic",
    api: "anthropic-messages",
    model: "claude-sonnet-4-6",
  };
  const response = chatCompletionResponse({
    id: "req_multiple_reasoning",
    model: "anthropic/claude-sonnet-4-6",
    routing: { ...routing, selectedModel: "anthropic/claude-sonnet-4-6", reasoningEffort: "high" },
    output: interactionOutput({
      source,
      stopReason: "tool_use",
      items: [
        {
          type: "reasoning",
          summary: ["First."],
          content: [],
          continuation: {
            kind: "anthropic_thinking",
            source,
            thinking: "First.",
            signature: "signature-1",
          },
        },
        {
          type: "reasoning",
          summary: ["Second."],
          content: [],
          continuation: {
            kind: "anthropic_thinking",
            source,
            thinking: "Second.",
            signature: "signature-2",
          },
        },
        { type: "tool_call", callId: "call_1", kind: "function", name: "read_file", input: {} },
      ],
    }),
  });

  const message = ((response.choices as Array<Record<string, unknown>>)[0].message) as Record<string, unknown>;
  const ids = (message.reasoning_details as Array<Record<string, unknown>>).map((detail) => detail.id);
  expect(ids).toEqual(["call_1", "reasoning_1"]);
});

test("streams readable and opaque reasoning state for Pi Chat clients", async () => {
  const source: ProviderIdentity = {
    provider: "anthropic",
    api: "anthropic-messages",
    model: "claude-sonnet-4-6",
  };
  const thinking = { type: "thinking", thinking: "Inspect first.", thinkingSignature: "native-signature" };
  const tool = { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "README.md" } };
  async function* events() {
    yield { type: "thinking_delta", contentIndex: 0, delta: "Inspect first." };
    yield { type: "toolcall_start", contentIndex: 1, partial: { content: [thinking, tool] } };
    yield { type: "toolcall_end", contentIndex: 1, toolCall: tool };
    yield {
      type: "done",
      message: { stopReason: "toolUse", content: [thinking, tool] },
    };
  }
  const frames = await sseFrames(new Response(chatCompletionsSseStream({
    id: "req_stream_reasoning",
    model: "anthropic/claude-sonnet-4-6",
    routing: { ...routing, selectedModel: "anthropic/claude-sonnet-4-6", reasoningEffort: "high" },
    events: events(),
    source,
    request: streamContext.request,
  })));
  const deltas = frames.map((frame) => {
    const choices = arrayValue(frame.choices);
    const choice = isRecord(choices[0]) ? choices[0] : {};
    return isRecord(choice.delta) ? choice.delta : {};
  });
  expect(deltas.some((delta) => delta.reasoning_content === "Inspect first.")).toBe(true);
  const detail = deltas.flatMap((delta) => arrayValue(delta.reasoning_details)).find(isRecord);
  expect(detail).toMatchObject({ type: "reasoning.encrypted", id: "call_1" });
  expect(decodeUntrustedProviderContinuationState(String(detail?.data))).toMatchObject({
    kind: "anthropic_thinking",
    signature: "native-signature",
  });
});

test("streams tool-call arguments once when end includes full arguments", async () => {
  async function* events() {
    yield { type: "toolcall_start", index: 0, toolCallId: "call_1", toolName: "get_weather" };
    yield { type: "toolcall_delta", index: 0, delta: '{"city"' };
    yield { type: "toolcall_delta", index: 0, delta: ':"Oakland"}' };
    yield { type: "toolcall_end", index: 0, toolCall: { id: "call_1", name: "get_weather", arguments: { city: "Oakland" } } };
    yield { type: "done", message: { stopReason: "toolUse" } };
  }

  const response = streamResponse("req_tools", events());
  const argumentChunks = toolCallArgumentChunks(await sseFrames(response));

  expect(argumentChunks.join("")).toBe(JSON.stringify({ city: "Oakland" }));
});

test("does not duplicate tool-call arguments when delta is keyed by id and end is indexed", async () => {
  async function* events() {
    yield { type: "toolcall_delta", toolCallId: "call_1", delta: JSON.stringify({ city: "Oakland" }) };
    yield { type: "toolcall_end", index: 0, toolCall: { id: "call_1", name: "get_weather", arguments: { city: "Oakland" } } };
    yield { type: "done", message: { stopReason: "toolUse" } };
  }

  const response = streamResponse("req_mixed_tool_key", events());
  const argumentChunks = toolCallArgumentChunks(await sseFrames(response));

  expect(argumentChunks).toEqual([JSON.stringify({ city: "Oakland" })]);
});

test("keeps unindexed tool-call argument tracking isolated by tool call id", async () => {
  async function* events() {
    yield { type: "toolcall_delta", toolCallId: "call_1", delta: JSON.stringify({ city: "Oakland" }) };
    yield { type: "toolcall_end", toolCall: { id: "call_1", name: "get_weather", arguments: { city: "Oakland" } } };
    yield { type: "toolcall_end", toolCall: { id: "call_2", name: "lookup", arguments: { query: "Dari" } } };
    yield { type: "done", message: { stopReason: "toolUse" } };
  }

  const response = streamResponse("req_multi_tools", events());
  const argumentChunks = toolCallArgumentChunks(await sseFrames(response));

  expect(argumentChunks).toEqual([
    JSON.stringify({ city: "Oakland" }),
    JSON.stringify({ query: "Dari" }),
  ]);
});

test("streams fallback tool-call names for unnamed starts", async () => {
  async function* events() {
    yield { type: "toolcall_start", toolCallId: "call_1" };
    yield { type: "toolcall_end", toolCall: { id: "call_1", name: "get_weather", arguments: { city: "Oakland" } } };
    yield { type: "done", message: { stopReason: "toolUse" } };
  }

  const response = streamResponse("req_unnamed_tool", events());
  const deltas = toolCallDeltas(await sseFrames(response));

  expect(deltas[0]).toMatchObject({
    index: 0,
    id: "call_1",
    type: "function",
    function: { name: "tool", arguments: "" },
  });
  expect(deltas.some((delta) => isRecord(delta.function) && delta.function.name === "get_weather")).toBe(true);
});

test("streams Pi tool-call partial details without content-index leakage or duplicate names", async () => {
  async function* events() {
    yield { type: "text_delta", contentIndex: 0, delta: "Checking. " };
    yield {
      type: "toolcall_start",
      contentIndex: 1,
      partial: {
        content: [
          { type: "text", text: "Checking. " },
          { type: "toolCall", id: "call_1", name: "get_weather", arguments: {} },
        ],
      },
    };
    yield { type: "toolcall_delta", contentIndex: 1, delta: JSON.stringify({ city: "Oakland" }) };
    yield { type: "toolcall_end", contentIndex: 1, toolCall: { id: "call_1", name: "get_weather", arguments: { city: "Oakland" } } };
    yield { type: "done", message: { stopReason: "toolUse" } };
  }

  const response = streamResponse("req_pi_tool", events());
  const frames = await sseFrames(response);
  const deltas = toolCallDeltas(frames);

  expect(deltas[0]).toMatchObject({
    index: 0,
    id: "call_1",
    type: "function",
    function: { name: "get_weather", arguments: "" },
  });
  expect(deltas.filter((delta) => isRecord(delta.function) && delta.function.name === "get_weather")).toHaveLength(1);
  expect(toolCallArgumentChunks(frames)).toEqual([JSON.stringify({ city: "Oakland" })]);
});

test("streams canonical Chat tool-call IDs from OpenAI Responses provider events", async () => {
  async function* events() {
    yield {
      type: "toolcall_start",
      contentIndex: 0,
      partial: {
        content: [
          { type: "toolCall", id: "call_1|fc_1", name: "get_weather", arguments: {} },
        ],
      },
    };
    yield {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { id: "call_1|fc_1", name: "get_weather", arguments: { city: "Oakland" } },
    };
    yield {
      type: "toolcall_end",
      toolCall: { id: "call_2|fc_2", name: "lookup", arguments: { query: "Dari" } },
    };
    yield { type: "done", message: { stopReason: "toolUse" } };
  }

  const deltas = toolCallDeltas(await sseFrames(streamResponse("req_responses_ids", events())));
  expect(deltas.filter((delta) => typeof delta.id === "string").map((delta) => delta.id)).toEqual([
    "call_1",
    "call_2",
  ]);
  expect(JSON.stringify(deltas)).not.toContain("|fc_");
});

test("rejects oversized provider tool-call IDs before streaming them to the client", async () => {
  const oversizedId = "c".repeat(513);
  async function* events() {
    yield {
      type: "toolcall_start",
      contentIndex: 0,
      toolCallId: `${oversizedId}|fc_oversized`,
      toolName: "read_file",
    };
  }

  const frames = await sseFrames(
    streamResponse("req_oversized_tool_id", events()),
  );

  expect(JSON.stringify(frames)).not.toContain(oversizedId);
  expect(JSON.stringify(frames)).toContain(
    '"code":"provider_execution_failed"',
  );
});

test("streams hosted search output from the terminal provider response", async () => {
  const hostedSearch = {
    type: "web_search_call",
    id: "ws_stream",
    status: "completed",
    action: { type: "search", query: "Dari release notes" },
  };
  async function* events() {
    yield {
      type: "done",
      message: {
        stopReason: "stop",
        providerResponse: {
          id: "resp_stream",
          created_at: 1_750_000_000,
          output: [
            hostedSearch,
            {
              type: "message",
              id: "msg_stream",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Found them.", annotations: [] }],
            },
          ],
        },
      },
    };
  }

  const deltas = toolCallDeltas(await sseFrames(streamResponse("req_stream_hosted", events())));
  expect(deltas).toContainEqual({
    index: 0,
    id: "ws_stream",
    type: "function",
    function: { name: "web_search", arguments: JSON.stringify(hostedSearch) },
  });
});

test("streams routing metadata, deltas, final stop, and done", async () => {
  async function* events() {
    yield { type: "text_delta", delta: "hello" };
    yield { type: "done", message: { stopReason: "stop", usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 16 } } };
  }

  const response = streamResponse("req_2", events());
  const text = await response.text();
  const frames = text.trim().split("\n\n");

  expect(frames[0]).toContain('"dari_routing"');
  expect(frames[2]).toContain('"content":"hello"');
  expect(frames[3]).toContain('"finish_reason":"stop"');
  expect(frames[3]).toContain('"usage":{"cost":null,"prompt_tokens":13,"completion_tokens":3,"total_tokens":16,"prompt_tokens_details":{"cached_tokens":2,"cache_write_tokens":1}}');
  expect(frames.at(-1)).toBe("data: [DONE]");
});

test("cancelling during the terminal barrier does not write to the cancelled stream", async () => {
  let releaseBarrier: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  let finalized = 0;
  async function* events() {
    yield { type: "text_delta", delta: "hello" };
    yield { type: "done", message: { stopReason: "stop" } };
  }
  const response = new Response(
    chatCompletionsSseStream({
      id: "req_cancel_barrier",
      model: "openai/gpt-4.1-mini",
      routing,
      events: events(),
      ...streamContext,
      beforeClose: () => barrier,
      onFinal: () => {
        finalized += 1;
      },
    }),
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes('"finish_reason":"stop"')) {
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    text += decoder.decode(chunk.value);
  }

  await reader.cancel();
  expect(finalized).toBe(1);
  releaseBarrier();
  await Bun.sleep(0);
  await Bun.sleep(0);
  expect(finalized).toBe(1);
});

async function sseFrames(response: Response): Promise<Record<string, unknown>[]> {
  const frames: Record<string, unknown>[] = [];
  for (const frame of (await response.text()).trim().split("\n\n")) {
    if (frame === "data: [DONE]") continue;
    const parsed = JSON.parse(frame.replace(/^data: /, ""));
    if (isRecord(parsed)) frames.push(parsed);
  }
  return frames;
}

function streamResponse(id: string, events: AsyncIterable<Record<string, unknown>>): Response {
  return new Response(chatCompletionsSseStream({
    ...streamContext,
    id,
    model: "openai/gpt-4.1-mini",
    routing,
    events,
  }));
}

function toolCallArgumentChunks(frames: Record<string, unknown>[]): string[] {
  const chunks: string[] = [];
  for (const toolCall of toolCallDeltas(frames)) {
    if (!isRecord(toolCall.function)) continue;
    const value = toolCall.function.arguments;
    if (typeof value === "string" && value.length > 0) chunks.push(value);
  }
  return chunks;
}

function toolCallDeltas(frames: Record<string, unknown>[]): Record<string, unknown>[] {
  const deltas: Record<string, unknown>[] = [];
  for (const frame of frames) {
    const choices = arrayValue(frame.choices);
    const choice = isRecord(choices[0]) ? choices[0] : {};
    const delta = isRecord(choice.delta) ? choice.delta : {};
    for (const toolCall of arrayValue(delta.tool_calls)) {
      if (isRecord(toolCall)) deltas.push(toolCall);
    }
  }
  return deltas;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function interactionOutput(overrides: Partial<InteractionOutput>): InteractionOutput {
  return {
    createdAtMs: Date.now(),
    source: { provider: "openai", api: "openai-responses", model: "gpt-4.1-mini" },
    items: [],
    usage: zeroUsage(),
    stopReason: "stop",
    ...overrides,
  };
}

function zeroUsage(): InteractionOutput["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
