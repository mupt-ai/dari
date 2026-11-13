import { parseDataImageUrl } from "../../interaction/image.js";
import { encodeProviderContinuationState } from "../../interaction/provider_continuation_state.js";
import { encodePortableReasoningState } from "../../interaction/portable_reasoning_state.js";
import type { InteractionOutput } from "../../interaction/types.js";
import type { ServedDecision } from "../../types.js";

export function anthropicMessageId(requestId: string): string {
  return `msg_${requestId.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);
}

export function anthropicContent(output: InteractionOutput): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  for (const item of output.items) {
    // Native compaction state is OpenAI Responses-only.
    if (item.type === "compaction") continue;
    if (item.type === "reasoning") {
      content.push(anthropicReasoningBlock(item));
      continue;
    }
    if (item.type === "tool_call") {
      content.push({
        type: "tool_use",
        id: item.callId,
        name: item.namespace ? `${item.namespace}__${item.name}` : item.name,
        input: toolInput(item.kind, item.input),
      });
      continue;
    }
    if (item.type === "hosted_tool_call") {
      // Render server tool use and tool search results for Anthropic protocol.
      if (item.tool === "server_tool_use") {
        content.push({
          type: "server_tool_use",
          id: item.serverToolUseId ?? item.id,
          name: item.serverToolName ?? "tool",
          input: item.serverToolInput ?? {},
        });
      } else if (item.tool === "tool_search") {
        content.push({
          type: "tool_search_tool_result",
          tool_use_id: item.serverToolUseId ?? item.id,
          content: (item.serverToolResult ?? []).map((ref) => ({
            type: "tool_reference",
            tool_name: ref.toolName,
          })),
        });
      }
      continue;
    }
    for (const part of item.content) {
      if (part.type === "text") {
        content.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "tool_reference") {
        content.push({ type: "text", text: `Referenced tool: ${part.toolName}` });
        continue;
      }
      if (part.type === "document") {
        content.push({
          type: "document",
          source: { type: "base64", media_type: part.mimeType, data: part.data },
        });
        continue;
      }
      const image = parseDataImageUrl(part.url);
      if (!image) throw new Error("Anthropic output images must use base64 data URLs.");
      content.push({
        type: "image",
        source: { type: "base64", media_type: image.mimeType, data: image.data },
      });
    }
  }
  return content.length > 0 ? content : [{ type: "text", text: "" }];
}

export function anthropicReasoningBlock(
  item: Extract<InteractionOutput["items"][number], { type: "reasoning" }>
): Record<string, unknown> {
  const encoded = item.continuation
    ? encodeProviderContinuationState(item.continuation)
    : encodePortableReasoningState({ source: item.source, itemId: item.id });
  if (item.continuation?.kind === "anthropic_redacted_thinking") {
    return { type: "redacted_thinking", data: encoded };
  }
  return {
    type: "thinking",
    thinking: item.continuation?.kind === "anthropic_thinking"
      ? item.continuation.thinking
      : [...item.summary, ...item.content].join("\n"),
    signature: encoded,
  };
}

export function anthropicStopReason(output: Pick<InteractionOutput, "stopReason">): string {
  if (output.stopReason === "length") return "max_tokens";
  if (output.stopReason === "tool_use") return "tool_use";
  return "end_turn";
}

export function anthropicUsage(output: Pick<InteractionOutput, "usage">): Record<string, unknown> {
  return {
    input_tokens: output.usage.input,
    cache_creation_input_tokens: output.usage.cacheWrite,
    cache_read_input_tokens: output.usage.cacheRead,
    output_tokens: output.usage.output,
  };
}

export function anthropicRouting(
  decision: ServedDecision,
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
    ...(decision.leaseTurnsRemaining === undefined
      ? {}
      : { lease_turns_remaining: decision.leaseTurnsRemaining }),
    ...(decision.sessionPinned === true ? { session_pinned: true } : {}),
  };
}

function toolInput(kind: "function" | "custom", value: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (kind === "custom") return { input: typeof value === "string" ? value : "" };
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
