import { describe, expect, test } from "bun:test";
import type { RouterPrefixHit } from "@mupt-ai/dari-router/policy-engine";

import { leaseHistoryFromPrefixHits } from "./lease_history.js";

describe("production lease history", () => {
  test("reconstructs an in-progress lease from prefix countdown state", () => {
    const history = leaseHistoryFromPrefixHits({
      prefixHits: [
        hit({ message_depth: 10, lease_turns_remaining: 4, reason: "Action B clears the task." }),
        hit({ message_depth: 20, lease_turns_remaining: 3, reason: "Lease hold." }),
      ],
      conversationId: "conversation-1",
      candidates: [
        { model: "provider/hidden", reasoningEffort: "high" },
        { model: "provider/other", reasoningEffort: "low" },
      ],
      messages: [
        { role: "user", content: "Fix the parser." },
        {
          role: "assistant",
          content: null,
          reasoning_content: "Inspect the parser.",
          tool_calls: [{
            id: "read-1",
            type: "function",
            function: { name: "read", arguments: '{"path":"src/parser.ts"}' },
          }],
        },
        { role: "tool", tool_call_id: "read-1", content: "parser source" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "Run the focused test.",
          tool_calls: [{
            id: "bash-1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"bun test parser.test.ts"}' },
          }],
        },
        { role: "tool", tool_call_id: "bash-1", content: "1 passed" },
      ],
    });

    expect(history).toEqual([
      {
        candidate: { model: "provider/hidden", thinking_level: "high" },
        requested_turns: 5,
        completed_turns: 2,
        rationale: "Action B clears the task.",
        last_agent_thought: "Run the focused test.",
        last_tool_call: {
          name: "bash",
          arguments: { command: "bun test parser.test.ts" },
        },
        last_tool_result: "1 passed",
        tool_errors: null,
        files_changed: null,
        tests: {
          command: "bun test parser.test.ts",
          status: "unknown",
          result: "1 passed",
        },
      },
    ]);
  });
});

function hit(overrides: Partial<RouterPrefixHit>): RouterPrefixHit {
  return {
    hash: "a".repeat(64),
    conversation_id: "conversation-1",
    model: "provider/hidden",
    next_model: "provider/hidden",
    next_reasoning_effort: "high",
    message_depth: 1,
    prompt_tokens: 100,
    input_tokens: 100,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    tool_choice_fp: "tools",
    response_format_fp: "format",
    updated_at: "2026-08-23T00:00:00Z",
    reason: null,
    ...overrides,
  };
}
