import { expect, test } from "bun:test";

import { decodeUntrustedProviderContinuationState } from "../../interaction/provider_continuation_state.js";
import type { InteractionOutput, InteractionRequest, ProviderIdentity } from "../../interaction/types.js";
import { anthropicMessagesResponse } from "./anthropic_messages.js";
import { anthropicRouting } from "./anthropic_messages_output.js";

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
  stream: false,
};

test("serializes canonical output as Anthropic Messages with client-carried thinking state", () => {
  const response = anthropicMessagesResponse({
    id: "request_123",
    model: "anthropic/claude-sonnet-4-6",
    request: REQUEST,
    routing: {
      selectedModel: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "high",
      reason: "selected",
    },
    conversationId: "conversation_123",
    output: output({
      stopReason: "tool_use",
      items: [
        {
          type: "reasoning",
          summary: ["Inspect first."],
          content: [],
          source: CLAUDE,
          continuation: {
            kind: "anthropic_thinking",
            source: CLAUDE,
            thinking: "Inspect first.",
            signature: "native-signature",
          },
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "I will read it." }],
          contentShape: "parts",
          source: CLAUDE,
        },
        {
          type: "tool_call",
          callId: "toolu_read",
          kind: "function",
          name: "read_file",
          input: { path: "README.md" },
        },
      ],
    }),
  });

  expect(response).toMatchObject({
    id: "msg_request_123",
    type: "message",
    role: "assistant",
    model: "anthropic/claude-sonnet-4-6",
    stop_reason: "tool_use",
    content: [
      { type: "thinking", thinking: "Inspect first." },
      { type: "text", text: "I will read it." },
      { type: "tool_use", id: "toolu_read", name: "read_file", input: { path: "README.md" } },
    ],
    dari_routing: {
      selected_model: "anthropic/claude-sonnet-4-6",
      request_id: "request_123",
      conversation_id: "conversation_123",
    },
  });
  const content = response.content as Array<Record<string, unknown>>;
  expect(decodeUntrustedProviderContinuationState(String(content[0].signature))).toEqual({
    kind: "anthropic_thinking",
    source: CLAUDE,
    thinking: "Inspect first.",
    signature: "native-signature",
  });
});

test("omits lease turns remaining from dari_routing when the decision has no lease", () => {
  expect(anthropicRouting({
    selectedModel: "anthropic/claude-sonnet-4-6",
    reasoningEffort: "high",
    reason: "selected",
  }, "req_1")).not.toHaveProperty("lease_turns_remaining");
});

test("includes lease turns remaining in dari_routing when the decision holds a lease", () => {
  expect(anthropicRouting({
    selectedModel: "anthropic/claude-sonnet-4-6",
    reasoningEffort: "high",
    reason: "Lease hold: 1 committed turns remaining.",
    leaseTurnsRemaining: 1,
  }, "req_1")).toMatchObject({ lease_turns_remaining: 1, request_id: "req_1" });
});

function output(overrides: Partial<InteractionOutput>): InteractionOutput {
  return {
    createdAtMs: 1_700_000_000_000,
    source: CLAUDE,
    items: [],
    usage: {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 17,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    ...overrides,
  };
}
