import { expect, test } from "bun:test";

import type {
  InteractionOutput,
  InteractionRequest,
  ProviderIdentity,
} from "../interaction/types.js";
import { buildCompletedPrefixHit } from "./prefix_state.js";

test("divergent replies to the same opening prompt keep distinct identity hashes", () => {
  const source: ProviderIdentity = {
    provider: "openai",
    api: "openai-responses",
    model: "gpt-4.1-mini",
  };
  const request: InteractionRequest = {
    sourceProtocol: "openai_chat",
    items: [{
      type: "message",
      role: "user",
      content: [{ type: "text", text: "Fix the tests." }],
      contentShape: "string",
    }],
    tools: [],
    generation: {},
    stream: false,
  };
  const output = (text: string): InteractionOutput => ({
    createdAtMs: 1,
    source,
    items: [{
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      contentShape: "string",
      source,
    }],
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
  });
  const hit = (text: string) =>
    buildCompletedPrefixHit({
      request,
      output: output(text),
      model: "openai/gpt-4.1-mini",
      nextModel: null,
      nextReasoningEffort: null,
      reasoningBucket: null,
      leaseTurnsRemaining: null,
      reason: null,
      chain: ["input-hash"],
      looseChain: ["loose-input-hash"],
      target: source,
      conversationId: "conversation",
      leaseDepth: 1,
      providerBlockDepth: 1,
      fingerprints: {
        tool_choice_fp: "tool-choice",
        response_format_fp: "response-format",
      },
      usage: output(text).usage,
      benchmarkReplayDepth: 0,
    });

  const first = hit("Use the unit-test fixture.");
  const second = hit("Replace the integration stub.");

  expect(first?.hash).not.toBe(second?.hash);
  expect(first?.loose_hash).not.toBe(second?.loose_hash);
  expect(first?.message_depth).toBe(2);
  expect(first?.prompt_anchor_depth).toBe(1);
});
