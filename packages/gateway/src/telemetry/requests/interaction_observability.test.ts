import { describe, expect, test } from "bun:test";

import { encodeProviderContinuationState } from "../../interaction/provider_continuation_state.js";
import type {
  InteractionRequest,
  ProviderIdentity,
} from "../../interaction/types.js";
import { anthropicMessagesToInteraction } from "../../protocol/input/anthropic_messages.js";
import { chatCompletionsToInteraction } from "../../protocol/input/chat_completions.js";
import { openAIResponsesToInteraction } from "../../protocol/input/openai_responses.js";
import { extractInteractionObservability } from "./interaction_observability.js";

const OPENAI: ProviderIdentity = {
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.5",
};

const ANTHROPIC: ProviderIdentity = {
  provider: "anthropic",
  api: "anthropic-messages",
  model: "claude-sonnet-4-6",
};

test("extracts one bounded content-free schema from the interaction", () => {
  const request: InteractionRequest = {
    sourceProtocol: "openai_responses",
    instructions: "secret-instructions",
    items: [
      {
        type: "message",
        id: "secret-message-id",
        role: "user",
        content: [
          { type: "text", text: "secret-user-text" },
          {
            type: "image",
            url: "data:image/png;base64,c2VjcmV0LWltYWdl",
          },
        ],
        contentShape: "parts",
      },
      {
        type: "reasoning",
        id: "secret-reasoning-id",
        summary: ["secret-summary"],
        content: ["secret-reasoning"],
        continuation: {
          kind: "openai_reasoning",
          source: OPENAI,
          encryptedContent: "secret-encrypted-content",
        },
      },
      {
        type: "reasoning",
        summary: [],
        content: [],
        continuation: {
          kind: "anthropic_redacted_thinking",
          source: ANTHROPIC,
          data: "secret-redacted-thinking",
        },
      },
      {
        type: "tool_call",
        callId: "secret-function-call-id",
        kind: "function",
        name: "secret-function-name",
        input: { private: "secret-function-argument" },
      },
      {
        type: "tool_call",
        callId: "secret-custom-call-id",
        kind: "custom",
        name: "secret-custom-name",
        input: "secret-custom-argument",
      },
      {
        type: "tool_result",
        callId: "secret-custom-call-id",
        kind: "custom",
        output: "secret-tool-result",
        outputShape: "string",
      },
      {
        type: "hosted_tool_call",
        id: "secret-hosted-id",
        tool: "web_search",
        providerType: "web_search_call",
        payload: { query: "secret-search-query" },
      },
    ],
    tools: [
      {
        kind: "function",
        name: "secret-function-name",
        parameters: { description: "secret-tool-schema" },
      },
      {
        kind: "custom",
        name: "secret-custom-name",
        format: { grammar: "secret-grammar" },
      },
      {
        kind: "hosted",
        type: "web_search",
        config: { private: "secret-hosted-config" },
      },
    ],
    toolChoice: {
      kind: "function",
      name: "secret-function-name",
    },
    parallelToolCalls: true,
    generation: {
      temperature: 0.7,
      stop: "secret-stop-sequence",
    },
    reasoning: { effort: "high", enabled: true },
    responseFormat: {
      type: "json_schema",
      name: "secret-format-name",
      schema: { description: "secret-response-schema" },
    },
    promptCacheKey: "secret-prompt-cache-key",
    stream: true,
    metadata: { private: "secret-client-metadata" },
    user: "secret-user-id",
  };

  const observability = extractInteractionObservability(request);
  const { metadata } = observability;
  expect(observability.messageCount).toBe(1);
  expect(observability.hasTools).toBe(true);
  expect(observability.requestKind).toBe("other");
  expect(metadata).toEqual({
    schema_version: 1,
    item_counts: {
      total: 7,
      message: 1,
      reasoning: 2,
      tool_call: 2,
      tool_result: 1,
      hosted_tool_call: 1,
      hosted_tool_result: 0,
    },
    message_role_counts: {
      system: 0,
      developer: 0,
      user: 1,
      assistant: 0,
    },
    tool_call_counts: {
      function: 1,
      custom: 1,
      hosted: 1,
    },
    declared_tool_counts: {
      total: 3,
      function: 1,
      custom: 1,
      hosted: 1,
    },
    item_content_modality_counts: {
      text: 2,
      image: 1,
    },
    continuation_state_counts: {
      total: 2,
      openai_reasoning: 1,
      anthropic_thinking: 0,
      anthropic_redacted_thinking: 1,
    },
    instructions_present: true,
    reasoning_history_present: true,
    prompt_cache_key_present: true,
    user_present: true,
    controls: {
      reasoning_effort: "high",
      reasoning_enabled: true,
      response_format: "json_schema",
      tool_choice: "function",
      parallel_tool_calls: true,
    },
  });

  const encoded = JSON.stringify(metadata);
  for (const forbidden of [
    "secret",
    "function-name",
    "custom-name",
    "prompt-cache-key",
    "user-id",
    "message-id",
  ]) {
    expect(encoded).not.toContain(forbidden);
  }
});

describe.each([
  "openai_chat",
  "openai_responses",
  "anthropic_messages",
] as const)("request-kind semantics for %s", (sourceProtocol) => {
  const request = (items: InteractionRequest["items"]): InteractionRequest => ({
    sourceProtocol,
    items,
    tools: [],
    generation: {},
    stream: false,
  });
  const user = {
    type: "message" as const,
    role: "user" as const,
    content: [{ type: "text" as const, text: "new question" }],
    contentShape: "string" as const,
  };
  const result = {
    type: "tool_result" as const,
    callId: "call_1",
    kind: "function" as const,
    output: "done",
    outputShape: "string" as const,
  };
  const call = {
    type: "tool_call" as const,
    callId: "call_1",
    kind: "function" as const,
    name: "inspect",
    input: {},
  };

  test("a trailing tool result is a continuation", () => {
    expect(
      extractInteractionObservability(request([user, call, result])).requestKind,
    ).toBe(
      "tool_continuation",
    );
  });

  test("unresolved assistant tool calls are not user turns", () => {
    expect(
      extractInteractionObservability(request([user, call])).requestKind,
    ).toBe("other");
  });

  test("user text wins over an adjacent tool result in either order", () => {
    expect(extractInteractionObservability(request([user, result])).requestKind).toBe(
      "user_message",
    );
    expect(extractInteractionObservability(request([result, user])).requestKind).toBe(
      "user_message",
    );
  });

  test("trailing system metadata does not hide the latest user turn", () => {
    expect(
      extractInteractionObservability(
        request([
          user,
          {
            type: "message",
            role: "system",
            content: [{ type: "text", text: "late system metadata" }],
            contentShape: "string",
          },
        ]),
      ).requestKind,
    ).toBe("user_message");
  });
});

test("classifies canonical auxiliary title requests as other", () => {
  const request: InteractionRequest = {
    sourceProtocol: "anthropic_messages",
    agentContext: { requestClass: "auxiliary" },
    items: [{
      type: "message",
      role: "user",
      content: [{ type: "text", text: "title source text" }],
      contentShape: "string",
    }],
    tools: [],
    generation: {},
    stream: true,
  };

  expect(extractInteractionObservability(request).requestKind).toBe("other");
});

test("honors a validated harness tool-continuation purpose", () => {
  const request: InteractionRequest = {
    sourceProtocol: "anthropic_messages",
    requestPurpose: "tool_continuation",
    items: [{
      type: "message",
      role: "user",
      content: [{ type: "text", text: "Injected tool-result reminder" }],
      contentShape: "parts",
    }],
    tools: [],
    generation: {},
    stream: true,
  };

  expect(extractInteractionObservability(request).requestKind).toBe(
    "tool_continuation",
  );
});

test("extracts Chat Completions facts after ingress", () => {
  const request = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: "checking",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "lookup",
              arguments: "{\"id\":1}",
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "result",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: { type: "object" },
        },
      },
    ],
    tool_choice: "auto",
    prompt_cache_key: "chat-thread",
    stream: true,
  });

  const observability = extractInteractionObservability(request);
  expect(observability.metadata).toMatchObject({
    item_counts: {
      total: 5,
      message: 3,
      reasoning: 0,
      tool_call: 1,
      tool_result: 1,
      hosted_tool_call: 0,
      hosted_tool_result: 0,
    },
    message_role_counts: {
      system: 1,
      developer: 0,
      user: 1,
      assistant: 1,
    },
    declared_tool_counts: {
      total: 1,
      function: 1,
      custom: 0,
      hosted: 0,
    },
    item_content_modality_counts: { text: 4, image: 0 },
    instructions_present: true,
    prompt_cache_key_present: true,
    controls: { tool_choice: "auto" },
  });
  expect(observability.messageCount).toBe(3);
  expect(observability.hasTools).toBe(true);
  expect(observability.requestKind).toBe("tool_continuation");
});

test("extracts Responses facts after ingress", () => {
  const request = openAIResponsesToInteraction({
    model: "dari/routing",
    instructions: "instructions",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "question" }],
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "summary" }],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "result",
      },
      {
        type: "custom_tool_call",
        call_id: "call_2",
        name: "patch",
        input: "patch",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_2",
        name: "patch",
        output: "done",
      },
    ],
    tools: [
      {
        type: "function",
        name: "lookup",
        parameters: { type: "object" },
      },
      {
        type: "custom",
        name: "patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
    ],
    reasoning: { effort: "medium" },
    text: { format: { type: "json_object" } },
    parallel_tool_calls: false,
    prompt_cache_key: "responses-thread",
    stream: true,
  });

  const observability = extractInteractionObservability(request);
  expect(observability.metadata).toMatchObject({
    item_counts: {
      total: 6,
      message: 1,
      reasoning: 1,
      tool_call: 2,
      tool_result: 2,
      hosted_tool_call: 0,
      hosted_tool_result: 0,
    },
    tool_call_counts: {
      function: 1,
      custom: 1,
      hosted: 0,
    },
    declared_tool_counts: {
      total: 2,
      function: 1,
      custom: 1,
      hosted: 0,
    },
    item_content_modality_counts: { text: 3, image: 0 },
    instructions_present: true,
    reasoning_history_present: true,
    prompt_cache_key_present: true,
    controls: {
      reasoning_effort: "medium",
      response_format: "json_object",
      parallel_tool_calls: false,
    },
  });
  expect(observability.messageCount).toBe(1);
  expect(observability.hasTools).toBe(true);
  expect(observability.requestKind).toBe("tool_continuation");
});

test("extracts Anthropic Messages facts after ingress", () => {
  const signature = encodeProviderContinuationState({
    kind: "anthropic_thinking",
    source: ANTHROPIC,
    thinking: "thinking",
    signature: "native-signature",
  });
  const request = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 2048,
    stream: true,
    system: "system",
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tools: [
      {
        name: "inspect",
        input_schema: { type: "object" },
      },
    ],
    tool_choice: {
      type: "auto",
      disable_parallel_tool_use: true,
    },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "question" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aW1hZ2U=",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "thinking",
            signature,
          },
          { type: "text", text: "checking" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "inspect",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "result",
          },
        ],
      },
    ],
  });

  const observability = extractInteractionObservability(request);
  expect(observability.metadata).toMatchObject({
    item_counts: {
      total: 5,
      message: 2,
      reasoning: 1,
      tool_call: 1,
      tool_result: 1,
      hosted_tool_call: 0,
      hosted_tool_result: 0,
    },
    message_role_counts: {
      system: 0,
      developer: 0,
      user: 1,
      assistant: 1,
    },
    item_content_modality_counts: { text: 3, image: 1 },
    continuation_state_counts: {
      total: 1,
      openai_reasoning: 0,
      anthropic_thinking: 1,
      anthropic_redacted_thinking: 0,
    },
    declared_tool_counts: {
      total: 1,
      function: 1,
      custom: 0,
      hosted: 0,
    },
    instructions_present: true,
    controls: {
      reasoning_effort: "high",
      reasoning_enabled: true,
      tool_choice: "auto",
      parallel_tool_calls: false,
    },
  });
  expect(observability.messageCount).toBe(2);
  expect(observability.hasTools).toBe(true);
  expect(observability.requestKind).toBe("tool_continuation");
});

test("normalizes Anthropic server tools without treating references as modalities", () => {
  const request = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 512,
    tools: [
      {
        type: "tool_search_tool_regex_20251119",
        name: "tool_search_tool_regex",
      },
    ],
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_1",
            name: "tool_search_tool_regex",
            input: { query: "private query" },
          },
          {
            type: "tool_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: [
              { type: "tool_reference", tool_name: "private_tool_name" },
            ],
          },
        ],
      },
    ],
  });

  const observability = extractInteractionObservability(request);
  expect(observability.metadata).toMatchObject({
    item_counts: {
      total: 2,
      message: 0,
      reasoning: 0,
      tool_call: 0,
      tool_result: 0,
      hosted_tool_call: 1,
      hosted_tool_result: 1,
    },
    tool_call_counts: {
      function: 0,
      custom: 0,
      hosted: 1,
    },
    declared_tool_counts: {
      total: 1,
      function: 0,
      custom: 0,
      hosted: 1,
    },
    item_content_modality_counts: { text: 0, image: 0 },
  });
  expect(observability.hasTools).toBe(true);
  expect(JSON.stringify(observability.metadata)).not.toContain("private");
});

test.each([
  {
    content: [
      { type: "text", text: "also explain the result" },
      { type: "tool_result", tool_use_id: "toolu_1", content: "result" },
    ],
  },
  {
    content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "result" },
      { type: "text", text: "also explain the result" },
    ],
  },
])(
  "classifies mixed Anthropic user text and tool results as a user turn",
  ({ content }) => {
    const request = anthropicMessagesToInteraction({
      model: "dari/routing",
      max_tokens: 512,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "inspect",
              input: {},
            },
          ],
        },
        { role: "user", content },
      ],
    });

    expect(extractInteractionObservability(request).requestKind).toBe(
      "user_message",
    );
  },
);

test.each([
  {
    content: [
      { type: "text", text: "" },
      { type: "tool_result", tool_use_id: "toolu_1", content: "result" },
    ],
  },
  {
    content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "result" },
      { type: "text", text: "   " },
    ],
  },
])(
  "classifies empty Anthropic user text beside a tool result as a continuation",
  ({ content }) => {
    const request = anthropicMessagesToInteraction({
      model: "dari/routing",
      max_tokens: 512,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "inspect",
              input: {},
            },
          ],
        },
        { role: "user", content },
      ],
    });

    expect(extractInteractionObservability(request).requestKind).toBe(
      "tool_continuation",
    );
  },
);

test("treats top-level and message-form instructions consistently", () => {
  const chat = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [
      { role: "developer", content: "Follow repository policy." },
      { role: "user", content: "Continue." },
    ],
  });
  const responses = openAIResponsesToInteraction({
    model: "dari/routing",
    input: [
      {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "Follow repository policy." }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue." }],
      },
    ],
  });
  const anthropic = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 512,
    system: "Follow repository policy.",
    messages: [{ role: "user", content: "Continue." }],
  });

  for (const request of [chat, responses, anthropic]) {
    expect(
      extractInteractionObservability(request).metadata.instructions_present,
    ).toBe(true);
  }
});
