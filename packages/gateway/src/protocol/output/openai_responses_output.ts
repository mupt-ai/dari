import { encodeProviderContinuationState } from "../../interaction/provider_continuation_state.js";
import type { InteractionOutput } from "../../interaction/types.js";

export function openAIResponsesResponseId(requestId: string): string {
  return `resp_${requestId}`;
}

export function openAIResponsesTerminal(output: Pick<InteractionOutput, "stopReason">): {
  status: "completed" | "incomplete";
  incomplete_details: { reason: "max_output_tokens" } | null;
} {
  return output.stopReason === "length"
    ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
    : { status: "completed", incomplete_details: null };
}

export function openAIResponsesOutputItems(output: InteractionOutput): Array<Record<string, unknown>> {
  return output.items.map((item, index) => openAIResponsesOutputItem(output, item, index));
}

export function openAIResponsesOutputItem(
  output: InteractionOutput,
  item: InteractionOutput["items"][number],
  index: number
): Record<string, unknown> {
  if (item.type === "message") return responseMessageItem(output, item, index);
  if (item.type === "reasoning") return responseReasoningItem(output, item, index);
  if (item.type === "hosted_tool_call") return responseHostedToolCallItem(item);
  return responseToolCallItem(item);
}

export function openAIResponsesUsage(output: Pick<InteractionOutput, "usage">): Record<string, unknown> {
  const inputTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
  return {
    input_tokens: inputTokens,
    input_tokens_details: output.usage.cacheRead || output.usage.cacheWrite
      ? { cached_tokens: output.usage.cacheRead, cache_write_tokens: output.usage.cacheWrite }
      : null,
    output_tokens: output.usage.output,
    output_tokens_details: null,
    total_tokens: output.usage.totalTokens || inputTokens + output.usage.output,
  };
}

export function openAIResponsesRouting(
  decision: RoutingDecision,
  requestId: string,
  conversationId?: string
): Record<string, unknown> {
  return {
    requested_model: "dari/routing",
    selected_model: decision.selectedModel,
    reasoning_effort: decision.reasoningEffort,
    reason: decision.reason,
    request_id: requestId,
    ...(conversationId ? { conversation_id: conversationId } : {}),
  };
}

export function responseMessageOutputItem(id: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "assistant",
    id,
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function responseMessageItem(
  output: InteractionOutput,
  item: Extract<InteractionOutput["items"][number], { type: "message" }>,
  index: number
): Record<string, unknown> {
  const content = item.content.flatMap((part) =>
    part.type === "text"
      ? [{
          type: "output_text",
          text: part.text,
          annotations: part.annotations ?? [],
        }]
      : []
  );
  return {
    ...responseMessageOutputItem(item.id ?? fallbackItemId("msg", output, index), ""),
    content,
    status: outputItemStatus(output),
    ...(item.phase ? { phase: item.phase } : {}),
  };
}

function responseHostedToolCallItem(
  item: Extract<InteractionOutput["items"][number], { type: "hosted_tool_call" }>
): Record<string, unknown> {
  return {
    ...item.payload,
    type: item.providerType,
    id: item.id,
    ...(item.status ? { status: item.status } : {}),
  };
}

function responseReasoningItem(
  output: InteractionOutput,
  item: Extract<InteractionOutput["items"][number], { type: "reasoning" }>,
  index: number
): Record<string, unknown> {
  return {
    type: "reasoning",
    id: item.id ?? fallbackItemId("rs", output, index),
    status: outputItemStatus(output),
    summary: item.summary.map((text) => ({ type: "summary_text", text })),
    ...(item.content.length
      ? { content: item.content.map((text) => ({ type: "reasoning_text", text })) }
      : {}),
    ...(item.continuation
      ? { encrypted_content: encodeProviderContinuationState(item.continuation) }
      : {}),
  };
}

function responseToolCallItem(
  item: Extract<InteractionOutput["items"][number], { type: "tool_call" }>
): Record<string, unknown> {
  const id = item.id ?? item.callId;
  if (item.kind === "custom") {
    return {
      type: "custom_tool_call",
      id,
      call_id: item.callId,
      ...(item.namespace ? { namespace: item.namespace } : {}),
      name: item.name,
      input: typeof item.input === "string" ? item.input : "",
    };
  }
  return {
    type: "function_call",
    id,
    call_id: item.callId,
    ...(item.namespace ? { namespace: item.namespace } : {}),
    name: item.name,
    arguments: toolArgumentsString(item.input),
    ...(item.status ? { status: item.status } : {}),
  };
}

function outputItemStatus(output: InteractionOutput): "completed" | "incomplete" {
  return output.stopReason === "length" ? "incomplete" : "completed";
}

function fallbackItemId(prefix: "msg" | "rs", output: InteractionOutput, index: number): string {
  const responseId = output.responseId?.replace(/[^A-Za-z0-9_-]/g, "_") || "routing";
  return `${prefix}_${responseId}_${index}`.slice(0, 64);
}

function toolArgumentsString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "{}";
  return JSON.stringify(value);
}
import type { RoutingDecision } from "@mupt-ai/dari-router/policy-engine";
