import { expect, test } from "bun:test";

import { conversationBlockCount } from "@mupt-ai/dari-router/policy-engine";

import type { InteractionRequest } from "../interaction/types.js";
import { anthropicMessagesToInteraction } from "../protocol/input/anthropic_messages.js";
import { chatCompletionsToInteraction } from "../protocol/input/chat_completions.js";
import { openAIResponsesToInteraction } from "../protocol/input/openai_responses.js";
import { selectorMessagesForInteraction } from "../strategies/selector_projection.js";
import { interactionLeaseFenceDepth } from "./interaction_lease_depth.js";

const CHAT = chatCompletionsToInteraction({
  model: "dari/routing",
  messages: [
    { role: "system", content: "Follow instructions." },
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect this." },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,aW1hZ2U=" },
        },
      ],
    },
    {
      role: "assistant",
      content: null,
      reasoning_content: "Use the tool.",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      }],
    },
    { role: "tool", tool_call_id: "call_1", content: "contents" },
    { role: "user", content: "Continue." },
  ],
});

const RESPONSES = openAIResponsesToInteraction({
  model: "dari/routing",
  input: [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Inspect this." },
        {
          type: "input_image",
          image_url: "data:image/png;base64,aW1hZ2U=",
        },
      ],
    },
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Use the tool." }],
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: "{}",
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: "contents",
    },
    { type: "message", role: "user", content: "Continue." },
  ],
});

const ANTHROPIC = anthropicMessagesToInteraction({
  model: "dari/routing",
  max_tokens: 512,
  system: "Follow instructions.",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Inspect this." },
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
        { type: "text", text: "Use the tool." },
        { type: "tool_use", id: "call_1", name: "read_file", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "contents" },
        { type: "text", text: "Continue." },
      ],
    },
  ],
});

test.each([
  ["Chat Completions", CHAT],
  ["OpenAI Responses", RESPONSES],
  ["Anthropic Messages", ANTHROPIC],
] as const)(
  "%s lease-fence depth matches the pre-migration selector projection",
  (_name, request) => {
    expect(interactionLeaseFenceDepth(request)).toBe(
      conversationBlockCount({
        messages: selectorMessagesForInteraction(request).messages,
      }),
    );
  },
);

test("canonical lease depth preserves reasoning and hosted-tool grouping", () => {
  const request: InteractionRequest = {
    sourceProtocol: "openai_responses",
    instructions: "Use available tools.",
    items: [
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Find it." }],
        contentShape: "parts",
      },
      { type: "reasoning", summary: ["Search."], content: [] },
      {
        type: "hosted_tool_call",
        id: "ws_1",
        tool: "web_search",
        providerType: "web_search_call",
        status: "completed",
        payload: { action: { type: "search", query: "Dari" } },
      },
      { type: "reasoning", summary: ["Summarize."], content: [] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Found it." }],
        contentShape: "parts",
      },
    ],
    tools: [],
    generation: {},
    stream: true,
  };

  expect(interactionLeaseFenceDepth(request)).toBe(
    conversationBlockCount({
      messages: selectorMessagesForInteraction(request).messages,
    }),
  );
});
