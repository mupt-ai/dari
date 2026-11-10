import { expect, test } from "bun:test";

import { buildContext } from "../../providers/pi_context.js";
import { anthropicMessagesToInteraction } from "./anthropic_messages.js";
import { encodeProviderContinuationState } from "../../interaction/provider_continuation_state.js";
import { encodePortableReasoningState } from "../../interaction/portable_reasoning_state.js";
import type { ProviderIdentity } from "../../interaction/types.js";

const CLAUDE: ProviderIdentity = {
  provider: "anthropic",
  api: "anthropic-messages",
  model: "claude-sonnet-4-6",
};

test("Anthropic Messages ingress preserves images, thinking state, tools, and tool-result errors", () => {
  const signature = encodeProviderContinuationState({
    kind: "anthropic_thinking",
    source: CLAUDE,
    thinking: "Inspect the image.",
    signature: "native-claude-signature",
  });
  const request = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    stream: true,
    system: [
      { type: "text", text: "You are a coding agent.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Use tools carefully." },
    ],
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    tools: [
      {
        name: "inspect_image",
        description: "Inspect an image",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is shown?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Inspect the image.", signature },
          { type: "text", text: "I will inspect it." },
          { type: "tool_use", id: "toolu_123", name: "inspect_image", input: { path: "shot.png" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_123",
            is_error: true,
            content: [
              { type: "text", text: "retry" },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "cmVzdWx0" } },
            ],
          },
          { type: "text", text: "Try again." },
        ],
      },
    ],
  });

  expect(request).toMatchObject({
    sourceProtocol: "anthropic_messages",
    model: "dari/routing",
    instructions: "You are a coding agent.\n\nUse tools carefully.",
    stream: true,
    parallelToolCalls: false,
    generation: { maxOutputTokens: 4096 },
    reasoning: { effort: "high", enabled: true },
    toolChoice: "auto",
    tools: [{ kind: "function", name: "inspect_image" }],
  });
  expect(request.items).toEqual([
    {
      type: "message",
      role: "user",
      content: [
        { type: "text", text: "What is shown?" },
        { type: "image", url: "data:image/png;base64,aW1hZ2U=" },
      ],
      contentShape: "parts",
    },
    {
      type: "reasoning",
      summary: ["Inspect the image."],
      content: [],
      source: CLAUDE,
      continuation: {
        kind: "anthropic_thinking",
        source: CLAUDE,
        thinking: "Inspect the image.",
        signature: "native-claude-signature",
      },
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "I will inspect it." }],
      contentShape: "parts",
    },
    {
      type: "tool_call",
      callId: "toolu_123",
      kind: "function",
      name: "inspect_image",
      input: { path: "shot.png" },
      status: "completed",
    },
    {
      type: "tool_result",
      callId: "toolu_123",
      kind: "function",
      output: [
        { type: "text", text: "retry" },
        { type: "image", url: "data:image/jpeg;base64,cmVzdWx0" },
      ],
      outputShape: "parts",
      isError: true,
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "text", text: "Try again." }],
      contentShape: "parts",
    },
  ]);
});

test("Anthropic Messages ingress preserves Claude Code interactive system messages", () => {
  const request = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    system: "You are Claude Code.",
    messages: [
      {
        role: "system",
        content: [{ type: "text", text: "Follow the repository instructions." }],
      },
      {
        role: "user",
        content: "Inspect the repository.",
      },
    ],
  });

  expect(request.instructions).toBe("You are Claude Code.");
  expect(request.items).toEqual([
    {
      type: "message",
      role: "system",
      content: [{ type: "text", text: "Follow the repository instructions." }],
      contentShape: "parts",
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "text", text: "Inspect the repository." }],
      contentShape: "string",
    },
  ]);
});

test("Anthropic Messages ingress preserves an explicit thinking budget", () => {
  const request = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    thinking: { type: "enabled", budget_tokens: 12_345 },
    messages: [{ role: "user", content: "Think carefully." }],
  });

  expect(request.reasoning).toEqual({
    enabled: true,
    budgetTokens: 12_345,
  });
});

test("Anthropic Messages ingress preserves output effort when thinking is disabled", () => {
  const request = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    thinking: { type: "disabled" },
    output_config: { effort: "high" },
    messages: [{ role: "user", content: "hello" }],
  });

  expect(request.reasoning).toEqual({ effort: "high", enabled: false });
});

test("Anthropic Messages ingress preserves router-generated portable thinking", () => {
  const signature = encodePortableReasoningState({ source: CLAUDE, itemId: "reasoning_1" });
  const request = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    messages: [{
      role: "assistant",
      content: [{ type: "thinking", thinking: "Portable thought.", signature }],
    }],
  });

  expect(request.items).toEqual([{
    type: "reasoning",
    summary: ["Portable thought."],
    content: [],
    source: CLAUDE,
  }]);
});

test("Anthropic Messages ingress rejects raw thinking state without provider provenance", () => {
  for (const content of [
    { type: "thinking", thinking: "Native thought.", signature: "provider-native-signature" },
    { type: "redacted_thinking", data: "provider-native-redacted-state" },
  ]) {
    expect(() => anthropicMessagesToInteraction({
      model: "dari/routing",
      max_tokens: 4096,
      messages: [{ role: "assistant", content: [content] }],
    })).toThrow("must be a Dari reasoning-state envelope");
  }
});

test("Anthropic Messages ingress accepts supported native tool declarations", () => {
  const tools = [
    ["bash_20250124", "bash"],
    ["text_editor_20250124", "text_editor"],
    ["tool_search_tool_regex_20251119", "tool_search_tool_regex"],
  ] as const;
  const request = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 100,
    messages: [{ role: "user", content: "hello" }],
    tools: tools.map(([type, name]) => ({ type, name })),
  });

  expect(request.tools).toEqual([
    { kind: "client_tool", type: "bash_20250124", name: "bash" },
    { kind: "client_tool", type: "text_editor_20250124", name: "text_editor" },
    { kind: "server_tool", type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
  ]);
});

test("Anthropic Messages ingress rejects image transports the provider bridge cannot preserve", () => {
  expect(() => anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 100,
    messages: [{
      role: "user",
      content: [{ type: "image", source: { type: "url", url: "https://example.com/image.png" } }],
    }],
  })).toThrow("use a base64 image source");
});

test("Anthropic Messages ingress accepts every Anthropic effort spelling", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    const request = anthropicMessagesToInteraction({
      model: "dari/routing",
      max_tokens: 100,
      thinking: { type: "adaptive" },
      output_config: { effort },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(request.reasoning).toEqual({ effort, enabled: true });
  }
});

test("Anthropic Messages ingress rejects non-Anthropic effort spellings", () => {
  expect(() => anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 100,
    output_config: { effort: "minimal" },
    messages: [{ role: "user", content: "hello" }],
  })).toThrow("Unsupported Anthropic effort 'minimal'");
});

test("Anthropic Messages ingress preserves tool_reference blocks and tracks loadedTools", () => {
  const request = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect the repo." },
          { type: "tool_use", id: "toolu_123", name: "search_repos", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_123",
            content: [
              { type: "text", text: "Found 2 repos." },
              { type: "tool_reference", tool_name: "repo_alpha" },
              { type: "tool_reference", tool_name: "repo_beta" },
            ],
          },
        ],
      },
    ],
  });

  const toolResult = request.items.find((item) => item.type === "tool_result");
  expect(toolResult).toBeDefined();
  expect(toolResult!.output).toEqual([
    { type: "text", text: "Found 2 repos." },
    { type: "tool_reference", toolName: "repo_alpha" },
    { type: "tool_reference", toolName: "repo_beta" },
  ]);
  expect(toolResult).toMatchObject({ loadedTools: ["repo_alpha", "repo_beta"] });
});

test("Anthropic Messages ingress rejects malformed tool_reference blocks", () => {
  for (const badBlock of [
    { type: "tool_reference" },
    { type: "tool_reference", tool_name: "" },
    { type: "tool_reference", tool_name: 42 },
    { type: "tool_reference", tool_name: null },
  ]) {
    expect(() => anthropicMessagesToInteraction({
      model: "dari/routing",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: [
                { type: "text", text: "result" },
                badBlock,
              ],
            },
          ],
        },
      ],
    })).toThrow("tool_name must be a non-empty string");
  }
});

test("Anthropic Messages ingress rejects tool_reference blocks as top-level content", () => {
  expect(() => anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          { type: "tool_reference", tool_name: "x" },
        ],
      },
    ],
  })).toThrow("Anthropic content block type 'tool_reference' is not supported");
});

test("Anthropic Messages ingress keys the provider cache by Claude Code session id", () => {
  const request = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 128,
    metadata: {
      user_id: JSON.stringify({
        device_id: "device-shared-across-conversations",
        account_uuid: "",
        session_id: "a6251bd4-14d9-49ce-ad66-26cfafd2543a",
      }),
    },
    messages: [{ role: "user", content: "hello" }],
  });
  expect(request.promptCacheKey).toBe("a6251bd4-14d9-49ce-ad66-26cfafd2543a");
});

test("Anthropic Messages ingress ignores a metadata user_id carrying no session", () => {
  for (const userId of ["plain-account-identifier", JSON.stringify({ device_id: "d" })]) {
    const request = anthropicMessagesToInteraction({
      model: "dari/routing",
      max_tokens: 128,
      metadata: { user_id: userId },
      messages: [{ role: "user", content: "hello" }],
    });
    expect(request.user).toBe(userId);
    expect(request.promptCacheKey).toBeUndefined();
  }
});

// —— Router model synonyms ————————————————————————————————————————————
// Anthropic-SDK clients (Claude Desktop / Cowork) only treat tier-shaped ids
// as usable, so the Messages gate accepts every Claude family tier as a
// synonym for dari/routing. The alias carries no routing meaning.

const MINIMAL_MESSAGES_PAYLOAD = {
  max_tokens: 64,
  messages: [{ role: "user", content: "ping" }],
};

test("Messages gate accepts dari/routing and every Claude family tier as synonyms", () => {
  for (const model of ["dari/routing", "mythos", "opus", "fable", "sonnet", "haiku"]) {
    const request = anthropicMessagesToInteraction({ ...MINIMAL_MESSAGES_PAYLOAD, model });
    expect(request.model).toBe(model);
  }
});

test("Messages gate accepts concrete Claude-family ids as synonyms", () => {
  for (const model of [
    "claude-opus-5",
    "claude-sonnet-4-5",
    "claude-haiku-4-5-20251001",
    "anthropic/claude-fable-5",
  ]) {
    const request = anthropicMessagesToInteraction({ ...MINIMAL_MESSAGES_PAYLOAD, model });
    expect(request.model).toBe(model);
  }
});

test("Messages gate still rejects models that are neither canonical, a tier, nor Claude-family", () => {
  for (const model of ["gpt-4o", "dari-routing", "Sonnet", "claudius-1", "claude-", "openai/claude-opus-5", ""]) {
    expect(() => anthropicMessagesToInteraction({ ...MINIMAL_MESSAGES_PAYLOAD, model })).toThrow(
      /Only model 'dari\/routing' is supported|model/
    );
  }
});

// Hosted results and computer display configuration are not preserved by the adapter.
test.each([
  ["web_search_20250305", "web_search"],
  ["web_fetch_20250910", "web_fetch"],
  ["code_execution_20250522", "code_execution"],
  ["computer_20250124", "computer"],
  ["unknown_20250101", "unknown"],
])("Anthropic Messages ingress rejects unsupported native tool %s", (type, name) => {
  expect(() => anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 100,
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type, name }],
  })).toThrow(`tool type '${type}' is not supported`);
});

test.each([
  ["bash_20250124", "bash"],
  ["text_editor_20250124", "text_editor"],
])("native client tool %s preserves declarations and result history", (type, name) => {
  const request = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 100,
    tools: [{ type, name }],
    messages: [
      { role: "user", content: "Run the tool" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_native", name, input: { command: "test" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_native", content: "done" }] },
    ],
  });
  const context = buildContext(request, CLAUDE);
  expect(context.tools).toEqual([{ type, name, serverTool: true }]);
  expect(context.messages).toMatchObject([
    { role: "user" },
    { role: "assistant", content: [{ type: "toolCall", id: "toolu_native", name, arguments: { command: "test" } }] },
    { role: "toolResult", toolCallId: "toolu_native", content: [{ type: "text", text: "done" }] },
  ]);
});
