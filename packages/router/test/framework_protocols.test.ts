import { expect, test } from "bun:test";

import {
  encodeProviderContinuationState,
  type ProviderContinuationState,
} from "../src/continuation_state.js";
import { RouterFrameworkError } from "../src/framework_error.js";
import { anthropicOutputContent, anthropicRequest } from "../src/protocol_anthropic.js";
import { openAIChatRequest, openAIChatResponse, openAIStreamDelta } from "../src/protocol_openai_chat.js";

test("OpenAI Chat Completions normalizes the portable request subset", () => {
  const request = openAIChatRequest({
    model: "my-router",
    messages: [
      { role: "system", content: "Be concise." },
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this." },
          { type: "image_url", image_url: { url: "https://example.com/image.png", detail: "high" } },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: "{\"id\":1}" },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "found" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "lookup",
        description: "Look up an object.",
        parameters: { type: "object", properties: { id: { type: "number" } } },
        strict: true,
      },
    }],
    tool_choice: { type: "function", function: { name: "lookup" } },
    parallel_tool_calls: false,
    temperature: 0,
    top_p: 0,
    max_completion_tokens: 128,
    stop: ["END"],
    reasoning_effort: "high",
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "answer",
        description: "A result.",
        schema: { type: "object" },
        strict: true,
      },
    },
    prompt_cache_key: "conversation-1",
    metadata: { trace: "public-value" },
    user: "user-1",
    stream: true,
  });

  expect(request).toEqual({
    protocol: "openai_chat_completions",
    requestedModel: "my-router",
    items: [
      { type: "message", role: "system", content: [{ type: "text", text: "Be concise." }] },
      {
        type: "message",
        role: "user",
        content: [
          { type: "text", text: "Inspect this." },
          { type: "image", url: "https://example.com/image.png", detail: "high" },
        ],
      },
      { type: "tool_call", id: "call_1", name: "lookup", arguments: "{\"id\":1}" },
      {
        type: "tool_result",
        toolCallId: "call_1",
        content: [{ type: "text", text: "found" }],
      },
    ],
    tools: [{
      name: "lookup",
      description: "Look up an object.",
      inputSchema: { type: "object", properties: { id: { type: "number" } } },
      strict: true,
    }],
    toolChoice: { type: "tool", name: "lookup" },
    parallelToolCalls: false,
    generation: {
      temperature: 0,
      topP: 0,
      maxOutputTokens: 128,
      stop: ["END"],
    },
    reasoning: { effort: "high", enabled: true },
    responseFormat: {
      type: "json_schema",
      name: "answer",
      description: "A result.",
      schema: { type: "object" },
      strict: true,
    },
    cacheKey: "conversation-1",
    stream: true,
    metadata: { trace: "public-value" },
    user: "user-1",
  });
});

test("OpenAI Chat Completions preserves readable and encrypted reasoning history", () => {
  const continuation: ProviderContinuationState = {
    kind: "openai_reasoning",
    source: { provider: "openai", api: "openai-responses", model: "openai/gpt-5.4" },
    encryptedContent: "encrypted-openai-state",
    providerItemId: "rs_1",
  };
  const request = openAIChatRequest({
    model: "my-router",
    messages: [{
      role: "assistant",
      content: "Answer.",
      reasoning_content: "Inspect first.",
      reasoning_details: [{
        type: "reasoning.encrypted",
        id: "rs_1",
        data: encodeProviderContinuationState(continuation),
      }],
    }],
  });

  expect(request.items).toEqual([
    {
      type: "reasoning",
      id: "rs_1",
      summary: ["Inspect first."],
      content: [],
      source: continuation.source,
      continuation,
    },
    { type: "message", role: "assistant", content: [{ type: "text", text: "Answer." }] },
  ]);
});

test("OpenAI Chat Completions emits readable and encrypted reasoning output", () => {
  const continuation: ProviderContinuationState = {
    kind: "openai_reasoning",
    source: { provider: "openai", api: "openai-responses", model: "openai/gpt-5.4" },
    encryptedContent: "encrypted-openai-state",
  };
  const response = openAIChatResponse({
    id: "response-1",
    model: "openai/gpt-5.4",
    requestedModel: "my-router",
    output: {
      content: [
        { type: "reasoning", text: "Inspect first.", source: continuation.source, continuation },
        { type: "text", text: "Answer." },
      ],
      finishReason: "stop",
    },
    selection: {
      decision: { selectedModel: "openai/gpt-5.4", reasoningEffort: "high", reason: "test" },
      candidates: [],
      source: "policy",
    },
  });
  expect(response.dari_routing).toEqual({
    requested_model: "my-router",
    selected_model: "openai/gpt-5.4",
    reasoning_effort: "high",
    reason: "test",
  });
  const message = (response.choices as Array<Record<string, unknown>>)[0]!.message as Record<string, unknown>;
  expect(message.reasoning_content).toBe("Inspect first.");
  expect(message.reasoning_details).toEqual([{
    type: "reasoning.encrypted",
    id: "reasoning_0",
    data: encodeProviderContinuationState(continuation),
  }]);
});

test("OpenAI plain reasoning round-trips its provenance through a portable envelope", () => {
  const source = { provider: "moonshot", api: "openai-completions", model: "moonshot/kimi-k2.5" };
  const response = openAIChatResponse({
    id: "response-1",
    model: "moonshot/kimi-k2.5",
    requestedModel: "my-router",
    output: {
      content: [
        { type: "reasoning", text: "Kimi inspected the patch.", source },
        { type: "text", text: "Answer." },
      ],
      finishReason: "stop",
    },
    selection: {
      decision: { selectedModel: "moonshot/kimi-k2.5", reasoningEffort: "high", reason: "test" },
      candidates: [],
      source: "policy",
    },
  });
  const message = (response.choices as Array<Record<string, unknown>>)[0]!.message as Record<string, unknown>;
  const details = message.reasoning_details as Array<Record<string, unknown>>;
  expect(details).toHaveLength(1);
  expect(details[0]).toMatchObject({ type: "reasoning.encrypted", id: "reasoning_0" });
  expect(String(details[0]!.data)).toStartWith("dari-ir-v1.");

  const replayed = openAIChatRequest({
    model: "my-router",
    messages: [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "Answer.",
        reasoning_content: "Kimi inspected the patch.",
        reasoning_details: details,
      },
      { role: "user", content: "next" },
    ],
  });
  const reasoning = replayed.items.find((item) => item.type === "reasoning");
  expect(reasoning).toEqual({
    type: "reasoning",
    id: "reasoning_0",
    summary: ["Kimi inspected the patch."],
    content: [],
    source,
  });
});

test("OpenAI tool-only assistant messages normalize empty and null content equally", () => {
  const toolCalls = [{
    id: "call_1",
    type: "function",
    function: { name: "lookup", arguments: "{}" },
  }];
  const normalizedEmpty = openAIChatRequest({
    model: "my-router",
    messages: [{ role: "assistant", content: "", tool_calls: toolCalls }],
  });
  const normalizedNull = openAIChatRequest({
    model: "my-router",
    messages: [{ role: "assistant", content: null, tool_calls: toolCalls }],
  });

  expect(normalizedEmpty.items).toEqual(normalizedNull.items);
  expect(normalizedEmpty.items).toEqual([
    { type: "tool_call", id: "call_1", name: "lookup", arguments: "{}" },
  ]);
});

test("Anthropic tool-only assistant messages omit adjacent empty text blocks", () => {
  const normalized = anthropicRequest({
    model: "my-router",
    max_tokens: 64,
    messages: [{
      role: "assistant",
      content: [
        { type: "text", text: "" },
        { type: "tool_use", id: "call_1", name: "lookup", input: {} },
        { type: "text", text: "" },
      ],
    }],
  });

  expect(normalized.items).toEqual([
    { type: "tool_call", id: "call_1", name: "lookup", arguments: {} },
  ]);
});

test("Anthropic thinking blocks preserve provider continuation state", () => {
  const continuation: ProviderContinuationState = {
    kind: "anthropic_thinking",
    source: { provider: "anthropic", api: "anthropic-messages", model: "anthropic/claude-opus-4-6" },
    thinking: "Inspect first.",
    signature: "anthropic-signature",
  };
  const request = anthropicRequest({
    model: "my-router",
    max_tokens: 64,
    messages: [{
      role: "assistant",
      content: [{
        type: "thinking",
        thinking: "Inspect first.",
        signature: encodeProviderContinuationState(continuation),
      }],
    }],
  });

  expect(request.items).toEqual([{
    type: "reasoning",
    summary: ["Inspect first."],
    content: [],
    source: continuation.source,
    continuation,
  }]);
});

test("plain model reasoning becomes a portable Anthropic thinking block", () => {
  const [block] = anthropicOutputContent({
    content: [{
      type: "reasoning",
      text: "Kimi inspected the patch.",
      source: { provider: "moonshot", api: "openai-completions", model: "moonshot/kimi-k2.5" },
    }],
    finishReason: "stop",
  });
  expect(block).toMatchObject({
    type: "thinking",
    thinking: "Kimi inspected the patch.",
  });
  expect(String(block?.signature)).toStartWith("dari-ir-v1.");
});

test("Anthropic prompt_cache_key maps to cacheKey for lease correlation", () => {
  const normalized = anthropicRequest({
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    prompt_cache_key: "anthropic-conv-1",
  });
  expect(normalized.cacheKey).toBe("anthropic-conv-1");
});

test("OpenAI Chat Completions rejects fields outside the portable subset", () => {
  expect(() => openAIChatRequest({
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    functions: [],
  })).toThrow(RouterFrameworkError);

  try {
    openAIChatRequest({
      model: "my-router",
      messages: [{ role: "user", content: "hello" }],
      functions: [],
    });
  } catch (error) {
    expect(error).toMatchObject({ code: "unsupported_field", param: "functions" });
  }
});

test("portable protocol validation rejects dropped fields and inconsistent controls", () => {
  expect(() => openAIChatRequest({
    model: "my-router",
    messages: [{ role: "user", content: "hello", name: "ignored-name" }],
  })).toThrow(/messages\.0\.name is not supported/);

  expect(() => openAIChatRequest({
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    temperature: -1,
  })).toThrow(/temperature must be between 0 and 2/);

  expect(() => openAIChatRequest({
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "known" } }],
    tool_choice: { type: "function", function: { name: "missing" } },
  })).toThrow(/tool_choice references unknown tool 'missing'/);

  expect(() => anthropicRequest({
    model: "my-router",
    max_tokens: 64,
    messages: [{
      role: "user",
      content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
    }],
  })).toThrow(/cache_control is not supported/);

  expect(() => anthropicRequest({
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    thinking: { type: "enabled", budget_tokens: 1024 },
    output_config: { effort: "off" },
  })).toThrow(/Enabled thinking cannot use output_config\.effort 'off'/);
});

test("Anthropic Messages normalizes tools, results, images, and thinking", () => {
  const request = anthropicRequest({
    model: "my-router",
    max_tokens: 256,
    system: [{ type: "text", text: "Be concise." }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this." },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { id: 1 } }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_1",
          content: "found",
          is_error: false,
        }],
      },
    ],
    tools: [{
      name: "lookup",
      description: "Look up an object.",
      input_schema: { type: "object" },
      strict: true,
    }],
    tool_choice: { type: "any", disable_parallel_tool_use: true },
    thinking: { type: "enabled", budget_tokens: 1024 },
    output_config: {
      effort: "high",
      format: { type: "json_schema", name: "answer", schema: { type: "object" } },
    },
    temperature: 0,
    top_p: 0,
    stop_sequences: ["END"],
    metadata: { user_id: "user-1" },
    stream: true,
  });

  expect(request).toMatchObject({
    protocol: "anthropic_messages",
    requestedModel: "my-router",
    items: [
      { type: "message", role: "system", content: [{ type: "text", text: "Be concise." }] },
      {
        type: "message",
        role: "user",
        content: [
          { type: "text", text: "Inspect this." },
          { type: "image", url: "data:image/png;base64,aGVsbG8=" },
        ],
      },
      { type: "tool_call", id: "call_1", name: "lookup", arguments: { id: 1 } },
      {
        type: "tool_result",
        toolCallId: "call_1",
        content: [{ type: "text", text: "found" }],
        isError: false,
      },
    ],
    tools: [{
      name: "lookup",
      description: "Look up an object.",
      inputSchema: { type: "object" },
      strict: true,
    }],
    toolChoice: "required",
    parallelToolCalls: false,
    generation: {
      maxOutputTokens: 256,
      temperature: 0,
      topP: 0,
      stop: ["END"],
    },
    reasoning: { effort: "high", enabled: true, budgetTokens: 1024 },
    responseFormat: {
      type: "json_schema",
      name: "answer",
      schema: { type: "object" },
    },
    stream: true,
    metadata: { user_id: "user-1" },
    user: "user-1",
  });
});

test("Anthropic output rejects malformed tool arguments instead of dropping them", () => {
  expect(() => anthropicOutputContent({
    content: [{ type: "tool_call", id: "call_1", name: "lookup", arguments: "not-json" }],
    finishReason: "tool_calls",
  })).toThrow(RouterFrameworkError);
});

test("OpenAI Chat round-trips hosted web_search tool calls", () => {
  const continuation: ProviderContinuationState = {
    kind: "openai_reasoning",
    source: { provider: "openai", api: "openai-responses", model: "gpt-5.4" },
    encryptedContent: "enc",
    providerItemId: "rs_1",
    hostedToolCallIds: ["ws_1"],
  };
  const request = openAIChatRequest({
    model: "my-router",
    messages: [{
      role: "assistant",
      content: null,
      reasoning_content: "thinking",
      reasoning_details: [{ type: "reasoning.encrypted", id: "rs_1", data: encodeProviderContinuationState(continuation) }],
      tool_calls: [{
        id: "ws_1",
        type: "function",
        function: {
          name: "web_search",
          arguments: JSON.stringify({ type: "web_search_call", id: "ws_1", status: "completed", query: "test" }),
        },
      }],
    }],
  });
  const hosted = request.items.find((item) => item.type === "hosted_tool_call");
  expect(hosted).toBeDefined();
  expect(hosted?.type).toBe("hosted_tool_call");
  if (hosted?.type === "hosted_tool_call") {
    expect(hosted.id).toBe("ws_1");
    expect(hosted.tool).toBe("web_search");
    expect(hosted.status).toBe("completed");
    expect(hosted.source?.provider).toBe("openai");
  }

  // Output serializer replays as a function tool call.
  const response = openAIChatResponse({
    id: "resp_1",
    model: "openai/gpt-5.4",
    requestedModel: "my-router",
    output: {
      content: [{
        type: "hosted_tool_call",
        id: "ws_1",
        tool: "web_search",
        providerType: "web_search_call",
        status: "completed",
        payload: { query: "test" },
      }],
      finishReason: "tool_calls",
    },
    selection: { decision: { selectedModel: "openai/gpt-5.4", reasoningEffort: "high", reason: "r" }, candidates: [], source: "policy" },
  });
  const message = (response.choices as Array<Record<string, unknown>>)[0]?.message as Record<string, unknown> | undefined;
  const calls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
  expect(calls).toBeDefined();
  const fn = calls?.[0]?.function as Record<string, unknown> | undefined;
  expect(fn?.name).toBe("web_search");
  const args = JSON.parse(fn?.arguments as string);
  expect(args.type).toBe("web_search_call");
  expect(args.id).toBe("ws_1");
  expect(args.status).toBe("completed");
});

test("OpenAI Chat Completions accepts and ignores stream_options", () => {
  const request = openAIChatRequest({
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    stream_options: { include_usage: true, some_future_option: "x" },
  });
  expect(request.stream).toBe(true);

  expect(() => openAIChatRequest({
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    stream_options: "usage",
  })).toThrow(/stream_options must be an object/);
});

test("Anthropic serialization rejects hosted tool calls instead of dropping them", () => {
  const serialize = () => anthropicOutputContent({
    content: [{
      type: "hosted_tool_call",
      id: "ws_1",
      tool: "web_search",
      providerType: "web_search_call",
      status: "completed",
      payload: { query: "test" },
    }],
    finishReason: "tool_calls",
  });
  expect(serialize).toThrow(RouterFrameworkError);
  try {
    serialize();
  } catch (error) {
    expect(error).toMatchObject({
      kind: "configuration",
      code: "hosted_tool_call_unrepresentable",
    });
    expect(String((error as Error).message)).toMatch(/OpenAI protocol/);
  }
});

test("OpenAI reasoning detail ids number emitted details identically in response and stream", () => {
  const continuation = (encryptedContent: string): ProviderContinuationState => ({
    kind: "openai_reasoning",
    source: { provider: "openai", api: "openai-responses", model: "openai/gpt-5.4" },
    encryptedContent,
  });
  const first = continuation("enc-1");
  const second = continuation("enc-2");
  const response = openAIChatResponse({
    id: "response-1",
    model: "openai/gpt-5.4",
    requestedModel: "my-router",
    output: {
      content: [
        { type: "reasoning", text: "readable only", source: first.source },
        { type: "reasoning", text: "a", source: first.source, continuation: first },
        { type: "reasoning", text: "b", source: second.source, continuation: second },
        { type: "text", text: "Answer." },
      ],
      finishReason: "stop",
    },
    selection: {
      decision: { selectedModel: "openai/gpt-5.4", reasoningEffort: "high", reason: "test" },
      candidates: [],
      source: "policy",
    },
  });
  const message = (response.choices as Array<Record<string, unknown>>)[0]!.message as Record<string, unknown>;
  const details = message.reasoning_details as Array<Record<string, unknown>>;
  expect(details.map((detail) => detail.id)).toEqual([
    "reasoning_0",
    "reasoning_1",
    "reasoning_2",
  ]);
  expect(String(details[0]!.data)).toStartWith("dari-ir-v1.");
  expect(String(details[1]!.data)).toStartWith("dari-pcs-v1.");

  const streamed = [
    openAIStreamDelta({ type: "reasoning_end", index: 0, source: first.source }, undefined, 0),
    openAIStreamDelta({ type: "reasoning_end", index: 0, continuation: first }, undefined, 1),
    openAIStreamDelta({ type: "reasoning_end", index: 0, continuation: second }, undefined, 2),
  ];
  expect(streamed.map((delta) =>
    (delta?.reasoning_details as Array<Record<string, unknown>>)[0]!.id,
  )).toEqual(["reasoning_0", "reasoning_1", "reasoning_2"]);
});

test("Anthropic non-string metadata.user_id is rejected like the OpenAI user field", () => {
  const reject = () => anthropicRequest({
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    metadata: { user_id: 42 },
  });
  expect(reject).toThrow(/metadata\.user_id must be a string/);
  try {
    reject();
  } catch (error) {
    expect(error).toMatchObject({ code: "invalid_request", param: "metadata.user_id" });
  }
});

test("malformed OpenAI image_url blames image_url, not the part type", () => {
  expect(() => openAIChatRequest({
    model: "my-router",
    messages: [{
      role: "user",
      content: [{ type: "image_url", image_url: "https://example.com/image.png" }],
    }],
  })).toThrow(/messages\.0\.content\.0\.image_url must be an object/);
});

test("OpenAI unsupported-shape errors carry the Anthropic adapter's specific codes", () => {
  const cases: Array<{ run: () => unknown; code: string }> = [
    {
      run: () => openAIChatRequest({
        model: "my-router",
        messages: [{ role: "user", content: [{ type: "input_audio" }] }],
      }),
      code: "unsupported_content_block",
    },
    {
      run: () => openAIChatRequest({
        model: "my-router",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "custom", custom: { name: "lookup" } }],
      }),
      code: "unsupported_tool",
    },
    {
      run: () => openAIChatRequest({
        model: "my-router",
        messages: [{ role: "user", content: "hello" }],
        response_format: { type: "grammar" },
      }),
      code: "unsupported_response_format",
    },
    {
      run: () => openAIChatRequest({
        model: "my-router",
        messages: [{
          role: "assistant",
          content: "Answer.",
          reasoning_details: [{ type: "reasoning.encrypted", id: "r", data: "raw-provider-blob" }],
        }],
      }),
      code: "invalid_provider_continuation_state",
    },
  ];
  for (const { run, code } of cases) {
    expect(run).toThrow(RouterFrameworkError);
    try {
      run();
    } catch (error) {
      expect(error).toMatchObject({ code });
    }
  }
});

test("OpenAI image detail accepts only auto, low, and high", () => {
  expect(() => openAIChatRequest({
    model: "my-router",
    messages: [{
      role: "user",
      content: [{
        type: "image_url",
        image_url: { url: "https://example.com/image.png", detail: "original" },
      }],
    }],
  })).toThrow(/messages\.0\.content\.0\.image_url\.detail must be 'auto', 'low', or 'high'/);
});

test("OpenAI rejects empty assistant messages with no tool calls", () => {
  const empty = () => openAIChatRequest({
    model: "my-router",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: null, tool_calls: [] },
    ],
  });
  expect(empty).toThrow(/messages\.1 is an empty assistant message with no tool calls/);
  try {
    empty();
  } catch (error) {
    expect(error).toMatchObject({ code: "invalid_request", param: "messages.1" });
  }

  expect(() => openAIChatRequest({
    model: "my-router",
    messages: [{ role: "assistant", content: null }],
  })).toThrow(/messages\.0 is an empty assistant message with no tool calls/);
});

test("OpenAI completion ids sanitize and truncate like Anthropic message ids", () => {
  const response = openAIChatResponse({
    id: "fallback",
    model: "openai/gpt-5.4",
    requestedModel: "my-router",
    output: {
      id: `resp:with spaces${"x".repeat(80)}`,
      content: [{ type: "text", text: "Answer." }],
      finishReason: "stop",
    },
    selection: {
      decision: { selectedModel: "openai/gpt-5.4", reasoningEffort: "high", reason: "test" },
      candidates: [],
      source: "policy",
    },
  });
  const id = response.id as string;
  expect(id).toStartWith("chatcmpl-resp_with_spaces");
  expect(id.length).toBe(64);
});

test("shared tool validation rejects duplicates and missing schemas per protocol", () => {
  expect(() => openAIChatRequest({
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      { type: "function", function: { name: "lookup" } },
      { type: "function", function: { name: "lookup" } },
    ],
  })).toThrow(/Duplicate tool 'lookup'/);

  const openAIWithoutSchema = openAIChatRequest({
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "lookup" } }],
  });
  expect(openAIWithoutSchema.tools).toEqual([{ name: "lookup", inputSchema: { type: "object" } }]);

  expect(() => anthropicRequest({
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    tools: [
      { name: "lookup", input_schema: { type: "object" } },
      { name: "lookup", input_schema: { type: "object" } },
    ],
  })).toThrow(/Duplicate tool 'lookup'/);

  expect(() => anthropicRequest({
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "lookup" }],
  })).toThrow(/tools\.0\.input_schema must be an object/);
});

test("stop sequence validation keeps per-protocol shapes", () => {
  const openAIStringStop = openAIChatRequest({
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stop: "END",
  });
  expect(openAIStringStop.generation.stop).toBe("END");

  expect(() => openAIChatRequest({
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stop: [1],
  })).toThrow(/stop must be a string or array of strings/);

  expect(() => anthropicRequest({
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    stop_sequences: "END",
  })).toThrow(/stop_sequences must be an array of strings/);
});

test("Anthropic output_config is validated once with unknown fields rejected", () => {
  expect(() => anthropicRequest({
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    output_config: { effort: "high", extra: true },
  })).toThrow(/output_config\.extra is not supported/);

  const request = anthropicRequest({
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: { type: "object" } },
    },
  });
  expect(request.reasoning).toEqual({ effort: "high", enabled: true });
  expect(request.responseFormat).toEqual({
    type: "json_schema",
    name: "response",
    schema: { type: "object" },
  });
});
