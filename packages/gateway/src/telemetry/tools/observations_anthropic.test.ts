import { expect, test } from "bun:test";

import type {
  InteractionOutput,
  ProviderIdentity,
} from "../../interaction/types.js";
import { anthropicMessagesToInteraction } from "../../protocol/input/anthropic_messages.js";
import { anthropicContent } from "../../protocol/output/anthropic_messages_output.js";
import { toolResultObservations, toolSkillEvents } from "./observations.js";

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

const calls: InteractionOutput["items"] = [
  {
    type: "tool_call",
    id: "fc_read",
    callId: "call_read",
    kind: "function",
    name: "read_file",
    input: '{"path":"README.md"}',
  },
  {
    type: "tool_call",
    id: "fc_list",
    callId: "call_list",
    kind: "function",
    name: "list_files",
    input: "{}",
  },
];

function output(items: InteractionOutput["items"]): InteractionOutput {
  return {
    source: OPENAI,
    items,
    createdAtMs: 1,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "tool_use",
  };
}

test("Anthropic client-visible replay correlates parallel results surrounded by user text", () => {
  const firstRequest = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 256,
    messages: [{ role: "user", content: "Inspect both files." }],
  });
  const providerOutput: InteractionOutput = {
    ...output([
      {
        type: "reasoning",
        summary: ["Inspect both paths."],
        content: [],
        source: ANTHROPIC,
        continuation: {
          kind: "anthropic_thinking",
          source: ANTHROPIC,
          thinking: "Inspect both paths.",
          signature: "native-signature",
        },
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "I will inspect " }],
        contentShape: "parts",
        source: ANTHROPIC,
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "both files." }],
        contentShape: "parts",
        source: ANTHROPIC,
      },
      ...calls,
    ]),
    source: ANTHROPIC,
  };
  const emitted = toolSkillEvents({
    routerId: "rtr_1",
    request: firstRequest,
    output: providerOutput,
    zdr: false,
  });
  const clientVisibleContent = anthropicContent(providerOutput);
  const replayedWithoutThinking = clientVisibleContent.filter(
    (block) => block.type !== "thinking" && block.type !== "redacted_thinking",
  );
  const continuation = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 256,
    messages: [
      { role: "user", content: "Inspect both files." },
      { role: "assistant", content: replayedWithoutThinking },
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>Tool results follow.</system-reminder>" },
          { type: "tool_result", tool_use_id: "call_read", content: "contents" },
          { type: "tool_result", tool_use_id: "call_list", content: "README.md" },
          { type: "text", text: "<system-reminder>Continue the task.</system-reminder>" },
        ],
      },
    ],
  });

  const observed = toolResultObservations({
    routerId: "rtr_1",
    request: continuation,
    zdr: false,
  });

  expect(observed).toEqual([
    {
      tool_call_id: "call_read",
      exchange_context_hash: emitted[0]?.exchange_context_hash,
      ordinal: 5,
    },
    {
      tool_call_id: "call_list",
      exchange_context_hash: emitted[0]?.exchange_context_hash,
      ordinal: 6,
    },
  ]);
  expect(emitted[0]?.exchange_context_hash).toBeString();
  expect(emitted[1]?.exchange_context_hash).toBe(
    emitted[0]?.exchange_context_hash,
  );

  const replayedWithThinking = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 256,
    messages: [
      { role: "user", content: "Inspect both files." },
      { role: "assistant", content: clientVisibleContent },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_read", content: "contents" },
          { type: "tool_result", tool_use_id: "call_list", content: "README.md" },
        ],
      },
    ],
  });
  expect(
    toolResultObservations({
      routerId: "rtr_1",
      request: replayedWithThinking,
      zdr: false,
    }).map((result) => result.exchange_context_hash),
  ).toEqual([
    emitted[0]?.exchange_context_hash,
    emitted[0]?.exchange_context_hash,
  ]);
});

test("Anthropic historical results before a later assistant response are not observed again", () => {
  const interaction = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 256,
    messages: [
      { role: "user", content: "Read README." },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "toolu_read",
          name: "read_file",
          input: { path: "README.md" },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_read",
          content: "contents",
        }],
      },
      { role: "assistant", content: "README is readable." },
      { role: "user", content: "Now summarize it." },
    ],
  });

  expect(
    toolResultObservations({ routerId: "rtr_1", request: interaction, zdr: false }),
  ).toEqual([]);
});

test("Anthropic chained results correlate only with the latest emitted call across a provider switch", () => {
  const firstProviderOutput: InteractionOutput = {
    ...output([calls[0]]),
    source: ANTHROPIC,
  };
  const firstAssistant = anthropicContent(firstProviderOutput);
  const secondRequest = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 256,
    messages: [
      { role: "user", content: "Inspect and then summarize README." },
      { role: "assistant", content: firstAssistant },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_read",
          content: "README contents",
        }],
      },
    ],
  });
  const switchedProviderOutput: InteractionOutput = {
    ...output([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "I will inspect the tests next." }],
        contentShape: "parts",
        source: OPENAI,
      },
      calls[1],
    ]),
    source: OPENAI,
  };
  const emitted = toolSkillEvents({
    routerId: "rtr_1",
    request: secondRequest,
    output: switchedProviderOutput,
    zdr: false,
  });
  const continuation = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 256,
    messages: [
      { role: "user", content: "Inspect and then summarize README." },
      { role: "assistant", content: firstAssistant },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_read",
          content: "README contents",
        }],
      },
      { role: "assistant", content: anthropicContent(switchedProviderOutput) },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_list",
          content: "tests/tool.test.ts",
        }],
      },
    ],
  });

  expect(
    toolResultObservations({
      routerId: "rtr_1",
      request: continuation,
      zdr: false,
    }),
  ).toEqual([
    {
      tool_call_id: "call_list",
      exchange_context_hash: emitted[0]?.exchange_context_hash,
      ordinal: 5,
    },
  ]);
});
