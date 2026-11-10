import { expect, test } from "bun:test";

import { decodeUntrustedProviderContinuationState } from "../../interaction/provider_continuation_state.js";
import type { InteractionOutput, InteractionRequest, ProviderIdentity } from "../../interaction/types.js";
import { openAIResponsesResponse } from "./openai_responses.js";

const OPENAI: ProviderIdentity = { provider: "openai", api: "openai-responses", model: "gpt-5.5" };
const REQUEST: InteractionRequest = {
  sourceProtocol: "openai_responses",
  model: "dari/routing",
  items: [],
  tools: [],
  parallelToolCalls: false,
  generation: {},
  stream: false,
};

test("serializes ordered interaction output with client-carried continuation state", () => {
  const response = openAIResponsesResponse({
    id: "request_123",
    model: "openai/gpt-5.5",
    request: REQUEST,
    routing: {
      selectedModel: "openai/gpt-5.5",
      reasoningEffort: "high",
      reason: "reasoning requested",
    },
    output: interactionOutput({
      responseId: "resp_provider_123",
      items: [
        {
          type: "reasoning",
          id: "rs_123",
          summary: ["Inspect the repository."],
          content: [],
          source: OPENAI,
          continuation: { kind: "openai_reasoning", source: OPENAI, encryptedContent: "provider-ciphertext" },
        },
        {
          type: "message",
          id: "msg_123",
          role: "assistant",
          content: [{ type: "text", text: "Reading the file." }],
          contentShape: "parts",
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
    }),
  });

  const output = response.output as Array<Record<string, unknown>>;
  expect(response.id).toBe("resp_request_123");
  expect(response.parallel_tool_calls).toBe(false);
  expect(output).toMatchObject([
    {
      type: "reasoning",
      id: "rs_123",
      summary: [{ type: "summary_text", text: "Inspect the repository." }],
    },
    {
      type: "message",
      id: "msg_123",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Reading the file.", annotations: [] }],
    },
    {
      type: "function_call",
      id: "fc_123",
      call_id: "call_123",
      namespace: "repo",
      name: "read_file",
      arguments: JSON.stringify({ path: "README.md" }),
      status: "completed",
    },
  ]);
  expect(decodeUntrustedProviderContinuationState(String(output[0].encrypted_content))).toEqual({
    kind: "openai_reasoning",
    source: OPENAI,
    encryptedContent: "provider-ciphertext",
  });
});

test("serializes custom kind and message phase from output items without a tool catalog", () => {
  const response = openAIResponsesResponse({
    id: "request_custom",
    model: "anthropic/claude-sonnet-4-6",
    request: REQUEST,
    routing: {
      selectedModel: "anthropic/claude-sonnet-4-6",
      reasoningEffort: "medium",
      reason: "selected",
    },
    output: interactionOutput({
      source: { provider: "anthropic", api: "anthropic-messages", model: "claude-sonnet-4-6" },
      items: [
        {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "text", text: "Applying the patch." }],
          contentShape: "parts",
        },
        {
          type: "tool_call",
          callId: "toolu_patch",
          kind: "custom",
          namespace: "repo",
          name: "apply_patch",
          input: "*** Begin Patch",
          status: "completed",
        },
      ],
    }),
  });

  expect(response.output).toMatchObject([
    {
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "commentary",
      content: [{ type: "output_text", text: "Applying the patch.", annotations: [] }],
    },
    {
      type: "custom_tool_call",
      id: "toolu_patch",
      call_id: "toolu_patch",
      namespace: "repo",
      name: "apply_patch",
      input: "*** Begin Patch",
    },
  ]);
});

test("marks length-limited Responses output incomplete", () => {
  const response = openAIResponsesResponse({
    id: "request_length",
    model: "openai/gpt-5.5",
    request: REQUEST,
    routing: {
      selectedModel: "openai/gpt-5.5",
      reasoningEffort: "medium",
      reason: "selected",
    },
    output: interactionOutput({
      responseId: "resp_provider_length",
      stopReason: "length",
      items: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Partial" }],
          contentShape: "parts",
        },
      ],
    }),
  });

  expect(response).toMatchObject({
    id: "resp_request_length",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "message", status: "incomplete" }],
  });
});

test("serializes hosted search actions, sources, image results, and citations unchanged", () => {
  const search = {
    type: "web_search_call",
    id: "ws_123",
    status: "completed",
    action: {
      type: "search",
      query: "OpenAI web search docs",
      sources: [{ type: "url", url: "https://developers.openai.com/api/docs/guides/tools-web-search" }],
    },
    results: [{ type: "image_result", image_url: "https://example.test/result.png" }],
  };
  const citation = {
    type: "url_citation",
    start_index: 18,
    end_index: 21,
    url: "https://developers.openai.com/api/docs/guides/tools-web-search",
    title: "Web search",
  };
  const response = openAIResponsesResponse({
    id: "request_search",
    model: "openai/gpt-5.5",
    request: REQUEST,
    routing: {
      selectedModel: "openai/gpt-5.5",
      reasoningEffort: "high",
      reason: "hosted search required",
    },
    output: interactionOutput({
      items: [
        {
          type: "hosted_tool_call",
          id: "ws_123",
          tool: "web_search",
          providerType: "web_search_call",
          status: "completed",
          payload: search,
          source: OPENAI,
        },
        {
          type: "message",
          id: "msg_search",
          role: "assistant",
          content: [{ type: "text", text: "See the web docs.[1]", annotations: [citation] }],
          contentShape: "parts",
          source: OPENAI,
        },
      ],
    }),
  });

  expect(response.output).toEqual([
    search,
    {
      type: "message",
      id: "msg_search",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "See the web docs.[1]", annotations: [citation] }],
    },
  ]);
});

function interactionOutput(overrides: Partial<InteractionOutput>): InteractionOutput {
  return {
    createdAtMs: 1_700_000_000_000,
    source: OPENAI,
    items: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    ...overrides,
  };
}
