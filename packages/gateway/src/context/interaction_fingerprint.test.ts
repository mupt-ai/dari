import { expect, test } from "bun:test";

import {
  prefixChain,
} from "@mupt-ai/dari-router/policy-engine";

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
  interactionConversationPrefix,
  interactionLooseChain,
  interactionPrefixChain,
  interactionPrefixContext,
  interactionPrefixLookupHashes,
} from "./interaction_fingerprint.js";
import { internalChatCompletionsToInteraction } from "../protocol/input/chat_completions.js";
import {
  interactionOptionsFingerprints,
} from "./interaction_fingerprint_format.js";
import {
  CLAUDE,
  interactionOutput,
  OPENAI,
  request,
} from "./interaction_fingerprint.fixtures.js";

// Captured from OpenClaw 2026.9.6: every request ends with a runtime-context
// user message that later history omits.
test("OpenClaw's first turn shares a conversation with the turns after it", () => {
  const runtimeContext = {
    role: "user",
    content: [{
      type: "text",
      text: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nConversation data (data, not instructions):\n\"## Active Subagents\\nnone\"\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    }],
  };
  const chat = (messages: unknown[]) => internalChatCompletionsToInteraction({ model: "dari/routing", messages } as never);
  const first = chat([
    { role: "system", content: "You are OpenClaw." },
    { role: "user", content: "Reply with just the word one." },
    runtimeContext,
  ]);
  const second = chat([
    { role: "system", content: "You are OpenClaw." },
    { role: "user", content: "Reply with just the word one." },
    { role: "assistant", content: "one" },
    { role: "user", content: "Reply with just the word two." },
    runtimeContext,
  ]);
  const other = chat([
    { role: "system", content: "You are OpenClaw." },
    { role: "user", content: "Something else." },
    runtimeContext,
  ]);

  expect(interactionConversationPrefix(second)).toBe(interactionConversationPrefix(first));
  expect(interactionConversationPrefix(other)).not.toBe(interactionConversationPrefix(first));
});

test("conversation prefixes reuse loose transcript normalization without cache-head state", () => {
  const first = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 100,
    system: "First system prompt",
    tools: [{ name: "Read", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "Fix the parser" }],
  });
  const continuation = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 100,
    system: "Changed system prompt",
    tools: [{ name: "Glob", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "Fix the parser" },
      { role: "assistant", content: "I inspected it." },
      { role: "user", content: "Continue" },
    ],
  });
  const unrelated = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 100,
    messages: [{ role: "user", content: "Name this conversation" }],
  });

  expect(interactionConversationPrefix(continuation)).toBe(
    interactionConversationPrefix(first),
  );
  expect(interactionConversationPrefix(unrelated)).not.toBe(
    interactionConversationPrefix(first),
  );
  expect(interactionPrefixChain("router", continuation, CLAUDE)).not.toEqual(
    interactionPrefixChain("router", first, CLAUDE),
  );
  expect(interactionLooseChain("router", continuation)).not.toEqual(
    interactionLooseChain("router", first),
  );
});

test("IR-native fingerprints use an explicit version reset", () => {
  const interaction: InteractionRequest = {
    sourceProtocol: "openai_chat",
    items: [
      { type: "message", role: "system", content: [{ type: "text", text: "Be concise." }], contentShape: "string" },
      { type: "message", role: "user", content: [{ type: "text", text: "Hello" }], contentShape: "string" },
      { type: "message", role: "assistant", content: [{ type: "text", text: "Hi" }], contentShape: "string" },
      { type: "message", role: "user", content: [{ type: "text", text: "Next" }], contentShape: "string" },
    ],
    tools: [{
      kind: "function",
      namespace: "files",
      name: "read",
      description: "Read a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
      strict: true,
    }],
    toolChoice: { kind: "function", namespace: "files", name: "read" },
    responseFormat: {
      type: "json_schema",
      name: "answer",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
      },
      strict: true,
    },
    generation: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 256,
      stop: ["DONE"],
    },
    stream: false,
  };
  const chain = interactionPrefixChain("rtr_1", interaction, OPENAI);
  const legacyChain = prefixChain("rtr_1", {
    model: "dari/routing",
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "Next" },
    ],
  });

  expect(chain).toHaveLength(3);
  expect(chain).not.toEqual(legacyChain);
  expect(chain.every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
});

test("IR-native heads include specialized tool semantics", () => {
  const base = request();
  base.tools = [{
    kind: "custom",
    namespace: "patches",
    name: "apply_patch",
    description: "Apply a patch.",
    format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
  }];
  const changed: InteractionRequest = {
    ...base,
    tools: [{
      kind: "custom",
      namespace: "patches",
      name: "apply_patch",
      description: "Apply a patch.",
      format: { type: "grammar", syntax: "lark", definition: "start: /diff/" },
    }],
  };

  expect(interactionPrefixChain("rtr_1", base, OPENAI)).not.toEqual(
    interactionPrefixChain("rtr_1", changed, OPENAI),
  );
});

test("option fingerprints use canonical Interaction controls", () => {
  const base = request();
  base.toolChoice = { kind: "function", namespace: "files", name: "read" };
  base.responseFormat = {
    type: "json_schema",
    name: "answer",
    schema: { type: "object" },
  };
  const same = structuredClone(base);
  const changedChoice: InteractionRequest = { ...base, toolChoice: "required" };
  const changedFormat: InteractionRequest = {
    ...base,
    responseFormat: { type: "json_object" },
  };

  expect(interactionOptionsFingerprints(same)).toEqual(
    interactionOptionsFingerprints(base),
  );
  expect(interactionOptionsFingerprints(changedChoice).tool_choice_fp).not.toBe(
    interactionOptionsFingerprints(base).tool_choice_fp,
  );
  expect(
    interactionOptionsFingerprints(changedFormat).response_format_fp,
  ).not.toBe(interactionOptionsFingerprints(base).response_format_fp);
  expect(
    interactionPrefixContext(
      "rtr_1",
      base,
      new Map([["openai/gpt-5.5", OPENAI]]),
    ).fingerprints,
  ).toEqual(interactionOptionsFingerprints(base));
});

test("Claude Code system reminders keep their prefix when replayed as strings", () => {
  const first = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    system: "You are Claude Code.",
    messages: [
      { role: "system", content: [{ type: "text", text: "Follow the repository instructions." }] },
      { role: "user", content: [{ type: "text", text: "First turn." }] },
    ],
  });
  const replay = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    system: "You are Claude Code.",
    messages: [
      { role: "system", content: "Follow the repository instructions." },
      { role: "user", content: [{ type: "text", text: "First turn." }] },
      { role: "assistant", content: [{ type: "text", text: "First reply." }] },
      { role: "user", content: [{ type: "text", text: "Second turn." }] },
    ],
  });

  const firstChain = interactionPrefixChain("rtr_1", first, CLAUDE);
  const replayChain = interactionPrefixChain("rtr_1", replay, CLAUDE);
  expect(replayChain[0]).toBe(firstChain[0]);
});

test("mid-conversation system notes extend the transcript without reseeding its prefix", () => {
  const first = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    system: "You are Claude Code.",
    messages: [
      { role: "user", content: "First turn." },
      { role: "assistant", content: "First reply." },
    ],
  });
  const replay = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    system: "You are Claude Code.",
    messages: [
      { role: "user", content: "First turn." },
      { role: "assistant", content: "First reply." },
      { role: "system", content: "<total_tokens>1000 tokens left</total_tokens>" },
      { role: "user", content: "Second turn." },
    ],
  });

  const firstChain = interactionPrefixChain("rtr_1", first, CLAUDE);
  const replayChain = interactionPrefixChain("rtr_1", replay, CLAUDE);
  expect(replayChain.slice(0, firstChain.length)).toEqual(firstChain);
  expect(replayChain).toHaveLength(firstChain.length + 1);
});

test("Claude Code replay matches text returned by a Responses provider", () => {
  const first = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    system: "You are Claude Code.",
    messages: [
      { role: "system", content: [{ type: "text", text: "Follow the repository instructions." }] },
      { role: "user", content: [{ type: "text", text: "First turn." }] },
    ],
  });
  const output = interactionOutput([{
    type: "message",
    id: "msg_1",
    role: "assistant",
    content: [{ type: "text", text: "First reply." }],
    contentShape: "parts",
    phase: "final_answer",
    source: OPENAI,
  }]);
  const firstChain = interactionPrefixChain("rtr_1", first, OPENAI);
  const extension = extendInteractionChain(firstChain.at(-1) ?? "", output, OPENAI, {
    includeItemIds: false,
    sourceProtocol: "anthropic_messages",
  });
  const replay = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    system: "You are Claude Code.",
    messages: [
      { role: "system", content: "Follow the repository instructions." },
      { role: "user", content: [{ type: "text", text: "First turn." }] },
      { role: "assistant", content: [{ type: "text", text: "First reply." }] },
      { role: "user", content: [{ type: "text", text: "Second turn." }] },
    ],
  });
  const replayChain = interactionPrefixChain("rtr_1", replay, OPENAI);

  expect(extension).toHaveLength(1);
  expect(replayChain[firstChain.length]).toBe(extension[0]);
});

test("Anthropic reply extension matches adjacent text blocks echoed in one assistant message", () => {
  const initial = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    messages: [{ role: "user", content: "First turn." }],
  });
  const output = interactionOutput([
    {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "First block." }],
      contentShape: "parts",
      source: CLAUDE,
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Second block." }],
      contentShape: "parts",
      source: CLAUDE,
    },
  ]);
  const initialChain = interactionPrefixChain("rtr_1", initial, CLAUDE);
  const extension = extendInteractionChain(
    initialChain.at(-1) ?? "",
    output,
    CLAUDE,
    { includeItemIds: false, sourceProtocol: "anthropic_messages" },
  );
  const initialLooseChain = interactionLooseChain("rtr_1", initial);
  const looseExtension = extendInteractionLooseChain(
    initialLooseChain.at(-1) ?? "",
    output,
    "anthropic_messages",
  );
  const next = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    messages: [
      { role: "user", content: "First turn." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "First block." },
          { type: "text", text: "Second block." },
        ],
      },
      { role: "user", content: "Second turn." },
    ],
  });
  const nextChain = interactionPrefixChain("rtr_1", next, CLAUDE);
  const nextLooseChain = interactionLooseChain("rtr_1", next);
  const lookup = interactionPrefixLookupHashes("rtr_1", next);

  expect(extension).toHaveLength(1);
  expect(nextChain[initialChain.length]).toBe(extension[0]);
  expect(nextLooseChain[initialLooseChain.length]).toBe(looseExtension[0]);
  expect(lookup).toContain(extension[0]);
  expect(lookup).toContain(looseExtension[0]);
});

test("Chat reasoning output extension matches the next client-carried turn", () => {
  const initial = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [{ role: "user", content: "Inspect this." }],
  });
  const output = interactionOutput([
    {
      type: "reasoning",
      summary: ["Use the tool."],
      content: [],
      source: OPENAI,
      continuation: {
        kind: "openai_reasoning",
        source: OPENAI,
        encryptedContent: "opaque-chat-reasoning",
      },
    },
    {
      type: "tool_call",
      callId: "call_1",
      kind: "function",
      name: "read_file",
      input: { path: "README.md" },
    },
  ]);
  const initialChain = interactionPrefixChain("rtr_1", initial, OPENAI);
  const extension = extendInteractionChain(initialChain.at(-1) ?? "", output, OPENAI, {
    includeItemIds: false,
    sourceProtocol: "openai_chat",
  });
  const assistant = assistantMessagePayload(output);
  const next = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [
      { role: "user", content: "Inspect this." },
      assistant,
      { role: "tool", tool_call_id: "call_1", content: "contents" },
    ],
  });
  const nextChain = interactionPrefixChain("rtr_1", next, OPENAI);

  expect(extension).toHaveLength(1);
  expect(nextChain[initialChain.length]).toBe(extension[0]);
});

// Regression for prod conversation fragmentation: a Chat reply carrying
// reasoning must extend the chain to the exact hash the next request's input
// fingerprint computes from the client's echo — including when the client
// echoes the streamed reasoning text, whose whitespace joins differ from the
// aggregated response body ("\n\n" separators and a trailing "\n\n").
test("Chat reasoning reply extension matches a streamed-echo continuation", () => {
  const initial = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [{ role: "user", content: "Fix the failing test." }],
  });
  const output = interactionOutput([
    {
      type: "reasoning",
      summary: ["**Analyzing the failure**", "**Reproducing it locally**"],
      content: [],
      source: OPENAI,
    },
    {
      type: "tool_call",
      callId: "call_A|fc_B",
      kind: "function",
      name: "bash",
      input: '{"command":"bun test"}',
    },
  ]);
  const initialChain = interactionPrefixChain("rtr_1", initial, OPENAI);
  const extension = extendInteractionChain(initialChain.at(-1) ?? "", output, OPENAI, {
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
        reasoning_content: "**Analyzing the failure**\n\n**Reproducing it locally**\n\n",
        tool_calls: [
          {
            id: "call_A|fc_B",
            type: "function",
            function: { name: "bash", arguments: '{"command":"bun test"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_A|fc_B", content: "1 pass" },
    ],
  });
  const nextChain = interactionPrefixChain("rtr_1", next, OPENAI);
  const lookup = interactionPrefixLookupHashes("rtr_1", next);

  expect(extension).toHaveLength(1);
  expect(nextChain[initialChain.length]).toBe(extension[0]);
  expect(lookup).toContain(extension[0]);
});

// Some providers emit whitespace-only text alongside tool calls; clients that
// assemble the reply from stream deltas echo that content as null.
test("Chat whitespace-only reply content matches a null-content echo", () => {
  const initial = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [{ role: "user", content: "Run the linter." }],
  });
  const output = interactionOutput([
    {
      type: "reasoning",
      summary: ["Run it via the shell."],
      content: [],
      source: OPENAI,
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "\n\n" }],
      contentShape: "string",
      source: OPENAI,
    },
    {
      type: "tool_call",
      callId: "call_lint",
      kind: "function",
      name: "bash",
      input: '{"command":"bun lint"}',
    },
  ]);
  const initialChain = interactionPrefixChain("rtr_1", initial, OPENAI);
  const extension = extendInteractionChain(initialChain.at(-1) ?? "", output, OPENAI, {
    includeItemIds: false,
    sourceProtocol: "openai_chat",
  });
  const next = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [
      { role: "user", content: "Run the linter." },
      {
        role: "assistant",
        content: null,
        reasoning_content: "Run it via the shell.",
        tool_calls: [
          {
            id: "call_lint",
            type: "function",
            function: { name: "bash", arguments: '{"command":"bun lint"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_lint", content: "clean" },
    ],
  });
  const nextChain = interactionPrefixChain("rtr_1", next, OPENAI);

  expect(extension).toHaveLength(1);
  expect(nextChain[initialChain.length]).toBe(extension[0]);
});

// Anthropic-served Chat replies echo reasoning_details continuation envelopes
// next to the streamed reasoning text; the stored extension must match that
// echo shape too.
test("Chat reasoning reply extension matches an envelope-carrying echo", () => {
  const initial = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [{ role: "user", content: "Investigate the CI failure." }],
  });
  const output = interactionOutput([
    {
      type: "reasoning",
      summary: ["I need to inspect the logs."],
      content: [],
      source: CLAUDE,
      continuation: {
        kind: "anthropic_thinking",
        source: CLAUDE,
        thinking: "I need to inspect the logs.",
        signature: "native-signature",
      },
    },
    {
      type: "tool_call",
      callId: "toolu_logs",
      kind: "function",
      name: "bash",
      input: '{"command":"cat log"}',
    },
  ]);
  const initialChain = interactionPrefixChain("rtr_1", initial, CLAUDE);
  const extension = extendInteractionChain(initialChain.at(-1) ?? "", output, CLAUDE, {
    includeItemIds: false,
    sourceProtocol: "openai_chat",
  });
  const assistant = assistantMessagePayload(output);
  const next = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [
      { role: "user", content: "Investigate the CI failure." },
      assistant,
      { role: "tool", tool_call_id: "toolu_logs", content: "error: boom" },
    ],
  });
  const nextChain = interactionPrefixChain("rtr_1", next, CLAUDE);
  const lookup = interactionPrefixLookupHashes("rtr_1", next);

  expect(extension).toHaveLength(1);
  expect(nextChain[initialChain.length]).toBe(extension[0]);
  expect(lookup).toContain(extension[0]);
});

test("Chat hosted-search output extension canonicalizes payload bytes like replay", () => {
  const initial = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [{ role: "user", content: "Find the release notes." }],
  });
  const output = interactionOutput([
    {
      type: "hosted_tool_call",
      id: "ws_1",
      tool: "web_search",
      providerType: "web_search_call",
      status: "completed",
      payload: {
        type: "web_search_call",
        status: "completed",
        id: "ws_1",
        action: { query: "Dari release notes", type: "search" },
      },
      source: OPENAI,
    },
  ]);
  const initialChain = interactionPrefixChain("rtr_1", initial, OPENAI);
  const extension = extendInteractionChain(initialChain.at(-1) ?? "", output, OPENAI, {
    includeItemIds: false,
    sourceProtocol: "openai_chat",
  });
  const next = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [
      { role: "user", content: "Find the release notes." },
      assistantMessagePayload(output),
    ],
  });
  const nextChain = interactionPrefixChain("rtr_1", next, OPENAI);

  expect(extension).toHaveLength(1);
  expect(nextChain[initialChain.length]).toBe(extension[0]);
});

test("Chat hosted-search output extension omits a null provider status like replay", () => {
  const initial = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [{ role: "user", content: "Find the release notes." }],
  });
  const output = interactionOutput([
    {
      type: "hosted_tool_call",
      id: "ws_1",
      tool: "web_search",
      providerType: "web_search_call",
      payload: {
        type: "web_search_call",
        status: null,
        id: "ws_1",
        action: { query: "Dari release notes", type: "search" },
      },
      source: OPENAI,
    },
  ]);
  const initialChain = interactionPrefixChain("rtr_1", initial, OPENAI);
  const extension = extendInteractionChain(initialChain.at(-1) ?? "", output, OPENAI, {
    includeItemIds: false,
    sourceProtocol: "openai_chat",
  });
  const next = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [
      { role: "user", content: "Find the release notes." },
      assistantMessagePayload(output),
    ],
  });
  const nextChain = interactionPrefixChain("rtr_1", next, OPENAI);

  expect(extension).toHaveLength(1);
  expect(nextChain[initialChain.length]).toBe(extension[0]);
});

test("image detail participates directly in IR-native prefix hashes", () => {
  const withDetail = (detail: "low" | "high") => openAIResponsesToInteraction({
    model: "dari/routing",
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_image",
        image_url: "data:image/png;base64,aW1hZ2U=",
        detail,
      }],
    }],
  });
  const high = withDetail("high");
  const highChain = interactionPrefixChain("rtr_1", high, OPENAI);

  expect(highChain).toHaveLength(1);
  expect(highChain).not.toEqual(interactionPrefixChain("rtr_1", withDetail("low"), OPENAI));
});

test("reasoning configuration updates do not rewrite conversation prefix identity", () => {
  const transcript = [
    { type: "message", role: "user", content: "first" },
    { type: "message", role: "assistant", content: "first response" },
    { type: "message", role: "user", content: "second" },
  ];
  const unchanged = openAIResponsesToInteraction({
    model: "dari/routing",
    reasoning: { effort: "low" },
    input: transcript,
  });
  const updated = openAIResponsesToInteraction({
    model: "dari/routing",
    reasoning: { effort: "low" },
    input: [
      ...transcript.slice(0, 2),
      { type: "configuration_update", reasoning: { effort: "high" } },
      transcript[2],
    ],
  });

  expect(interactionPrefixChain("rtr_1", updated, OPENAI)).toEqual(
    interactionPrefixChain("rtr_1", unchanged, OPENAI),
  );
});

test("replayed Responses text preserves the provider output prefix", () => {
  const initial = openAIResponsesToInteraction({
    model: "dari/routing",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello" }],
      },
    ],
  });
  const output = piMessageToInteractionOutput(
    { content: [{ type: "text", text: "Hi" }], stopReason: "stop" },
    OPENAI,
    initial
  );
  const initialChain = interactionPrefixChain("rtr_1", initial, OPENAI);
  const extension = extendInteractionChain(initialChain.at(-1) ?? "", output, OPENAI, {
    includeItemIds: false,
    sourceProtocol: "openai_responses",
  });
  const next = openAIResponsesToInteraction({
    model: "dari/routing",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hi" }],
      },
    ],
  });

  expect(interactionPrefixChain("rtr_1", next, OPENAI)[1]).toBe(extension.at(-1) ?? "");
});

test("compatible continuation state changes only its exact provider-visible chain", () => {
  const first = request("opaque-a");
  const second = request("opaque-b");

  expect(interactionPrefixChain("rtr_1", first, OPENAI)).not.toEqual(
    interactionPrefixChain("rtr_1", second, OPENAI)
  );
  expect(interactionPrefixChain("rtr_1", first, CLAUDE)).toEqual(
    interactionPrefixChain("rtr_1", second, CLAUDE)
  );
  expect(interactionPrefixChain("rtr_1", first, null)).toEqual(
    interactionPrefixChain("rtr_1", second, null)
  );
});

test("fingerprints every ordered reasoning state coalesced with a tool call", () => {
  const withReasoning = (encryptedContents: [string, string]): InteractionRequest => ({
    sourceProtocol: "openai_responses",
    items: [
      { type: "message", role: "user", content: [{ type: "text", text: "Inspect this." }], contentShape: "parts" },
      {
        type: "tool_call",
        id: "fc_1",
        callId: "call_1",
        kind: "function",
        name: "read_file",
        input: '{"path":"a.ts"}',
      },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        content: [],
        continuation: {
          kind: "openai_reasoning",
          source: OPENAI,
          encryptedContent: encryptedContents[0],
        },
      },
      {
        type: "reasoning",
        id: "rs_2",
        summary: [],
        content: [],
        continuation: {
          kind: "openai_reasoning",
          source: OPENAI,
          encryptedContent: encryptedContents[1],
        },
      },
    ],
    tools: [],
    generation: {},
    stream: true,
  });

  const first = withReasoning(["opaque-first", "opaque-last"]);
  const changedFirst = withReasoning(["opaque-changed", "opaque-last"]);
  const reordered = withReasoning(["opaque-last", "opaque-first"]);

  const firstOpenAI = interactionPrefixChain("rtr_1", first, OPENAI);
  expect(firstOpenAI).not.toEqual(interactionPrefixChain("rtr_1", changedFirst, OPENAI));
  expect(firstOpenAI).not.toEqual(interactionPrefixChain("rtr_1", reordered, OPENAI));
  expect(interactionPrefixChain("rtr_1", first, CLAUDE)).toEqual(
    interactionPrefixChain("rtr_1", changedFirst, CLAUDE)
  );
});

test("lookup hashes include exact continuation and portable provider variants", () => {
  const interaction = request();
  const lookup = new Set(interactionPrefixLookupHashes("rtr_1", interaction));
  const openai = interactionPrefixChain("rtr_1", interaction, OPENAI);
  const claude = interactionPrefixChain("rtr_1", interaction, CLAUDE);

  expect(lookup.has(openai.at(-1) ?? "")).toBe(true);
  expect(lookup.has(claude.at(-1) ?? "")).toBe(true);
  expect(lookup.size).toBeLessThanOrEqual(ROUTING_PREFIX_HASHES_MAX_COUNT);
});

test("Responses tool history exposes both composite and portable lookup variants", () => {
  const interaction: InteractionRequest = {
    sourceProtocol: "openai_responses",
    items: [
      { type: "message", role: "user", content: [{ type: "text", text: "Read it." }], contentShape: "parts" },
      {
        type: "tool_call",
        id: "fc_1",
        callId: "call_1",
        kind: "function",
        name: "read_file",
        input: { path: "README.md" },
      },
      {
        type: "tool_result",
        callId: "call_1",
        kind: "function",
        name: "read_file",
        output: "contents",
        outputShape: "string",
      },
    ],
    tools: [],
    generation: {},
    stream: true,
  };
  const lookup = new Set(interactionPrefixLookupHashes("rtr_1", interaction));
  const openai = interactionPrefixChain("rtr_1", interaction, OPENAI);
  const anthropic = interactionPrefixChain("rtr_1", interaction, CLAUDE);

  expect(openai).not.toEqual(anthropic);
  expect(lookup.has(openai.at(-1) ?? "")).toBe(true);
  expect(lookup.has(anthropic.at(-1) ?? "")).toBe(true);
});

test("model chains retain provider-specific hashes and item indexes", () => {
  const context = interactionPrefixContext(
    "rtr_1",
    request(),
    new Map([
      ["openai/gpt-5.5", OPENAI],
      ["anthropic/claude-sonnet-4-6", CLAUDE],
    ])
  );
  expect(context.chainByModel.get("openai/gpt-5.5")).not.toEqual(
    context.chainByModel.get("anthropic/claude-sonnet-4-6")
  );
  const openAIChain = context.chainByModel.get("openai/gpt-5.5") ?? [];
  const itemIndexes = context.itemIndexByHashByModel.get("openai/gpt-5.5");
  expect(openAIChain.map((hash) => itemIndexes?.get(hash))).toEqual([0, 2, 3, 4]);
});

test("completed output extends every ordered provider-visible item deterministically", () => {
  const output: InteractionOutput = {
    responseId: "resp_1",
    createdAtMs: 1,
    source: OPENAI,
    items: [
      {
        type: "reasoning",
        id: "rs_2",
        summary: ["Need one command."],
        content: [],
        source: OPENAI,
        continuation: { kind: "openai_reasoning", source: OPENAI, encryptedContent: "opaque-next" },
      },
      {
        type: "tool_call",
        id: "fc_2",
        callId: "call_2",
        kind: "function",
        name: "exec_command",
        input: { cmd: "pwd", login: true, tty: true },
      },
      {
        type: "message",
        id: "msg_2",
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        contentShape: "parts",
        phase: "final_answer",
        source: OPENAI,
      },
    ],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  };

  const first = extendInteractionChain("a".repeat(64), output, OPENAI, {
    includeItemIds: true,
    sourceProtocol: "openai_responses",
  });
  expect(first).toHaveLength(2);
  expect(first).toEqual(extendInteractionChain("a".repeat(64), output, OPENAI, {
    includeItemIds: true,
    sourceProtocol: "openai_responses",
  }));
  expect(first).not.toEqual(extendInteractionChain("a".repeat(64), output, CLAUDE, {
    includeItemIds: true,
    sourceProtocol: "openai_responses",
  }));
});

test("reasoning-first output matches Codex tool-first replay and normalized message depth", () => {
  const initial: InteractionRequest = {
    sourceProtocol: "openai_responses",
    items: [
      { type: "message", role: "user", content: [{ type: "text", text: "Run pwd." }], contentShape: "parts" },
    ],
    tools: [
      {
        kind: "function",
        name: "exec_command",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
      },
    ],
    generation: {},
    stream: true,
  };
  const output: InteractionOutput = {
    responseId: "resp_2",
    createdAtMs: 1,
    source: OPENAI,
    items: [
      {
        type: "reasoning",
        id: "rs_3",
        summary: ["Inspect the task."],
        content: [],
        source: OPENAI,
        continuation: { kind: "openai_reasoning", source: OPENAI, encryptedContent: "opaque-third" },
      },
      {
        type: "reasoning",
        id: "rs_4",
        summary: ["Use the terminal."],
        content: [],
        source: OPENAI,
        continuation: { kind: "openai_reasoning", source: OPENAI, encryptedContent: "opaque-fourth" },
      },
      {
        type: "tool_call",
        id: "fc_3",
        callId: "call_3",
        kind: "function",
        name: "exec_command",
        input: { cmd: "pwd", login: true, tty: true },
      },
    ],
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
  const initialChain = interactionPrefixChain("rtr_1", initial, OPENAI);
  const extension = extendInteractionChain(initialChain.at(-1) ?? "", output, OPENAI, {
    includeItemIds: false,
    sourceProtocol: "openai_responses",
  });
  const next: InteractionRequest = {
    ...initial,
    items: [
      ...initial.items,
      ...[output.items[2], output.items[0], output.items[1]].map((item) =>
        item.type === "tool_call"
          ? { ...item, id: undefined, input: '{"cmd":"pwd","tty":true,"login":true}' }
          : item.type === "hosted_tool_call"
            ? item
          : { ...item, id: undefined }
      ),
      {
        type: "tool_result",
        callId: "call_3",
        kind: "function",
        name: "exec_command",
        output: "/repo",
        outputShape: "string",
      },
    ],
  };
  const nextChain = interactionPrefixChain("rtr_1", next, OPENAI);
  expect(extension).toHaveLength(1);
  expect(nextChain[initialChain.length + extension.length - 1]).toBe(extension.at(-1) ?? "");
  expect(nextChain).toHaveLength(3);
});
