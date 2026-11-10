import type {
  InteractionOutput,
  InteractionRequest,
  ProviderIdentity,
} from "../interaction/types.js";

export const OPENAI: ProviderIdentity = {
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.5",
};

export const CLAUDE: ProviderIdentity = {
  provider: "anthropic",
  api: "anthropic-messages",
  model: "claude-sonnet-4-6",
};

export function request(encryptedContent = "opaque-a"): InteractionRequest {
  return {
    sourceProtocol: "openai_responses",
    items: [
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Inspect this." }],
        contentShape: "parts",
      },
      {
        type: "reasoning",
        id: "rs_1",
        summary: ["I inspected it."],
        content: [],
        continuation: {
          kind: "openai_reasoning",
          source: OPENAI,
          encryptedContent,
        },
      },
      {
        type: "tool_call",
        id: "fc_1",
        callId: "call_1",
        kind: "function",
        name: "read_file",
        input: '{"path":"a.ts"}',
      },
      {
        type: "tool_result",
        callId: "call_1",
        kind: "function",
        name: "read_file",
        output: "contents",
        outputShape: "string",
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Continue." }],
        contentShape: "parts",
      },
    ],
    tools: [
      {
        kind: "function",
        name: "read_file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ],
    generation: {},
    stream: true,
  };
}

export function interactionOutput(
  items: InteractionOutput["items"]
): InteractionOutput {
  return {
    responseId: "resp_chat",
    createdAtMs: 1,
    source: OPENAI,
    items,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "tool_use",
  };
}
