import { expect, test } from "bun:test";

import type { ChatCompletionRequest } from "@mupt-ai/dari-router/policy-engine";
import { requiredCapabilitiesFor } from "../interaction/capabilities.js";
import { HttpError } from "../http/errors.js";
import { encodeProviderContinuationState } from "../interaction/provider_continuation_state.js";
import { chatCompletionsToInteraction } from "./input/chat_completions.js";

const CLAUDE = { provider: "anthropic", api: "anthropic-messages", model: "claude-sonnet-4-6" };

test("Chat ingress preserves request history and controls in the interaction representation", () => {
  const request: ChatCompletionRequest = {
    source_protocol: "openai_chat",
    model: "dari/routing",
    messages: [
      { role: "system", content: "Follow repository instructions." },
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this image." },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "high" } },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "{ \"path\": \"src/a.ts\" }" },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "read_file", arguments: { path: "src/b.ts" } },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "first" },
      { role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "second" }] },
      { role: "assistant" },
    ],
    stream: true,
    prompt_cache_key: "thread-1",
    temperature: 0.3,
    top_p: 0.8,
    max_completion_tokens: 321,
    stop: ["END"],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read one file.",
          parameters: { type: "object", properties: { path: { type: "string" } } },
          strict: true,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "read_file" } },
    response_format: {
      type: "json_schema",
      json_schema: { name: "result", schema: { type: "object" }, strict: true },
    },
    reasoning_effort: "high",
    metadata: { request_kind: "test" },
    user: "user-1",
  };

  const interaction = chatCompletionsToInteraction(request);
  expect(interaction).toMatchObject({
    sourceProtocol: "openai_chat",
    model: "dari/routing",
    stream: true,
    promptCacheKey: "thread-1",
    generation: {
      temperature: 0.3,
      topP: 0.8,
      maxOutputTokens: 321,
      stop: ["END"],
    },
    reasoning: { effort: "high" },
    responseFormat: {
      type: "json_schema",
      name: "result",
      schema: { type: "object" },
      strict: true,
    },
    metadata: { request_kind: "test" },
    user: "user-1",
    toolChoice: { kind: "function", name: "read_file" },
  });
  expect(interaction.items).toEqual([
    {
      type: "message",
      role: "system",
      content: [{ type: "text", text: "Follow repository instructions." }],
      contentShape: "string",
    },
    {
      type: "message",
      role: "user",
      content: [
        { type: "text", text: "Inspect this image." },
        { type: "image", url: "data:image/png;base64,aGVsbG8=", detail: "high" },
      ],
      contentShape: "parts",
    },
    {
      type: "message",
      role: "assistant",
      content: [],
      contentShape: "null",
    },
    {
      type: "tool_call",
      callId: "call_1",
      kind: "function",
      name: "read_file",
      input: "{ \"path\": \"src/a.ts\" }",
    },
    {
      type: "tool_call",
      callId: "call_2",
      kind: "function",
      name: "read_file",
      input: { path: "src/b.ts" },
    },
    {
      type: "tool_result",
      callId: "call_1",
      kind: "function",
      name: "read_file",
      output: [{ type: "text", text: "first" }],
      outputShape: "string",
    },
    {
      type: "tool_result",
      callId: "call_2",
      kind: "function",
      name: "read_file",
      output: [{ type: "text", text: "second" }],
      outputShape: "parts",
    },
    {
      type: "message",
      role: "assistant",
      content: [],
      contentShape: "absent",
    },
  ]);
  expect(interaction.tools).toEqual([{
    kind: "function",
    name: "read_file",
    description: "Read one file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    strict: true,
  }]);
  expect(requiredCapabilitiesFor(interaction)).toEqual([
    "image_input",
    "structured_output",
  ]);
});

test("restores JSON-encoded hosted search from Chat response replay", () => {
  const payload = {
    type: "web_search_call",
    id: "ws_json",
    status: "completed",
    action: { type: "search", query: "Dari release notes" },
  };
  const replayed = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [{
      role: "assistant",
      content: "Found them.",
      tool_calls: [{
        id: "ws_json",
        type: "function",
        function: { name: "web_search", arguments: JSON.stringify(payload) },
      }],
    }],
  });

  expect(replayed.items).toContainEqual({
    type: "hosted_tool_call",
    id: "ws_json",
    tool: "web_search",
    providerType: "web_search_call",
    status: "completed",
    payload,
  });
  expect(requiredCapabilitiesFor(replayed)).toContain("openai_hosted_web_search");
});

test("Chat ingress restores client-carried provider thinking state", () => {
  const data = encodeProviderContinuationState({
    kind: "anthropic_thinking",
    source: CLAUDE,
    thinking: "Use the tool.",
    signature: "native-signature",
  });
  const interaction = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [
      { role: "user", content: "Read the file." },
      {
        role: "assistant",
        content: null,
        reasoning_content: "Use the tool.",
        reasoning_details: [{ type: "reasoning.encrypted", id: "call_1", data }],
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "contents" },
    ],
  });

  expect(interaction.items).toMatchObject([
    { type: "message", role: "user" },
    {
      type: "reasoning",
      summary: ["Use the tool."],
      source: CLAUDE,
      continuation: {
        kind: "anthropic_thinking",
        source: CLAUDE,
        thinking: "Use the tool.",
        signature: "native-signature",
      },
    },
    { type: "message", role: "assistant" },
    { type: "tool_call", callId: "call_1" },
    { type: "tool_result", callId: "call_1" },
  ]);

});

test("Chat ingress rejects raw reasoning state without provider provenance", () => {
  expect(() =>
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [{
        role: "assistant",
        content: null,
        reasoning_details: [{
          type: "reasoning.encrypted",
          id: "reasoning_0",
          data: "provider-native-ciphertext",
        }],
      }],
    })
  ).toThrow("must be a Dari provider continuation envelope");
});

test("Chat validation remains at the protocol boundary", () => {
  expect(() =>
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
    })
  ).toThrow("use a base64 data URL");

  expect(() =>
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [{
        role: "user",
        content: [{
          type: "image_url",
          image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "ultra" },
        }],
      }],
    })
  ).toThrow("image_url.detail is not supported");
});

test("rejects Chat tool fields on incompatible message roles", () => {
  expect(() =>
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [{
        role: "user",
        content: "Run the tool.",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      }],
    })
  ).toThrow("tool_calls is only supported for assistant messages");

  expect(() =>
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [{ role: "assistant", content: "Done.", tool_call_id: "call_1" }],
    })
  ).toThrow("tool_call_id is only supported for tool messages");

  expect(() =>
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [{ role: "tool", content: "result" }],
    })
  ).toThrow("tool_call_id is required for tool messages");

  expect(() =>
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [
        { role: "tool", tool_call_id: "c".repeat(513), content: "result" },
      ],
    })
  ).toThrow("must not exceed 512 characters");

  expect(() =>
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c".repeat(513),
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
      ],
    })
  ).toThrow("no longer than 512 characters");
});

test("rejects tool messages without a preceding assistant tool call", () => {
  let caught: unknown;
  try {
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [
        { role: "assistant", content: "No tool call here." },
        { role: "tool", tool_call_id: "synthetic-0", content: "result" },
      ],
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HttpError);
  expect(caught).toMatchObject({
    status: 400,
    code: "invalid_request_error",
    param: "messages.1.tool_call_id",
    message: "messages[1].tool_call_id does not match any tool_call.id in the preceding assistant tool-call exchange.",
  });

  expect(() =>
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "contents" },
      ],
    })
  ).not.toThrow();

  expect(() =>
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_old", type: "function", function: { name: "read_file", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_old", content: "contents" },
        { role: "assistant", content: "Done." },
        { role: "tool", tool_call_id: "call_old", content: "replayed" },
      ],
    })
  ).toThrow(
    "tool_call_id does not match any tool_call.id in the preceding assistant tool-call exchange",
  );
});

test("Chat ingress flattens tool_reference blocks in tool-result content", () => {
  const interaction = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [
      { role: "user", content: "Find the right tool." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "search_tools", arguments: "{}" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [
          { type: "text", text: "Matched 2 tools." },
          { type: "tool_reference", tool_name: "repo_alpha" },
          { type: "tool_reference", tool_name: "repo_beta" },
        ],
      },
    ],
  });

  const toolResult = interaction.items.at(-1);
  expect(toolResult).toMatchObject({
    type: "tool_result",
    callId: "call_1",
    output: [
      { type: "text", text: "Matched 2 tools." },
      { type: "text", text: "Referenced tool: repo_alpha" },
      { type: "text", text: "Referenced tool: repo_beta" },
    ],
  });

});

test("rejects malformed and misplaced Chat tool_reference blocks", () => {
  for (const toolName of [undefined, "", 42, null]) {
    expect(() =>
      chatCompletionsToInteraction({
        model: "dari/routing",
        messages: [{
          role: "tool",
          tool_call_id: "call_1",
          content: [{ type: "tool_reference", ...(toolName === undefined ? {} : { tool_name: toolName }) }],
        }],
      })
    ).toThrow("tool_name must be a non-empty string");
  }

  expect(() =>
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [{
        role: "user",
        content: [{ type: "tool_reference", tool_name: "repo_alpha" }],
      }],
    })
  ).toThrow("tool_reference blocks are only supported on tool messages");
});

test("rejects non-boolean Chat function strict mode", () => {
  expect(() =>
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [{ role: "user", content: "Run the tool." }],
      tools: [{
        type: "function",
        function: { name: "read_file", strict: "true" },
      }],
    })
  ).toThrow("function.strict must be a boolean");
});
