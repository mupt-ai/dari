import { expect, test } from "bun:test";

import { piMessageToInteractionOutput } from "./pi_output.js";
import type { InteractionRequest, ProviderIdentity } from "../interaction/types.js";
import { buildContext } from "./pi_context.js";

const OPENAI: ProviderIdentity = { provider: "openai", api: "openai-responses", model: "gpt-5.5" };
const AZURE: ProviderIdentity = { provider: "azure", api: "azure-openai-responses", model: "gpt-5.5" };
const CODEX: ProviderIdentity = { provider: "openai-codex", api: "openai-codex-responses", model: "gpt-5.6-luna" };
const CLAUDE: ProviderIdentity = { provider: "anthropic", api: "anthropic-messages", model: "claude-sonnet-4-6" };

test("lifts empty provider output as a canonical assistant message", () => {
  const output = piMessageToInteractionOutput(
    { responseId: "resp_empty", stopReason: "stop", content: [] },
    OPENAI,
    request({})
  );

  expect(output.items).toEqual([
    {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      contentShape: "parts",
      source: OPENAI,
    },
  ]);
});

test("lifts ordered OpenAI reasoning text and tool calls with native IDs", () => {
  const output = piMessageToInteractionOutput(
    {
      responseId: "resp_123",
      timestamp: 1_700_000_000_000,
      stopReason: "toolUse",
      usage: {
        input: 10,
        output: 4,
        cacheRead: 8,
        cacheWrite: 2,
        totalTokens: 24,
        cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0.4, total: 3.6 },
      },
      content: [
        {
          type: "thinking",
          thinking: "Readable fallback.",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            id: "rs_123",
            summary: [{ type: "summary_text", text: "Inspect the file." }],
            content: [{ type: "reasoning_text", text: "Private detail." }],
            encrypted_content: "opaque-openai-state",
          }),
        },
        {
          type: "text",
          text: "I will patch it.",
          textSignature: JSON.stringify({ v: 1, id: "msg_123", phase: "commentary" }),
        },
        {
          type: "toolCall",
          id: "call_123|fc_123",
          name: "repo__read_file",
          arguments: { path: "README.md" },
        },
      ],
    },
    OPENAI,
    request({
      tools: [
        {
          kind: "function",
          namespace: "repo",
          name: "read_file",
          parameters: { type: "object" },
        },
      ],
    })
  );

  expect(output).toEqual({
    responseId: "resp_123",
    createdAtMs: 1_700_000_000_000,
    source: OPENAI,
    items: [
      {
        type: "reasoning",
        id: "rs_123",
        summary: ["Inspect the file."],
        content: ["Private detail."],
        source: OPENAI,
        continuation: {
          kind: "openai_reasoning",
          source: OPENAI,
          encryptedContent: "opaque-openai-state",
          providerItemId: "rs_123",
        },
      },
      {
        type: "message",
        id: "msg_123",
        role: "assistant",
        content: [{ type: "text", text: "I will patch it." }],
        contentShape: "parts",
        phase: "commentary",
        source: OPENAI,
      },
      {
        type: "tool_call",
        id: "fc_123",
        callId: "call_123",
        kind: "function",
        namespace: "repo",
        name: "read_file",
        input: { path: "README.md" },
        status: "completed",
      },
    ],
    usage: {
      input: 10,
      output: 4,
      cacheRead: 8,
      cacheWrite: 2,
      totalTokens: 24,
      cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0.4, total: 3.6 },
    },
    stopReason: "tool_use",
  });
});

test("normalizes cache-inclusive OpenAI usage from Bedrock", () => {
  const bedrock: ProviderIdentity = {
    provider: "amazon-bedrock",
    api: "bedrock-converse-stream",
    model: "us.openai.gpt-5.6-sol",
  };
  const output = piMessageToInteractionOutput(
    {
      stopReason: "stop",
      content: [{ type: "text", text: "Done." }],
      usage: {
        input: 104_048,
        output: 795,
        cacheRead: 102_770,
        cacheWrite: 1_157,
        totalTokens: 208_770,
        cost: {
          input: 0.416192,
          output: 0.0159,
          cacheRead: 0.041108,
          cacheWrite: 0.005785,
          total: 0.478985,
        },
      },
    },
    bedrock,
    request({})
  );

  expect(output.usage).toEqual({
    input: 121,
    output: 795,
    cacheRead: 102_770,
    cacheWrite: 1_157,
    totalTokens: 104_843,
    cost: {
      input: 0.000484,
      output: 0.0159,
      cacheRead: 0.041108,
      cacheWrite: 0.005785,
      total: 0.063277,
    },
  });
});

test("keeps cache-exclusive Claude usage unchanged through Bedrock", () => {
  const bedrock: ProviderIdentity = {
    provider: "amazon-bedrock",
    api: "bedrock-converse-stream",
    model: "global.anthropic.claude-sonnet-5",
  };
  const output = piMessageToInteractionOutput(
    {
      stopReason: "stop",
      content: [{ type: "text", text: "Done." }],
      usage: {
        input: 104_048,
        output: 795,
        cacheRead: 102_770,
        cacheWrite: 1_157,
        totalTokens: 104_843,
        cost: {
          input: 0.52024,
          output: 0.019875,
          cacheRead: 0.051385,
          cacheWrite: 0.00723125,
          total: 0.59873125,
        },
      },
    },
    bedrock,
    request({})
  );

  expect(output.usage).toEqual({
    input: 104_048,
    output: 795,
    cacheRead: 102_770,
    cacheWrite: 1_157,
    totalTokens: 104_843,
    cost: {
      input: 0.52024,
      output: 0.019875,
      cacheRead: 0.051385,
      cacheWrite: 0.00723125,
      total: 0.59873125,
    },
  });
});

test("keeps thinking signatures from Claude served through Bedrock", () => {
  const bedrock: ProviderIdentity = {
    provider: "amazon-bedrock",
    api: "bedrock-converse-stream",
    model: "global.anthropic.claude-sonnet-5",
  };
  const output = piMessageToInteractionOutput(
    {
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "Check the patch.", thinkingSignature: "bedrock-signature" },
        { type: "text", text: "Done." },
      ],
    },
    bedrock,
    request({})
  );

  expect(output.items[0]).toEqual({
    type: "reasoning",
    summary: ["Check the patch."],
    content: [],
    source: bedrock,
    continuation: {
      kind: "anthropic_thinking",
      source: bedrock,
      thinking: "Check the patch.",
      signature: "bedrock-signature",
    },
  });
});

test("lifts custom tool input and Anthropic thinking state", () => {
  const output = piMessageToInteractionOutput(
    {
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "Check the patch.", thinkingSignature: "claude-signature" },
        { type: "toolCall", id: "toolu_123", name: "apply_patch", arguments: { input: "*** Begin Patch" } },
        { type: "thinking", thinking: "", thinkingSignature: "redacted-state", redacted: true },
      ],
    },
    CLAUDE,
    request({
      tools: [{ kind: "custom", name: "apply_patch" }],
    })
  );

  expect(output.items).toEqual([
    {
      type: "reasoning",
      summary: ["Check the patch."],
      content: [],
      source: CLAUDE,
      continuation: {
        kind: "anthropic_thinking",
        source: CLAUDE,
        thinking: "Check the patch.",
        signature: "claude-signature",
      },
    },
    {
      type: "tool_call",
      callId: "toolu_123",
      kind: "custom",
      name: "apply_patch",
      input: "*** Begin Patch",
      status: "completed",
    },
    {
      type: "reasoning",
      summary: [],
      content: [],
      source: CLAUDE,
      continuation: { kind: "anthropic_redacted_thinking", source: CLAUDE, data: "redacted-state" },
    },
  ]);
});

test("lifts raw OpenAI hosted search calls and citation annotations without loss", () => {
  const searchCall = {
    type: "web_search_call",
    id: "ws_123",
    status: "completed",
    action: {
      type: "search",
      queries: ["OpenAI Responses web search"],
      sources: [{ type: "url", url: "https://developers.openai.com/api/docs/guides/tools-web-search" }],
    },
    results: [{ type: "image_result", image_url: "https://example.test/image.png" }],
  };
  const citation = {
    type: "url_citation",
    start_index: 20,
    end_index: 23,
    url: "https://developers.openai.com/api/docs/guides/tools-web-search",
    title: "Web search",
  };
  const output = piMessageToInteractionOutput(
    {
      stopReason: "stop",
      responseId: "resp_123",
      usage: {
        input: 10,
        output: 5,
        totalTokens: 15,
        cost: { input: 1, output: 2, total: 3 },
      },
      providerResponse: {
        id: "resp_123",
        created_at: 1_750_000_000,
        status: "completed",
        output: [
          {
            type: "reasoning",
            id: "rs_123",
            summary: [{ type: "summary_text", text: "Search the docs." }],
            encrypted_content: "opaque-reasoning",
          },
          searchCall,
          {
            type: "message",
            id: "msg_123",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "The docs explain it.[1]", annotations: [citation] }],
          },
        ],
      },
    },
    OPENAI,
    request({ tools: [{ kind: "hosted", type: "web_search", config: { type: "web_search" } }] })
  );

  expect(output.responseId).toBe("resp_123");
  expect(output.createdAtMs).toBe(1_750_000_000_000);
  expect(output.items).toMatchObject([
    {
      type: "reasoning",
      id: "rs_123",
      continuation: {
        kind: "openai_reasoning",
        encryptedContent: "opaque-reasoning",
        hostedToolCallIds: ["ws_123"],
        hostedToolCallOffsets: [1],
      },
    },
    {
      type: "hosted_tool_call",
      id: "ws_123",
      payload: searchCall,
    },
    {
      type: "message",
      id: "msg_123",
      content: [{ type: "text", text: "The docs explain it.[1]", annotations: [citation] }],
    },
  ]);
  expect(output.usage.cost.total).toBe(3);
});

test("lifts raw Azure Responses provider output without falling back to lossy Pi blocks", () => {
  const output = piMessageToInteractionOutput(
    {
      stopReason: "stop",
      providerResponse: {
        id: "resp_azure",
        output: [{ type: "web_search_call", id: "ws_azure", status: "completed" }],
      },
    },
    AZURE,
    request({ tools: [{ kind: "hosted", type: "web_search", config: { type: "web_search" } }] })
  );

  expect(output.items).toEqual([{
    type: "hosted_tool_call",
    id: "ws_azure",
    tool: "web_search",
    providerType: "web_search_call",
    status: "completed",
    payload: { type: "web_search_call", id: "ws_azure", status: "completed" },
    source: AZURE,
  }]);
});

test("carries each hosted search ID on its sequential reasoning group", () => {
  const output = piMessageToInteractionOutput(
    {
      stopReason: "stop",
      providerResponse: {
        id: "resp_split_search",
        output: [
          { type: "web_search_call", id: "ws_leading", status: "completed" },
          { type: "reasoning", id: "rs_first", summary: [], encrypted_content: "opaque-first" },
          {
            type: "message",
            id: "msg_between",
            role: "assistant",
            content: [{ type: "output_text", text: "Still searching.", annotations: [] }],
          },
          { type: "web_search_call", id: "ws_middle", status: "completed" },
          { type: "reasoning", id: "rs_second", summary: [], encrypted_content: "opaque-second" },
          { type: "web_search_call", id: "ws_trailing", status: "completed" },
        ],
      },
    },
    OPENAI,
    request({ tools: [{ kind: "hosted", type: "web_search", config: { type: "web_search" } }] })
  );

  const continuations = output.items.flatMap((item) =>
    item.type === "reasoning" && item.continuation?.kind === "openai_reasoning" ? [item.continuation] : []
  );
  expect(continuations).toMatchObject([
    {
      providerItemId: "rs_first",
      hostedToolCallIds: ["ws_leading", "ws_middle"],
      hostedToolCallOffsets: [-1, 2],
    },
    {
      providerItemId: "rs_second",
      hostedToolCallIds: ["ws_trailing"],
      hostedToolCallOffsets: [1],
    },
  ]);
});

test("rejects malformed Pi output instead of silently dropping blocks", () => {
  expect(() =>
    piMessageToInteractionOutput(
      { stopReason: "stop", content: [{ type: "toolCall", name: "read_file", arguments: {} }] },
      OPENAI,
      request({})
    )
  ).toThrow("tool call ID is missing");
});

test("rejects provider tool-call IDs that cannot round-trip through ingress", () => {
  expect(() =>
    piMessageToInteractionOutput(
      {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: `${"c".repeat(513)}|fc_oversized`,
            name: "read_file",
            arguments: {},
          },
        ],
      },
      OPENAI,
      request({})
    )
  ).toThrow("Provider output tool call ID must be a non-empty string no longer than 512 characters");
});

function request(overrides: Partial<InteractionRequest>): InteractionRequest {
  return {
    sourceProtocol: "openai_responses",
    items: [],
    tools: [],
    generation: {},
    stream: false,
    ...overrides,
  };
}

test("keeps encrypted reasoning from the ChatGPT-subscription Codex transport and replays it", () => {
  const signature = JSON.stringify({
    type: "reasoning",
    id: "rs_codex",
    summary: [{ type: "summary_text", text: "Plan the edit." }],
    encrypted_content: "opaque-codex-state",
  });
  const output = piMessageToInteractionOutput(
    {
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "Plan the edit.", thinkingSignature: signature },
        { type: "toolCall", id: "call_1|fc_1", name: "read_file", arguments: { path: "a.ts" } },
      ],
    },
    CODEX,
    request({})
  );

  expect(output.items[0]).toEqual({
    type: "reasoning",
    id: "rs_codex",
    summary: ["Plan the edit."],
    content: [],
    source: CODEX,
    continuation: {
      kind: "openai_reasoning",
      source: CODEX,
      encryptedContent: "opaque-codex-state",
      providerItemId: "rs_codex",
    },
  });

  const context = buildContext(request({ items: output.items }), CODEX) as {
    messages: Array<{ content: Array<Record<string, unknown>> }>;
  };
  const thinking = context.messages[0]?.content.find((block) => block.type === "thinking");
  expect(JSON.parse(String(thinking?.thinkingSignature))).toMatchObject({
    id: "rs_codex",
    encrypted_content: "opaque-codex-state",
  });
});
