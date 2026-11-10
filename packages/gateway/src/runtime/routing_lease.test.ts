import { expect, test } from "bun:test";

import type {
  ChatMessage,
  PreviousDecision,
  ReasoningEffort,
} from "@mupt-ai/dari-router/policy-engine";

import { anthropicMessagesToInteraction } from "../protocol/input/anthropic_messages.js";
import { chatCompletionsToInteraction } from "../protocol/input/chat_completions.js";
import { openAIResponsesToInteraction } from "../protocol/input/openai_responses.js";
import { selectorMessagesForInteraction } from "../strategies/selector_projection.js";
import { leasedRoutingDecision } from "./routing_lease.js";

function msg(role: string): ChatMessage {
  return { role, content: "test" };
}

const DEFAULT_EFFORT: ReasoningEffort = "off";

function prev(overrides?: Partial<PreviousDecision>): PreviousDecision {
  return {
    model: overrides?.model ?? "openai/gpt-5.6-sol",
    reasoningEffort: overrides?.reasoningEffort ?? DEFAULT_EFFORT,
    reason: overrides?.reason ?? "prior turn",
  };
}

test("leasedRoutingDecision returns null without a previous decision", () => {
  expect(
    leasedRoutingDecision({
      messages: [msg("user")],
    }),
  ).toBeNull();
});

test("leasedRoutingDecision returns null on every 10th completed turn", () => {
  const assistants = Array.from({ length: 20 }, () => msg("assistant"));
  for (const count of [0, 10]) {
    expect(
      leasedRoutingDecision({
        messages: [msg("system"), ...assistants.slice(0, count)],
        previousDecision: prev(),
      }),
    ).toBeNull();
  }
});

test("leasedRoutingDecision returns the previous model on intervening turns", () => {
  const assistants = Array.from({ length: 19 }, () => msg("assistant"));
  for (const count of [1, 5, 9, 11, 15, 19]) {
    const result = leasedRoutingDecision({
      messages: [msg("system"), ...assistants.slice(0, count)],
      previousDecision: prev(),
    });
    expect(result).not.toBeNull();
    expect(result!.decision.selectedModel).toBe("openai/gpt-5.6-sol");
    expect(result!.decision.reasoningEffort).toBe("off");
    expect(result!.completedTurns).toBe(count);
    expect(result!.turnInLease).toBe((count % 10) + 1);
  }
});

test("leasedRoutingDecision preserves the previous decision reason", () => {
  const result = leasedRoutingDecision({
    messages: [msg("user"), msg("assistant")],
    previousDecision: prev({ reason: "staying warm" }),
  });
  expect(result!.decision.reason).toBe("staying warm");
});

test("leasedRoutingDecision fills in a lease reason when none is stored", () => {
  const result = leasedRoutingDecision({
    messages: [msg("user"), msg("assistant")],
    previousDecision: { model: "model/test", reasoningEffort: "off", reason: "" },
  });
  expect(result!.decision.reason).toContain("Continuing");
  expect(result!.decision.reason).toContain("10-turn");
});

test("leasedRoutingDecision ignores tool-result turns and non-assistant roles", () => {
  const result = leasedRoutingDecision({
    messages: [
      msg("system"),
      msg("user"),
      msg("assistant"),
      { role: "tool", tool_call_id: "call_1", content: "result" },
      msg("developer"),
      msg("user"),
    ],
    previousDecision: prev(),
  });
  expect(result!.completedTurns).toBe(1);
  expect(result!.turnInLease).toBe(2);
});

test("leasedRoutingDecision counts assistant messages with named tool calls", () => {
  const result = leasedRoutingDecision({
    messages: [
      msg("user"),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "result" },
    ],
    previousDecision: prev(),
  });
  expect(result!.completedTurns).toBe(1);
  expect(result!.turnInLease).toBe(2);
});

test.each([
  [
    "Chat Completions",
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [
        { role: "user", content: "First." },
        { role: "assistant", content: "Reply." },
        { role: "user", content: "Second." },
      ],
    }),
  ],
  [
    "OpenAI Responses",
    openAIResponsesToInteraction({
      model: "dari/routing",
      input: [
        { role: "user", content: "First." },
        { role: "assistant", content: "Reply." },
        { role: "user", content: "Second." },
      ],
    }),
  ],
  [
    "Anthropic Messages",
    anthropicMessagesToInteraction({
      model: "dari/routing",
      max_tokens: 512,
      messages: [
        { role: "user", content: "First." },
        { role: "assistant", content: "Reply." },
        { role: "user", content: "Second." },
      ],
    }),
  ],
] as const)("%s retains fixed-turn lease position", (_name, interaction) => {
  const result = leasedRoutingDecision({
    messages: selectorMessagesForInteraction(interaction).messages,
    previousDecision: prev(),
  });

  expect(result?.completedTurns).toBe(1);
  expect(result?.turnInLease).toBe(2);
});
