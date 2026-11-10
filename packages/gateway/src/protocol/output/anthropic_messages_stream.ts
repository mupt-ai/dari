import { piMessageToInteractionOutput } from "../../providers/pi_output.js";
import { providerToolCallIdentity } from "../../interaction/tool_identity.js";
import type { InteractionOutput, InteractionRequest, ProviderIdentity } from "../../interaction/types.js";
import {
  isProviderFailureMessage,
  providerFailureFromEvent,
  providerFailureMessage,
  type ProviderStreamOutcome,
} from "../../runtime/provider_stream_outcome.js";
import { sseStream } from "./sse_stream.js";
import {
  anthropicMessageId,
  anthropicReasoningBlock,
  anthropicRouting,
  anthropicStopReason,
  anthropicUsage,
} from "./anthropic_messages_output.js";

export function anthropicMessagesSseStream(args: {
  id: string;
  model: string;
  routing: RoutingDecision;
  events: AsyncIterable<Record<string, unknown>>;
  source: ProviderIdentity;
  request: InteractionRequest;
  conversationId?: string;
  onFinal?: (outcome: ProviderStreamOutcome) => void;
  beforeClose?: (outcome: ProviderStreamOutcome) => Promise<void> | void;
  clientSignal?: AbortSignal;
  onAbort?: () => void;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const id = anthropicMessageId(args.id);
  return sseStream({
    protocol: "anthropic_messages",
    lifecycle: args,
    start: ({ controller, snapshot, lifecycle, settle, observeTerminal }) => {
      const send = (event: string, payload: Record<string, unknown>) => {
        if (!lifecycle.canWrite) return;
        snapshot.record({ event, data: payload });
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
      };
      const sendProviderError = (message: Record<string, unknown>) => {
        send("error", {
          type: "error",
          error: { type: "api_error", message: providerFailureMessage(message) },
        });
      };

      send("message_start", {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: args.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          dari_routing: anthropicRouting(args.routing, args.id, args.conversationId),
        },
      });

      const argumentDeltaIndexes = new Set<number>();
      const redactedThinkingIndexes = new Set<number>();
      const thinkingTextByIndex = new Map<number, string>();

      return {
        consume: async () => {
          for await (const event of args.events) {
            if (lifecycle.shouldStopConsuming) break;
            const type = event.type;
            const index = contentIndex(event);
            if (type === "text_start" && index !== null) {
              send("content_block_start", {
                type: "content_block_start",
                index,
                content_block: { type: "text", text: "" },
              });
            } else if (type === "text_delta" && index !== null && typeof event.delta === "string") {
              send("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "text_delta", text: event.delta },
              });
            } else if (type === "text_end" && index !== null) {
              send("content_block_stop", { type: "content_block_stop", index });
            } else if (type === "thinking_start" && index !== null) {
              thinkingTextByIndex.set(index, "");
              const reasoning = reasoningFromPartial(event.partial, index, args.source, args.request);
              if (reasoning?.continuation?.kind === "anthropic_redacted_thinking") {
                redactedThinkingIndexes.add(index);
                send("content_block_start", {
                  type: "content_block_start",
                  index,
                  content_block: anthropicReasoningBlock(reasoning),
                });
              } else {
                send("content_block_start", {
                  type: "content_block_start",
                  index,
                  content_block: { type: "thinking", thinking: "", signature: "" },
                });
              }
            } else if (type === "thinking_delta" && index !== null && typeof event.delta === "string") {
              if (!redactedThinkingIndexes.has(index)) {
                thinkingTextByIndex.set(index, `${thinkingTextByIndex.get(index) ?? ""}${event.delta}`);
                send("content_block_delta", {
                  type: "content_block_delta",
                  index,
                  delta: { type: "thinking_delta", thinking: event.delta },
                });
              }
            } else if (type === "thinking_end" && index !== null) {
              if (!redactedThinkingIndexes.has(index)) {
                const reasoning = reasoningFromPartial(event.partial, index, args.source, args.request);
                const thinkingText = thinkingTextByIndex.get(index) ?? "";
                const fallbackReasoning: Extract<InteractionOutput["items"][number], { type: "reasoning" }> = {
                  type: "reasoning",
                  summary: thinkingText ? [thinkingText] : [],
                  content: [],
                  source: args.source,
                };
                const block = anthropicReasoningBlock(reasoning ?? fallbackReasoning);
                const signature = String(block.signature);
                send("content_block_delta", {
                  type: "content_block_delta",
                  index,
                  delta: { type: "signature_delta", signature },
                });
              }
              thinkingTextByIndex.delete(index);
              send("content_block_stop", { type: "content_block_stop", index });
            } else if (type === "toolcall_start" && index !== null) {
              const toolCall = toolCallFromEvent(event);
              const providerId = stringValue(event.toolCallId) ?? stringValue(toolCall.id) ?? `toolu_${index}`;
              const identity = providerToolCallIdentity(providerId, args.source);
              send("content_block_start", {
                type: "content_block_start",
                index,
                content_block: {
                  type: "tool_use",
                  id: identity.callId,
                  name: stringValue(event.toolName) ?? stringValue(toolCall.name) ?? "tool",
                  input: {},
                },
              });
            } else if (type === "toolcall_delta" && index !== null && typeof event.delta === "string") {
              argumentDeltaIndexes.add(index);
              send("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: event.delta },
              });
            } else if (type === "toolcall_end" && index !== null) {
              if (!argumentDeltaIndexes.has(index)) {
                const toolCall = toolCallFromEvent(event);
                send("content_block_delta", {
                  type: "content_block_delta",
                  index,
                  delta: {
                    type: "input_json_delta",
                    partial_json: JSON.stringify(isRecord(toolCall.arguments) ? toolCall.arguments : {}),
                  },
                });
              }
              send("content_block_stop", { type: "content_block_stop", index });
            } else if (type === "server_tool_call_start" && index !== null) {
              const serverToolCall = isRecord(event.serverToolCall) ? event.serverToolCall : {};
              const id = stringValue(serverToolCall.id) ?? `st_${index}`;
              send("content_block_start", {
                type: "content_block_start",
                index,
                content_block: {
                  type: "server_tool_use",
                  id,
                  name: stringValue(serverToolCall.name) ?? "tool_search_tool",
                  input: {},
                },
              });
              send("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(isRecord(serverToolCall.arguments) ? serverToolCall.arguments : {}),
                },
              });
            } else if (type === "server_tool_call_end" && index !== null) {
              send("content_block_stop", { type: "content_block_stop", index });
            } else if (type === "tool_search_result_start" && index !== null) {
              const result = isRecord(event.toolSearchResult) ? event.toolSearchResult : {};
              const content = Array.isArray(result.content) ? result.content.map((ref) => {
                if (isRecord(ref)) return { type: "tool_reference", tool_name: String(ref.tool_name ?? "") };
                return ref;
              }) : [];
              send("content_block_start", {
                type: "content_block_start",
                index,
                content_block: {
                  type: "tool_search_tool_result",
                  tool_use_id: String(result.toolUseId ?? ""),
                  content,
                },
              });
            } else if (type === "tool_search_result_end" && index !== null) {
              send("content_block_stop", { type: "content_block_stop", index });
            } else if (type === "done") {
              if (!isRecord(event.message)) throw new Error("Provider stream ended without a terminal message.");
              observeTerminal(event.message);
              if (isProviderFailureMessage(event.message)) {
                settle({ status: "provider_error", message: event.message });
                sendProviderError(event.message);
              } else {
                const output = piMessageToInteractionOutput(event.message, args.source, args.request);
                settle({ status: "completed", message: event.message, output });
                send("message_delta", {
                  type: "message_delta",
                  delta: {
                    stop_reason: anthropicStopReason(output),
                    stop_sequence: null,
                    ...(output.safeguardResults ? { safeguard_results: output.safeguardResults } : {}),
                  },
                  // message_start goes out before the provider answers, so the
                  // cumulative input and cache counts ride here, as on Anthropic.
                  // Claude Code sizes its context window from them.
                  usage: anthropicUsage(output),
                });
              }
              break;
            } else if (type === "error") {
              const message = providerFailureFromEvent(event);
              settle({ status: "provider_error", message });
              sendProviderError(message);
              break;
            }
          }
        },
        emitProviderError: sendProviderError,
        close: (outcome) => {
          if (outcome.status === "completed") {
            send("message_stop", { type: "message_stop" });
          }
          controller.close();
        },
      };
    },
  });
}

function reasoningFromPartial(
  partial: unknown,
  index: number,
  source: ProviderIdentity,
  request: InteractionRequest
): Extract<InteractionOutput["items"][number], { type: "reasoning" }> | null {
  if (!isRecord(partial)) return null;
  const output = piMessageToInteractionOutput(partial, source, request);
  const item = output.items[index];
  return item?.type === "reasoning" ? item : null;
}

function contentIndex(event: Record<string, unknown>): number | null {
  if (typeof event.contentIndex === "number") return event.contentIndex;
  return typeof event.index === "number" ? event.index : null;
}

function toolCallFromEvent(event: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(event.toolCall)) return event.toolCall;
  if (!isRecord(event.partial) || !Array.isArray(event.partial.content)) return {};
  const index = contentIndex(event);
  const block = index === null ? undefined : event.partial.content[index];
  return isRecord(block) && block.type === "toolCall" ? block : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

import { isRecord, type RoutingDecision } from "@mupt-ai/dari-router/policy-engine";
