import { expect, test } from "bun:test";

import { prefixChain } from "@mupt-ai/dari-router/policy-engine";

import type {
  InteractionOutput,
  InteractionRequest,
  ProviderIdentity,
} from "../interaction/types.js";
import { chatCompletionsToInteraction } from "../protocol/input/chat_completions.js";
import { anthropicMessagesToInteraction } from "../protocol/input/anthropic_messages.js";
import { openAIResponsesToInteraction } from "../protocol/input/openai_responses.js";
import { assistantMessagePayload } from "../protocol/output/chat_completions.js";
import { piMessageToInteractionOutput } from "../providers/pi_output.js";
import { ROUTING_PREFIX_HASHES_MAX_COUNT } from "../platform/routing_contract.js";
import {
  extendInteractionChain,
  extendInteractionLooseChain,
  interactionLooseChain,
  interactionPrefixChain,
  interactionPrefixContext,
  interactionPrefixLookupHashes,
} from "./interaction_fingerprint.js";
import {
  CLAUDE,
  interactionOutput,
  OPENAI,
  request,
} from "./interaction_fingerprint.fixtures.js";

// The loose tier exists for clients that drop reasoning from echoes (the
// official OpenAI SDK types have no reasoning_content field): the strict
// extension misses their next turn, the loose extension must not.
test("loose extension matches a Chat echo with reasoning stripped", () => {
  const initial = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [{ role: "user", content: "Fix the failing test." }],
  });
  const output = interactionOutput([
    { type: "reasoning", summary: ["Reproduce, then fix."], content: [], source: OPENAI },
    {
      type: "tool_call",
      callId: "call_fix",
      kind: "function",
      name: "bash",
      input: '{"command":"bun test"}',
    },
  ]);
  const initialLoose = interactionLooseChain("rtr_1", initial);
  const looseExtension = extendInteractionLooseChain(
    initialLoose.at(-1) ?? "",
    output,
    "openai_chat",
  );
  const strictChain = interactionPrefixChain("rtr_1", initial, OPENAI);
  const strictExtension = extendInteractionChain(strictChain.at(-1) ?? "", output, OPENAI, {
    includeItemIds: false,
    sourceProtocol: "openai_chat",
  });

  const next = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [
      { role: "user", content: "Fix the failing test." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_fix",
            type: "function",
            function: { name: "bash", arguments: '{"command":"bun test"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_fix", content: "1 fail" },
    ],
  });
  const lookup = interactionPrefixLookupHashes("rtr_1", next);

  expect(looseExtension).toHaveLength(1);
  expect(interactionLooseChain("rtr_1", next)[initialLoose.length]).toBe(looseExtension[0]);
  expect(lookup).toContain(looseExtension[0]);
  // The strict tier correctly misses — the provider-visible bytes changed.
  expect(lookup).not.toContain(strictExtension.at(-1));
});

// The loose chain must be identical whether or not the client echoed the
// reasoning field — that invariance is what makes it client-durable.
test("loose chains are invariant to echoed reasoning payloads", () => {
  const withReasoning = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [
      { role: "user", content: "Run it." },
      {
        role: "assistant",
        content: null,
        reasoning_content: "Shell it out.",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ],
  });
  const withoutReasoning = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [
      { role: "user", content: "Run it." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ],
  });

  expect(interactionLooseChain("rtr_1", withReasoning)).toEqual(
    interactionLooseChain("rtr_1", withoutReasoning),
  );
});

// Responses clients that carry provider item ids (Codex's ItemIds feature)
// split on the strict tier at turn 2 — carriesItemIds is false on turn 1 —
// so the loose tier must ignore item ids entirely.
test("loose extension matches a Responses echo that carries item ids", () => {
  const initial = openAIResponsesToInteraction({
    model: "dari/routing",
    input: [{ role: "user", content: "Inspect this." }],
  });
  const output = interactionOutput([
    {
      type: "reasoning",
      id: "rs_new",
      summary: ["Look first."],
      content: [],
      source: OPENAI,
      continuation: { kind: "openai_reasoning", source: OPENAI, encryptedContent: "opaque-new" },
    },
    {
      type: "tool_call",
      id: "fc_new",
      callId: "call_new",
      kind: "function",
      name: "read_file",
      input: '{"path":"a.ts"}',
    },
  ]);
  const initialLoose = interactionLooseChain("rtr_1", initial);
  const looseExtension = extendInteractionLooseChain(
    initialLoose.at(-1) ?? "",
    output,
    "openai_responses",
  );

  const next = openAIResponsesToInteraction({
    model: "dari/routing",
    input: [
      { role: "user", content: "Inspect this." },
      {
        type: "reasoning",
        id: "rs_new",
        summary: [{ type: "summary_text", text: "Look first." }],
        encrypted_content: "dari-pcs-v1." + Buffer.from(JSON.stringify({
          v: 1,
          kind: "openai_reasoning",
          source: OPENAI,
          state: { encrypted_content: "opaque-new" },
        })).toString("base64url"),
      },
      {
        type: "function_call",
        id: "fc_new",
        call_id: "call_new",
        name: "read_file",
        arguments: '{"path":"a.ts"}',
      },
      { type: "function_call_output", call_id: "call_new", output: "contents" },
    ],
  });
  const lookup = interactionPrefixLookupHashes("rtr_1", next);

  expect(looseExtension.length).toBeGreaterThan(0);
  expect(lookup).toContain(looseExtension.at(-1) ?? "");
});

// Anthropic-protocol clients must echo thinking blocks for tool loops, but a
// non-compliant proxy that strips them should still keep its conversation.
test("loose extension matches an Anthropic echo with thinking stripped", () => {
  const initial = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 512,
    messages: [{ role: "user", content: "Check the log." }],
  });
  const output = interactionOutput([
    {
      type: "reasoning",
      summary: ["Read it via bash."],
      content: [],
      source: CLAUDE,
      continuation: {
        kind: "anthropic_thinking",
        source: CLAUDE,
        thinking: "Read it via bash.",
        signature: "sig-1",
      },
    },
    {
      type: "tool_call",
      callId: "toolu_log",
      kind: "function",
      name: "bash",
      input: '{"command":"cat log"}',
    },
  ]);
  const initialLoose = interactionLooseChain("rtr_1", initial);
  const looseExtension = extendInteractionLooseChain(
    initialLoose.at(-1) ?? "",
    output,
    "anthropic_messages",
  );

  const next = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 512,
    messages: [
      { role: "user", content: "Check the log." },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_log", name: "bash", input: { command: "cat log" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_log", content: "error: boom" }],
      },
    ],
  });
  const lookup = interactionPrefixLookupHashes("rtr_1", next);

  expect(looseExtension.length).toBeGreaterThan(0);
  expect(lookup).toContain(looseExtension.at(-1) ?? "");
});

// Distinct seeds keep the tiers disjoint: a loose hash can never be mistaken
// for a strict hash in the shared lookup space.
test("loose and strict chains never share hashes", () => {
  const interaction = request();
  const strict = new Set([
    ...interactionPrefixChain("rtr_1", interaction, null),
    ...interactionPrefixChain("rtr_1", interaction, OPENAI),
  ]);
  for (const hash of interactionLooseChain("rtr_1", interaction)) {
    expect(strict.has(hash)).toBe(false);
  }
});
