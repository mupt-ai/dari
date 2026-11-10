import { expect, test } from "bun:test";

import { encodeProviderContinuationState } from "../interaction/provider_continuation_state.js";
import { anthropicMessagesToInteraction } from "../protocol/input/anthropic_messages.js";
import { chatCompletionsToInteraction } from "../protocol/input/chat_completions.js";
import type { InteractionRequest, ProviderIdentity } from "../interaction/types.js";
import { selectorMessagesForInteraction } from "./selector_projection.js";

const OPENAI: ProviderIdentity = {
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.5",
};
const CLAUDE: ProviderIdentity = {
  provider: "anthropic",
  api: "anthropic-messages",
  model: "claude-sonnet-4-6",
};

function interaction(
  overrides: Partial<InteractionRequest> = {},
): InteractionRequest {
  return {
    sourceProtocol: "openai_responses",
    items: [],
    tools: [],
    generation: {},
    stream: false,
    ...overrides,
  };
}

test("projects readable ordered history without provider state or image bytes", () => {
  const { messages } = selectorMessagesForInteraction(
    interaction({
      instructions: "Follow repository instructions.",
      items: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "text", text: "Inspect this screenshot." },
            {
              type: "image",
              url: "data:image/png;base64,SECRET_IMAGE_BYTES",
              detail: "high",
            },
          ],
          contentShape: "parts",
        },
        {
          type: "reasoning",
          summary: ["Need the file contents."],
          content: [],
          continuation: {
            kind: "openai_reasoning",
            source: OPENAI,
            encryptedContent: "SECRET_CONTINUATION_STATE",
          },
        },
        {
          type: "tool_call",
          id: "fc_provider_1",
          callId: "call_1",
          kind: "function",
          namespace: "filesystem",
          name: "read_file",
          input: { path: "README.md" },
        },
        {
          type: "tool_result",
          callId: "call_1",
          kind: "function",
          name: "read_file",
          output: [
            { type: "text", text: "README contents" },
            { type: "image", url: "data:image/png;base64,RESULT_IMAGE_BYTES" },
          ],
          outputShape: "parts",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "The README is concise." }],
          contentShape: "parts",
          phase: "final_answer",
          source: OPENAI,
        },
      ],
    }),
  );

  expect(messages).toEqual([
    { role: "system", content: "Follow repository instructions." },
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect this screenshot." },
        {
          type: "image_url",
          image_url: { url: "<image omitted>", detail: "high" },
        },
      ],
    },
    {
      role: "assistant",
      content: null,
      reasoning_content: "Need the file contents.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "filesystem__read_file",
            arguments: { path: "README.md" },
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: [
        { type: "text", text: "README contents" },
        {
          type: "image_url",
          image_url: { url: "<image omitted>" },
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "The README is concise." }] },
  ]);

  const serialized = JSON.stringify(messages);
  expect(serialized).not.toContain("SECRET_IMAGE_BYTES");
  expect(serialized).not.toContain("RESULT_IMAGE_BYTES");
  expect(serialized).not.toContain("SECRET_CONTINUATION_STATE");
  expect(serialized).not.toContain("fc_provider_1");
  expect(serialized).not.toContain("final_answer");
});

test("marks unreadable reasoning while preserving custom and hosted tool history", () => {
  const { messages } = selectorMessagesForInteraction(
    interaction({
      items: [
        {
          type: "reasoning",
          summary: [],
          content: [],
          continuation: {
            kind: "openai_reasoning",
            source: OPENAI,
            encryptedContent: "opaque",
          },
        },
        {
          type: "tool_call",
          callId: "custom_1",
          kind: "custom",
          name: "apply_patch",
          input: "*** Begin Patch",
        },
        {
          type: "hosted_tool_call",
          id: "ws_1",
          tool: "web_search",
          providerType: "web_search_call",
          status: "completed",
          payload: { type: "web_search_call", status: "completed" },
          source: OPENAI,
        },
      ],
    }),
  );

  expect(messages).toEqual([
    {
      role: "assistant",
      content: null,
      reasoning_content: "<opaque reasoning omitted>",
      tool_calls: [
        {
          id: "custom_1",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({ input: "*** Begin Patch" }),
          },
        },
        {
          id: "ws_1",
          type: "function",
          function: {
            name: "web_search",
            arguments: { type: "web_search_call", status: "completed" },
          },
        },
      ],
    },
  ]);
});

test("coalesces a Codex tool call persisted before its terminal reasoning", () => {
  const { messages } = selectorMessagesForInteraction(
    interaction({
      items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "text", text: "Inspect the repository." }],
          contentShape: "parts",
        },
        {
          type: "tool_call",
          id: "fc_1",
          callId: "call_1",
          kind: "function",
          name: "read_file",
          input: { path: "README.md" },
        },
        {
          type: "reasoning",
          summary: ["Need the README contents."],
          content: [],
          continuation: {
            kind: "openai_reasoning",
            source: OPENAI,
            encryptedContent: "SECRET_CONTINUATION_STATE",
          },
        },
        {
          type: "tool_result",
          callId: "call_1",
          kind: "function",
          name: "read_file",
          output: [{ type: "text", text: "README contents" }],
          outputShape: "parts",
        },
      ],
    }),
  );

  expect(messages).toEqual([
    { role: "user", content: [{ type: "text", text: "Inspect the repository." }] },
    {
      role: "assistant",
      content: null,
      reasoning_content: "Need the README contents.",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: {
          name: "read_file",
          arguments: { path: "README.md" },
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: [{ type: "text", text: "README contents" }],
    },
  ]);
  expect(JSON.stringify(messages)).not.toContain("SECRET_CONTINUATION_STATE");
});

test("opaque reasoning preserves boundaries between provider output groups", () => {
  const opaqueReasoning = {
    type: "reasoning" as const,
    summary: [],
    content: [],
    continuation: {
      kind: "openai_reasoning" as const,
      source: OPENAI,
      encryptedContent: "opaque",
    },
  };
  const { messages } = selectorMessagesForInteraction(
    interaction({
      items: [
        {
          type: "hosted_tool_call",
          id: "ws_leading",
          tool: "web_search",
          providerType: "web_search_call",
          payload: { type: "web_search_call", status: "completed" },
        },
        opaqueReasoning,
        {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Still searching." }],
          contentShape: "parts",
        },
        {
          type: "hosted_tool_call",
          id: "ws_middle",
          tool: "web_search",
          providerType: "web_search_call",
          payload: { type: "web_search_call", status: "completed" },
        },
        opaqueReasoning,
        {
          type: "hosted_tool_call",
          id: "ws_trailing",
          tool: "web_search",
          providerType: "web_search_call",
          payload: { type: "web_search_call", status: "completed" },
        },
      ],
    }),
  );

  expect(messages).toHaveLength(3);
  expect(messages[1]).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "Still searching." }],
    reasoning_content: "<opaque reasoning omitted>",
    tool_calls: [expect.objectContaining({ id: "ws_middle" })],
  });
  expect(messages[2]).toMatchObject({
    role: "assistant",
    reasoning_content: "<opaque reasoning omitted>",
    tool_calls: [expect.objectContaining({ id: "ws_trailing" })],
  });
});

test("projects Chat tool exchanges after protocol validation", () => {
  const { messages } = selectorMessagesForInteraction(
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [
        { role: "system", content: "Follow repository instructions." },
        { role: "user", content: "Find the matching tool." },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "search_tools",
              arguments: JSON.stringify({ query: "repository" }),
            },
          }],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [
            { type: "text", text: "Matched one tool." },
            { type: "tool_reference", tool_name: "repo_alpha" },
          ],
        },
      ],
    }),
  );

  expect(messages).toEqual([
    { role: "system", content: "Follow repository instructions." },
    { role: "user", content: "Find the matching tool." },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: {
          name: "search_tools",
          arguments: JSON.stringify({ query: "repository" }),
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: [
        { type: "text", text: "Matched one tool." },
        { type: "text", text: "Referenced tool: repo_alpha" },
      ],
    },
  ]);
});

test("projects Anthropic thinking and mixed content without its signature", () => {
  const signature = encodeProviderContinuationState({
    kind: "anthropic_thinking",
    source: CLAUDE,
    thinking: "Need the README.",
    signature: "SECRET_ANTHROPIC_SIGNATURE",
  });
  const { messages } = selectorMessagesForInteraction(
    anthropicMessagesToInteraction({
      model: "dari/routing",
      max_tokens: 4096,
      system: "Follow repository instructions.",
      messages: [
        { role: "user", content: "Inspect the repository." },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Need the README.",
              signature,
            },
            { type: "text", text: "I will inspect it." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "read_file",
              input: { path: "README.md" },
            },
          ],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "README contents",
          }],
        },
      ],
    }),
  );

  expect(messages).toEqual([
    { role: "system", content: "Follow repository instructions." },
    { role: "user", content: "Inspect the repository." },
    {
      role: "assistant",
      content: [{ type: "text", text: "I will inspect it." }],
      reasoning_content: "Need the README.",
      tool_calls: [{
        id: "toolu_1",
        type: "function",
        function: {
          name: "read_file",
          arguments: { path: "README.md" },
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: "toolu_1",
      content: "README contents",
    },
  ]);
  expect(JSON.stringify(messages)).not.toContain("SECRET_ANTHROPIC_SIGNATURE");
});

test("numbers images and returns their bytes only when image input is requested", () => {
  const request = interaction({
    items: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "text", text: "Transcribe these pages." },
          { type: "image", url: "data:image/png;base64,PAGE_ONE", detail: "high" },
          { type: "image", url: "data:image/png;base64,PAGE_TWO" },
        ],
        contentShape: "parts",
      },
      {
        type: "tool_result",
        callId: "call_1",
        kind: "function",
        name: "read",
        output: [{ type: "image", url: "data:image/png;base64,CROP" }],
        outputShape: "parts",
      },
    ],
  });

  const withImages = selectorMessagesForInteraction(request, { imageInput: true });
  expect(withImages.images).toEqual([
    { index: 1, url: "data:image/png;base64,PAGE_ONE" },
    { index: 2, url: "data:image/png;base64,PAGE_TWO" },
    { index: 3, url: "data:image/png;base64,CROP" },
  ]);
  expect(withImages.messages).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "Transcribe these pages." },
        { type: "image_url", image_url: { url: "<image 1>", detail: "high" } },
        { type: "image_url", image_url: { url: "<image 2>" } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: [{ type: "image_url", image_url: { url: "<image 3>" } }],
    },
  ]);
  expect(JSON.stringify(withImages.messages)).not.toContain("PAGE_ONE");

  const withoutImages = selectorMessagesForInteraction(request);
  expect(withoutImages.images).toEqual([]);
  expect(JSON.stringify(withoutImages.messages)).not.toContain("<image 1>");
  expect(JSON.stringify(withoutImages.messages)).toContain("<image omitted>");
});
