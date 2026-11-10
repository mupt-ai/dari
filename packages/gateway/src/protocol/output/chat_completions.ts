import { isRecord, type ChatMessage, type RoutingDecision } from "@mupt-ai/dari-router/policy-engine";

import { piMessageToInteractionOutput } from "../../providers/pi_output.js";
import { providerToolCallIdentity } from "../../interaction/tool_identity.js";
import { encodeProviderContinuationState } from "../../interaction/provider_continuation_state.js";
import { chatReasoningDetailId } from "./chat_reasoning_detail.js";
import type { InteractionOutput, InteractionRequest, ProviderContinuationState, ProviderIdentity } from "../../interaction/types.js";
import {
  isProviderFailureMessage,
  providerFailureFromEvent,
  providerFailureMessage,
  type ProviderStreamOutcome,
} from "../../runtime/provider_stream_outcome.js";
import { sseStream } from "./sse_stream.js";

export function chatCompletionResponse(args: {
  id: string;
  model: string;
  output: InteractionOutput;
  modelCost?: number | null;
  routing: RoutingDecision;
  conversationId?: string;
}): Record<string, unknown> {
  return {
    id: completionId(args.id),
    object: "chat.completion",
    created: Math.floor(args.output.createdAtMs / 1000),
    model: args.model,
    choices: [
      {
        index: 0,
        message: assistantMessagePayload(args.output),
        finish_reason: interactionFinishReason(args.output),
      },
    ],
    usage: usagePayload(args.output, args.modelCost),
    dari_routing: routingPayload(args.routing, args.id, args.conversationId),
  };
}

export function chatCompletionsSseStream(args: {
  id: string;
  model: string;
  routing: RoutingDecision;
  events: AsyncIterable<Record<string, unknown>>;
  source: ProviderIdentity;
  request: InteractionRequest;
  conversationId?: string;
  onFinal?: (outcome: ProviderStreamOutcome) => void;
  modelCost?: (message: Record<string, unknown>, failed: boolean) => number | null;
  // Optional terminal barrier. Streaming deltas are unaffected, but [DONE]
  // and EOF are held until this settles.
  beforeClose?: (outcome: ProviderStreamOutcome) => Promise<void> | void;
  clientSignal?: AbortSignal;
  onAbort?: () => void;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const completion = completionId(args.id);
  const created = Math.floor(Date.now() / 1000);
  return sseStream({
    protocol: "openai_chat",
    lifecycle: args,
    start: ({ controller, snapshot, lifecycle, settle, observeTerminal }) => {
      const send = (value: unknown) => {
        if (!lifecycle.canWrite) return;
        snapshot.record({ data: value });
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      };
      const done = () => {
        if (!lifecycle.canWrite) return;
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      };
      const sendProviderError = (message: Record<string, unknown>) => {
        send({ ...errorChunk({ completion, created, model: args.model, message: providerFailureMessage(message) }),
          usage: usagePayload(message, args.modelCost?.(message, true)) });
      };

      send(chunk({ completion, created, model: args.model, delta: {}, finishReason: null, routing: routingPayload(args.routing, args.id, args.conversationId) }));
      send(chunk({ completion, created, model: args.model, delta: { role: "assistant" }, finishReason: null }));

      const argumentDeltaSeen = new Set<string>();
      const toolCallIdsSeen = new Set<string>();
      const emittedToolCallIds = new Set<string>();
      const toolCallNamesSeen = new Set<string>();
      const toolCallIndexes = new Map<string, number>();
      let reasoningDeltaSeen = false;
      let nextToolCallIndex = 0;
      const streamIndexFor = (event: Record<string, unknown>): number => {
        const keys = toolCallStreamKeys(event);
        for (const key of keys) {
          const existing = toolCallIndexes.get(key);
          if (existing !== undefined) return existing;
        }
        const index = typeof event.index === "number" ? event.index : nextToolCallIndex++;
        nextToolCallIndex = Math.max(nextToolCallIndex, index + 1);
        for (const key of keys) toolCallIndexes.set(key, index);
        return index;
      };
      const markKeys = (event: Record<string, unknown>, target: Set<string>) => {
        for (const key of toolCallStreamKeys(event)) target.add(key);
      };

      return {
        consume: async () => {
          for await (const event of args.events) {
            if (lifecycle.shouldStopConsuming) break;
            const type = event.type;
            if (type === "text_delta" && typeof event.delta === "string" && event.delta) {
              send(chunk({ completion, created, model: args.model, delta: { content: event.delta }, finishReason: null }));
            } else if (type === "thinking_delta" && typeof event.delta === "string" && event.delta) {
              reasoningDeltaSeen = true;
              send(chunk({ completion, created, model: args.model, delta: { reasoning_content: event.delta }, finishReason: null }));
            } else if (type === "toolcall_start") {
              const index = streamIndexFor(event);
              const delta = toolCallStartDelta(event, index, args.source);
              if (typeof delta.id === "string" && delta.id) {
                markKeys(event, toolCallIdsSeen);
                emittedToolCallIds.add(delta.id);
              }
              if (toolCallNameFromEvent(event)) markKeys(event, toolCallNamesSeen);
              send(chunk({ completion, created, model: args.model, delta: { tool_calls: [delta] }, finishReason: null }));
            } else if (type === "toolcall_delta" && typeof event.delta === "string" && event.delta) {
              const index = streamIndexFor(event);
              markKeys(event, argumentDeltaSeen);
              send(chunk({ completion, created, model: args.model, delta: { tool_calls: [toolCallArgumentsDelta(event, index)] }, finishReason: null }));
            } else if (type === "toolcall_end" && isRecord(event.toolCall)) {
              const index = streamIndexFor(event);
              const keys = toolCallStreamKeys(event);
              const delta = toolCallEndDelta(event, index, args.source, {
                includeArguments: !keys.some((key) => argumentDeltaSeen.has(key)),
                includeId: !keys.some((key) => toolCallIdsSeen.has(key)),
                includeName: !keys.some((key) => toolCallNamesSeen.has(key)),
              });
              if (typeof delta.id === "string" && delta.id) emittedToolCallIds.add(delta.id);
              if (toolCallDeltaHasPayload(delta)) {
                send(chunk({ completion, created, model: args.model, delta: { tool_calls: [delta] }, finishReason: null }));
              }
            } else if (type === "done") {
              if (!isRecord(event.message)) throw new Error("Provider stream ended without a terminal message.");
              observeTerminal(event.message);
              if (isProviderFailureMessage(event.message)) {
                settle({ status: "provider_error", message: event.message });
                sendProviderError(event.message);
              } else {
                const output = piMessageToInteractionOutput(event.message, args.source, args.request);
                settle({ status: "completed", message: event.message, output });
                const assistant = assistantMessagePayload(output);
                if (!reasoningDeltaSeen && typeof assistant.reasoning_content === "string" && assistant.reasoning_content) {
                  send(chunk({
                    completion,
                    created,
                    model: args.model,
                    delta: { reasoning_content: assistant.reasoning_content },
                    finishReason: null,
                  }));
                }
                if (Array.isArray(assistant.reasoning_details) && assistant.reasoning_details.length > 0) {
                  send(chunk({
                    completion,
                    created,
                    model: args.model,
                    delta: { reasoning_details: assistant.reasoning_details },
                    finishReason: null,
                  }));
                }
                const terminalToolCalls = Array.isArray(assistant.tool_calls)
                  ? assistant.tool_calls.flatMap((toolCall, index) => {
                      if (!isRecord(toolCall) || typeof toolCall.id !== "string" || emittedToolCallIds.has(toolCall.id)) {
                        return [];
                      }
                      return [{ index, ...toolCall }];
                    })
                  : [];
                if (terminalToolCalls.length > 0) {
                  send(chunk({
                    completion,
                    created,
                    model: args.model,
                    delta: { tool_calls: terminalToolCalls },
                    finishReason: null,
                  }));
                }
                send(chunk({
                  completion,
                  created,
                  model: args.model,
                  delta: {},
                  finishReason: interactionFinishReason(output),
                  usage: usagePayload(event.message, args.modelCost?.(event.message, false)),
                }));
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
        close: () => {
          done();
          controller.close();
        },
      };
    },
  });
}

function routingPayload(decision: RoutingDecision, requestId: string, conversationId?: string): Record<string, unknown> {
  return {
    requested_model: "dari/routing",
    selected_model: decision.selectedModel,
    reasoning_effort: decision.reasoningEffort,
    reason: decision.reason,
    request_id: requestId,
    ...(conversationId ? { conversation_id: conversationId } : {}),
  };
}

function chunk(args: {
  completion: string;
  created: number;
  model: string;
  delta: Record<string, unknown>;
  finishReason: string | null;
  routing?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: args.completion,
    object: "chat.completion.chunk",
    created: args.created,
    model: args.model,
    choices: [{ index: 0, delta: args.delta, finish_reason: args.finishReason }],
    ...(args.routing ? { dari_routing: args.routing } : {}),
    ...(args.usage ? { usage: args.usage } : {}),
  };
}

function errorChunk(args: { completion: string; created: number; model: string; message: string }): Record<string, unknown> {
  return {
    id: args.completion,
    object: "chat.completion.chunk",
    created: args.created,
    model: args.model,
    choices: [{ index: 0, delta: {}, finish_reason: "error" }],
    error: { message: args.message, type: "server_error", code: "provider_execution_failed" },
  };
}

export function assistantMessagePayload(output: InteractionOutput): ChatMessage {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const continuations: ProviderContinuationState[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  const toolCallIds: string[] = [];
  const reasoningDetailIds = new Set<string>();
  for (const item of output.items) {
    if (item.type === "message") {
      textParts.push(...item.content.filter((part) => part.type === "text").map((part) => part.text));
    }
    if (item.type === "reasoning") {
      reasoningParts.push(...item.summary, ...item.content);
      if (item.continuation) continuations.push(item.continuation);
    }
    if (item.type === "tool_call") {
      toolCalls.push(toolCallMessage(item, toolCalls.length));
      toolCallIds.push(item.callId || `call_${toolCallIds.length}`);
    }
    if (item.type === "hosted_tool_call") {
      toolCalls.push(hostedToolCallMessage(item));
      toolCallIds.push(item.id);
    }
  }
  return {
    role: "assistant",
    content: toolCalls.length > 0 && textParts.length === 0 ? null : textParts.join(""),
    ...(reasoningParts.length > 0 ? { reasoning_content: reasoningParts.join("\n") } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(continuations.length > 0
      ? {
          reasoning_details: continuations.map((continuation, index) => ({
            type: "reasoning.encrypted",
            id: chatReasoningDetailId(continuation, index, toolCallIds, reasoningDetailIds),
            data: encodeProviderContinuationState(continuation),
          })),
        }
      : {}),
  };
}

function hostedToolCallMessage(
  item: Extract<InteractionOutput["items"][number], { type: "hosted_tool_call" }>
): Record<string, unknown> {
  const replayPayload = chatHostedToolReplayPayload(item);
  return {
    id: item.id,
    type: "function",
    function: {
      name: item.tool,
      arguments: JSON.stringify(replayPayload),
    },
  };
}

export function chatHostedToolReplayPayload(
  item: Extract<InteractionOutput["items"][number], { type: "hosted_tool_call" }>
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...item.payload,
    type: item.providerType,
    id: item.id,
  };
  if (item.status) payload.status = item.status;
  else delete payload.status;
  return payload;
}

function toolCallMessage(item: Extract<InteractionOutput["items"][number], { type: "tool_call" }>, index: number): Record<string, unknown> {
  const name = item.namespace ? `${item.namespace}__${item.name}` : item.name;
  return {
    id: item.callId || `call_${index}`,
    type: "function",
    function: {
      name,
      arguments: typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? {}),
    },
  };
}

function usagePayload(message: { usage?: unknown }, cost?: number | null): Record<string, unknown> {
  const usage = isRecord(message.usage) ? message.usage : {};
  const input = numeric(usage.input);
  const cacheRead = numeric(usage.cacheRead);
  const cacheWrite = numeric(usage.cacheWrite);
  const prompt = input + cacheRead + cacheWrite;
  const completion = numeric(usage.output);
  return {
    // Same field as OpenRouter. Null means unpriced, never a fabricated free request.
    cost: cost ?? null,
    prompt_tokens: prompt,
    completion_tokens: completion,
    // OpenAI counts cached tokens inside prompt_tokens; once cache tokens are
    // folded in, recompute the total rather than trusting upstream totalTokens.
    total_tokens: cacheRead || cacheWrite
      ? prompt + completion
      : numeric(usage.totalTokens) || prompt + completion,
    ...(cacheRead || cacheWrite
      ? { prompt_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite } }
      : {}),
  };
}

function interactionFinishReason(output: InteractionOutput): string {
  if (output.stopReason === "length") return "length";
  if (output.stopReason === "tool_use") return "tool_calls";
  if (output.stopReason === "error" || output.stopReason === "aborted") return "error";
  return "stop";
}

function completionId(id: string): string {
  return `chatcmpl-${id}`;
}

function toolCallStartDelta(
  event: Record<string, unknown>,
  index: number,
  source: ProviderIdentity
): Record<string, unknown> {
  const toolCall = toolCallFromEvent(event);
  const providerId = stringValue(event.toolCallId) ?? stringValue(toolCall.id);
  const id = providerId ? providerToolCallIdentity(providerId, source).callId : undefined;
  const name = toolCallNameFromEvent(event) ?? "tool";
  return {
    index,
    ...(id ? { id } : {}),
    type: "function",
    function: { name, arguments: "" },
  };
}

function toolCallArgumentsDelta(event: Record<string, unknown>, index: number): Record<string, unknown> {
  return { index, function: { arguments: String(event.delta ?? "") } };
}

function toolCallEndDelta(
  event: Record<string, unknown>,
  index: number,
  source: ProviderIdentity,
  options: { includeArguments: boolean; includeId: boolean; includeName: boolean },
): Record<string, unknown> {
  const toolCall = toolCallFromEvent(event);
  const providerId = stringValue(toolCall.id);
  const id = providerId ? providerToolCallIdentity(providerId, source).callId : undefined;
  const name = stringValue(toolCall.name);
  const functionDelta: Record<string, unknown> = {};
  if (options.includeName && name) functionDelta.name = name;
  if (options.includeArguments) {
    functionDelta.arguments = JSON.stringify(isRecord(toolCall.arguments) ? toolCall.arguments : {});
  }
  return {
    index,
    ...(options.includeId && id ? { id } : {}),
    ...((options.includeId && id) || (options.includeName && name) ? { type: "function" } : {}),
    ...(Object.keys(functionDelta).length > 0 ? { function: functionDelta } : {}),
  };
}

function toolCallDeltaHasPayload(delta: Record<string, unknown>): boolean {
  return Boolean(delta.id || delta.type || (isRecord(delta.function) && Object.keys(delta.function).length > 0));
}

function toolCallStreamKeys(event: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const toolCall = toolCallFromEvent(event);
  if (typeof event.index === "number") keys.push(`index:${event.index}`);
  if (typeof event.contentIndex === "number") keys.push(`content:${event.contentIndex}`);
  if (typeof event.toolCallId === "string" && event.toolCallId) keys.push(`id:${event.toolCallId}`);
  if (typeof toolCall.id === "string" && toolCall.id) keys.push(`id:${toolCall.id}`);
  return keys.length > 0 ? keys : ["unknown"];
}

function toolCallFromEvent(event: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(event.toolCall)) return event.toolCall;
  const partial = isRecord(event.partial) ? event.partial : {};
  const content = Array.isArray(partial.content) ? partial.content : [];
  const contentIndex = eventContentIndex(event);
  const item = contentIndex === undefined ? undefined : content[contentIndex];
  return isRecord(item) && item.type === "toolCall" ? item : {};
}

function eventContentIndex(event: Record<string, unknown>): number | undefined {
  if (typeof event.contentIndex === "number") return event.contentIndex;
  if (typeof event.index === "number") return event.index;
  return undefined;
}

function toolCallNameFromEvent(event: Record<string, unknown>): string | undefined {
  const toolCall = toolCallFromEvent(event);
  return stringValue(event.toolName) ?? stringValue(toolCall.name);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}
