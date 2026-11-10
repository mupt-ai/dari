import { expect, test } from "bun:test";

import type { InteractionRequest, ProviderIdentity } from "../interaction/types.js";
import { buildContext } from "./pi_context.js";

const OPENAI_GPT_55: ProviderIdentity = {
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.5",
};
const OPENAI_GPT_54: ProviderIdentity = {
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.4",
};
const OPENAI_CODEX_GPT_56_SOL: ProviderIdentity = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  model: "gpt-5.6-sol",
};
const AZURE_GPT_55: ProviderIdentity = {
  provider: "azure",
  api: "azure-openai-responses",
  model: "gpt-5.5",
};
const CLAUDE: ProviderIdentity = {
  provider: "anthropic",
  api: "anthropic-messages",
  model: "claude-sonnet-4-6",
};
const FIREWORKS: ProviderIdentity = {
  provider: "fireworks",
  api: "openai-completions",
  model: "accounts/fireworks/models/deepseek-v4-flash",
};

test("restores OpenAI reasoning only for its exact provider API and model", () => {
  const request = interaction({
    items: [
      {
        type: "reasoning",
        id: "rs_client_stream",
        summary: ["Checked the repository."],
        content: ["Private reasoning text."],
        continuation: {
          kind: "openai_reasoning",
          source: OPENAI_GPT_55,
          encryptedContent: "encrypted-openai-state",
          providerItemId: "rs_123",
        },
      },
      {
        type: "tool_call",
        id: "fc_123",
        callId: "call_123",
        kind: "function",
        name: "read_file",
        input: { path: "README.md" },
      },
      {
        type: "tool_result",
        callId: "call_123",
        kind: "function",
        name: "read_file",
        output: "contents",
        outputShape: "string",
        isError: true,
      },
    ],
  });

  const context = buildContext(request, OPENAI_GPT_55);
  const messages = context.messages as Array<Record<string, unknown>>;
  expect(messages[0]).toMatchObject({
    role: "assistant",
    provider: "openai",
    api: "openai-responses",
    model: "gpt-5.5",
    content: [
      { type: "thinking", thinking: "Checked the repository.\nPrivate reasoning text." },
      { type: "toolCall", id: "call_123|fc_123", name: "read_file", arguments: { path: "README.md" } },
    ],
  });
  const thinking = (messages[0].content as Array<Record<string, unknown>>)[0];
  expect(JSON.parse(thinking.thinkingSignature as string)).toEqual({
    type: "reasoning",
    id: "rs_123",
    summary: [{ type: "summary_text", text: "Checked the repository." }],
    content: [{ type: "reasoning_text", text: "Private reasoning text." }],
    encrypted_content: "encrypted-openai-state",
  });
  expect(messages[1]).toMatchObject({
    role: "toolResult",
    toolCallId: "call_123|fc_123",
    toolName: "read_file",
    isError: true,
  });

  const switched = buildContext(request, OPENAI_GPT_54);
  const switchedAssistant = (switched.messages as Array<Record<string, unknown>>)[0];
  expect(switchedAssistant).toMatchObject({
    role: "assistant",
    provider: "openai",
    api: "openai-responses",
    model: "gpt-5.5",
    content: [
      { type: "text", text: "Checked the repository.\nPrivate reasoning text." },
      { type: "toolCall", id: "call_123|fc_123" },
    ],
  });
  expect(JSON.stringify(switched)).not.toContain("encrypted-openai-state");
});

test("coalesces Codex tool-call-first history with later Anthropic reasoning", () => {
  const items: InteractionRequest["items"] = [
    {
      type: "tool_call",
      id: "toolu_123",
      callId: "toolu_123",
      kind: "function",
      name: "exec_command",
      input: { cmd: "pwd" },
    },
    {
      type: "reasoning",
      summary: ["Run the requested command."],
      content: [],
      continuation: {
        kind: "anthropic_thinking",
        source: CLAUDE,
        thinking: "Run the requested command.",
        signature: "anthropic-signature",
      },
    },
    {
      type: "tool_result",
      callId: "toolu_123",
      kind: "function",
      name: "exec_command",
      output: "done",
      outputShape: "string",
    },
  ];
  const context = buildContext(interaction({ items }), CLAUDE);

  expect(context.messages).toMatchObject([
    {
      role: "assistant",
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-sonnet-4-6",
      content: [
        {
          type: "thinking",
          thinking: "Run the requested command.",
          thinkingSignature: "anthropic-signature",
        },
        { type: "toolCall", id: "toolu_123", name: "exec_command", arguments: { cmd: "pwd" } },
      ],
    },
    { role: "toolResult", toolCallId: "toolu_123", toolName: "exec_command" },
  ]);

  const switched = buildContext(interaction({ items }), OPENAI_GPT_55);
  expect(JSON.stringify(switched)).not.toContain("anthropic-signature");
  expect(switched.messages).toMatchObject([
    {
      role: "assistant",
      content: [
        { type: "text", text: "Run the requested command." },
        { type: "toolCall", id: "toolu_123|toolu_123", name: "exec_command" },
      ],
    },
    { role: "toolResult", toolCallId: "toolu_123|toolu_123" },
  ]);
});

test("restores Anthropic thinking and redacted state only for the exact Claude target", () => {
  const request = interaction({
    items: [
      {
        type: "reasoning",
        summary: ["Readable summary."],
        content: [],
        continuation: {
          kind: "anthropic_thinking",
          source: CLAUDE,
          thinking: "Exact Claude thinking.",
          signature: "anthropic-signature",
        },
      },
      {
        type: "reasoning",
        summary: [],
        content: [],
        continuation: {
          kind: "anthropic_redacted_thinking",
          source: CLAUDE,
          data: "redacted-anthropic-state",
        },
      },
    ],
  });

  const exact = buildContext(request, CLAUDE);
  expect(exact.messages).toMatchObject([
    {
      role: "assistant",
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-sonnet-4-6",
      content: [
        {
          type: "thinking",
          thinking: "Exact Claude thinking.",
          thinkingSignature: "anthropic-signature",
        },
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: "redacted-anthropic-state",
          redacted: true,
        },
      ],
    },
  ]);

  const foreign = buildContext(request, OPENAI_GPT_55);
  expect(foreign.messages).toMatchObject([
    {
      role: "assistant",
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Readable summary." }],
    },
  ]);
  expect(JSON.stringify(foreign)).not.toContain("anthropic-signature");
  expect(JSON.stringify(foreign)).not.toContain("redacted-anthropic-state");
});

test("keeps foreign state dormant across Claude to GPT to Claude conversion", () => {
  const request = interaction({
    items: [
      {
        type: "reasoning",
        summary: ["Claude summary survives as readable context."],
        content: [],
        continuation: {
          kind: "anthropic_thinking",
          source: CLAUDE,
          thinking: "Claude private state.",
          signature: "claude-roundtrip-signature",
        },
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Claude answer." }],
        contentShape: "parts",
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Continue." }],
        contentShape: "parts",
      },
    ],
  });

  const duringGpt = buildContext(request, OPENAI_GPT_55);
  expect(JSON.stringify(duringGpt)).not.toContain("claude-roundtrip-signature");
  expect(JSON.stringify(duringGpt)).toContain("Claude summary survives as readable context.");

  const backToClaude = buildContext(request, CLAUDE);
  expect(JSON.stringify(backToClaude)).toContain("claude-roundtrip-signature");
  expect(JSON.stringify(backToClaude)).toContain("Claude private state.");
});

test("keeps foreign state dormant across GPT to Claude to GPT conversion", () => {
  const request = interaction({
    items: [
      {
        type: "reasoning",
        id: "rs_roundtrip",
        summary: ["OpenAI summary survives as readable context."],
        content: [],
        continuation: {
          kind: "openai_reasoning",
          source: OPENAI_GPT_55,
          encryptedContent: "openai-roundtrip-state",
        },
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "OpenAI answer." }],
        contentShape: "parts",
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Continue." }],
        contentShape: "parts",
      },
    ],
  });

  const duringClaude = buildContext(request, CLAUDE);
  expect(JSON.stringify(duringClaude)).not.toContain("openai-roundtrip-state");
  expect(JSON.stringify(duringClaude)).toContain("OpenAI summary survives as readable context.");

  const backToGpt = buildContext(request, OPENAI_GPT_55);
  expect(JSON.stringify(backToGpt)).toContain("openai-roundtrip-state");
});

test("does not replay continuation state through a mismatched provider API", () => {
  const request = interaction({
    items: [
      {
        type: "reasoning",
        summary: ["Safe readable context."],
        content: [],
        continuation: {
          kind: "openai_reasoning",
          source: { ...OPENAI_GPT_55, api: "openai-completions" },
          encryptedContent: "wrong-api-state",
        },
      },
    ],
  });

  const context = buildContext(request, { ...OPENAI_GPT_55, api: "openai-completions" });
  expect(JSON.stringify(context)).not.toContain("wrong-api-state");
  expect(JSON.stringify(context)).toContain("Safe readable context.");
});

test("keeps a visible boundary between portable reasoning and Fireworks assistant text", () => {
  const context = buildContext(
    interaction({
      items: [
        {
          type: "reasoning",
          summary: ["Portable reasoning."],
          content: [],
          continuation: {
            kind: "anthropic_thinking",
            source: CLAUDE,
            thinking: "Private Claude state.",
            signature: "claude-signature",
          },
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Assistant answer." }],
          contentShape: "parts",
          source: CLAUDE,
        },
      ],
    }),
    FIREWORKS
  );
  const assistant = (context.messages as Array<Record<string, unknown>>)[0];

  expect(assistant.content).toEqual([
    { type: "text", text: "Portable reasoning.\n\n" },
    { type: "text", text: "Assistant answer." },
  ]);
  expect(JSON.stringify(context)).not.toContain("claude-signature");
});

test("preserves assistant phase when Responses history omits item ids", () => {
  const context = buildContext(
    interaction({
      items: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Working on it." }],
          contentShape: "parts",
          phase: "commentary",
        },
      ],
    }),
    OPENAI_GPT_55
  );
  const message = (context.messages as Array<Record<string, unknown>>)[0];
  const text = (message.content as Array<Record<string, unknown>>)[0];

  expect(JSON.parse(text.textSignature as string)).toEqual({
    v: 1,
    id: "msg_dari_0_0",
    phase: "commentary",
  });
});

test("replays hosted web search through OpenAI Responses APIs and preserves citations", () => {
  const request = interaction({
    items: [
      {
        type: "hosted_tool_call",
        id: "ws_1",
        tool: "web_search",
        providerType: "web_search_call",
        status: "completed",
        payload: {
          type: "web_search_call",
          id: "ws_1",
          status: "completed",
          action: { type: "search", query: "OpenAI web search" },
        },
      },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{
          type: "text",
          text: "The docs say so.[1]",
          annotations: [{ type: "url_citation", url: "https://openai.com", title: "OpenAI" }],
        }],
        contentShape: "parts",
      },
    ],
    tools: [
      { kind: "hosted", type: "web_search", config: { type: "web_search" } },
      { kind: "function", name: "exec_command", parameters: { type: "object" } },
    ],
  });

  const openAI = buildContext(request, OPENAI_GPT_55);
  const openAIMessage = (openAI.messages as Array<Record<string, unknown>>)[0];
  expect(openAIMessage.content).toEqual([
    {
      type: "providerItem",
      item: {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: { type: "search", query: "OpenAI web search" },
      },
      name: "providerItem",
      arguments: {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: { type: "search", query: "OpenAI web search" },
      },
    },
    {
      type: "text",
      text: "The docs say so.[1]",
      annotations: [{ type: "url_citation", url: "https://openai.com", title: "OpenAI" }],
      textSignature: JSON.stringify({ v: 1, id: "msg_1" }),
    },
  ]);
  expect(openAI.tools).toEqual([
    {
      name: "exec_command",
      description: "",
      parameters: { type: "object" },
    },
  ]);

  const azure = buildContext(request, AZURE_GPT_55);
  const azureMessage = (azure.messages as Array<Record<string, unknown>>)[0];
  expect(azureMessage.content).toEqual(openAIMessage.content);
  expect(azure.tools).toEqual(openAI.tools);

  const codex = buildContext(request, OPENAI_CODEX_GPT_56_SOL);
  const codexMessage = (codex.messages as Array<Record<string, unknown>>)[0];
  expect(codexMessage.content).toEqual(openAIMessage.content);
  expect(codex.tools).toEqual(openAI.tools);

  const fireworks = buildContext(request, FIREWORKS);
  expect(JSON.stringify(fireworks)).not.toContain("web_search_call");
  expect(JSON.stringify(fireworks)).toContain("The docs say so.[1]");
});

test("rejects malformed function arguments instead of silently replacing them", () => {
  expect(() =>
    buildContext(
      interaction({
        items: [
          {
            type: "tool_call",
            callId: "call_bad",
            kind: "function",
            name: "read_file",
            input: "{not-json",
          },
        ],
      }),
      OPENAI_GPT_55
    )
  ).toThrow("must contain a JSON object");
});

test("lowers loaded tool references without duplicating Anthropic text", () => {
  const request = interaction({
    items: [{
      type: "tool_result",
      callId: "toolu_search",
      kind: "function",
      name: "tool_search",
      output: [
        { type: "tool_reference", toolName: "mcp__linear__get_issue" },
        { type: "text", text: "Tool loaded." },
      ],
      outputShape: "parts",
      loadedTools: ["mcp__linear__get_issue"],
    }],
  });

  expect(buildContext(request, CLAUDE).messages).toMatchObject([{
    role: "toolResult",
    toolCallId: "toolu_search",
    toolName: "tool_search",
    content: [{ type: "text", text: "Tool loaded." }],
    addedToolNames: ["mcp__linear__get_issue"],
  }]);
});

test("keeps loaded tool references readable for providers without native blocks", () => {
  const request = interaction({
    items: [{
      type: "tool_result",
      callId: "toolu_search",
      kind: "function",
      name: "tool_search",
      output: [
        { type: "tool_reference", toolName: "mcp__linear__get_issue" },
        { type: "text", text: "Tool loaded." },
      ],
      outputShape: "parts",
      loadedTools: ["mcp__linear__get_issue"],
    }],
  });

  expect(buildContext(request, FIREWORKS).messages).toMatchObject([{
    role: "toolResult",
    toolCallId: "toolu_search",
    toolName: "tool_search",
    content: [
      { type: "text", text: "Referenced tool: mcp__linear__get_issue" },
      { type: "text", text: "Tool loaded." },
    ],
  }]);
});

test("lowers namespaced and custom Codex tools across provider APIs", () => {
  const request = interaction({
    tools: [
      {
        kind: "function",
        namespace: "mcp__repo",
        name: "read_file",
        description: "Read a file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        kind: "custom",
        name: "apply_patch",
        description: "Apply a patch.",
      },
    ],
    items: [
      {
        type: "tool_call",
        id: "fc_read",
        callId: "call_read",
        kind: "function",
        namespace: "mcp__repo",
        name: "read_file",
        input: { path: "README.md" },
      },
      {
        type: "tool_result",
        callId: "call_read",
        kind: "function",
        output: "contents",
        outputShape: "string",
      },
      {
        type: "tool_call",
        id: "ct_patch",
        callId: "call_patch",
        kind: "custom",
        name: "apply_patch",
        input: "*** Begin Patch\n*** End Patch\n",
      },
      {
        type: "tool_result",
        callId: "call_patch",
        kind: "custom",
        output: "Success.",
        outputShape: "string",
      },
    ],
  });
  const expectedTools = [
    {
      name: "mcp__repo__read_file",
      description: "Read a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "apply_patch",
      description: "Apply a patch.",
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
        additionalProperties: false,
      },
    },
  ];

  const responses = buildContext(request, OPENAI_GPT_55);
  expect(responses.tools).toEqual(expectedTools);
  expect(responses.messages).toMatchObject([
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call_read|fc_read",
        name: "mcp__repo__read_file",
        arguments: { path: "README.md" },
      }],
    },
    {
      role: "toolResult",
      toolCallId: "call_read|fc_read",
      toolName: "mcp__repo__read_file",
    },
    {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call_patch|ct_patch",
        name: "apply_patch",
        arguments: { input: "*** Begin Patch\n*** End Patch\n" },
      }],
    },
    {
      role: "toolResult",
      toolCallId: "call_patch|ct_patch",
      toolName: "apply_patch",
    },
  ]);

  const switched = buildContext(request, FIREWORKS);
  expect(switched.tools).toEqual(expectedTools);
  expect(switched.messages).toMatchObject([
    { role: "assistant", content: [{ type: "toolCall", id: "call_read" }] },
    { role: "toolResult", toolCallId: "call_read", toolName: "mcp__repo__read_file" },
    { role: "assistant", content: [{ type: "toolCall", id: "call_patch" }] },
    { role: "toolResult", toolCallId: "call_patch", toolName: "apply_patch" },
  ]);
});

test("server tools pass through to Anthropic without a description field", () => {
  const request = interaction({
    tools: [
      { kind: "server_tool", type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
      {
        kind: "function",
        name: "get_weather",
        description: "Get the weather.",
        parameters: { type: "object", properties: { city: { type: "string" } } },
        deferLoading: true,
      },
    ],
  });

  const context = buildContext(request, CLAUDE);
  expect(context.tools).toEqual([
    { name: "tool_search_tool_regex", type: "tool_search_tool_regex_20251119", serverTool: true },
    {
      name: "get_weather",
      description: "Get the weather.",
      parameters: { type: "object", properties: { city: { type: "string" } } },
      deferLoading: true,
    },
  ]);

  const fireworks = buildContext(request, FIREWORKS);
  expect((fireworks.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["get_weather"]);
});

test("Anthropic native client tools remain available to non-Anthropic providers", () => {
  const request = interaction({
    tools: [
      { kind: "client_tool", type: "bash_20250124", name: "bash" },
      { kind: "client_tool", type: "text_editor_20250124", name: "text_editor" },
    ],
  });

  const fireworks = buildContext(request, FIREWORKS);
  expect(fireworks.tools).toEqual([
    {
      name: "bash",
      description: "",
      parameters: { type: "object", properties: {}, additionalProperties: true },
    },
    {
      name: "text_editor",
      description: "",
      parameters: { type: "object", properties: {}, additionalProperties: true },
    },
  ]);
});

function interaction(overrides: Partial<InteractionRequest>): InteractionRequest {
  return {
    sourceProtocol: "openai_responses",
    model: "dari/routing",
    items: [],
    tools: [],
    generation: {},
    stream: true,
    ...overrides,
  };
}
