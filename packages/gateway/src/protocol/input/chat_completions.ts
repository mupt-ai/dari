import {
  isRecord,
  type ChatCompletionRequest,
  type ChatMessage,
  type ResponseFormat,
} from "@mupt-ai/dari-router/policy-engine";

import { HttpError } from "../../http/errors.js";
import type {
  InteractionContent,
  InteractionItem,
  InteractionMessage,
  InteractionRequest,
  InteractionResponseFormat,
  InteractionTool,
  InteractionToolChoice,
} from "../../interaction/types.js";
import { toolsByWireName } from "../../interaction/tool_identity.js";
import { decodeUntrustedProviderContinuationState } from "../../interaction/provider_continuation_state.js";
import { validateChatCompletionsRequest } from "./chat_completions_validation.js";
import { parsePdfDataUrl } from "../../interaction/document.js";

export function chatCompletionsToInteraction(request: ChatCompletionRequest): InteractionRequest {
  validateChatCompletionsRequest(request);
  return internalChatCompletionsToInteraction(request);
}

// Internal Chat requests are constructed by Dari and do not use the public
// dari/routing model constraint enforced at ingress.
export function internalChatCompletionsToInteraction(request: ChatCompletionRequest): InteractionRequest {
  const items: InteractionItem[] = [];
  const toolNames = new Map<string, string>();
  for (const [messageIndex, message] of (request.messages ?? []).entries()) {
    if (message.role === "tool") {
      items.push({
        type: "tool_result",
        callId: message.tool_call_id ?? "",
        kind: "function",
        name: toolNames.get(message.tool_call_id ?? ""),
        output: messageContent(message.content),
        outputShape: contentShape(message.content),
      });
      continue;
    }

    const reasoningItems = chatReasoningItems(message, messageIndex);
    items.push(...reasoningItems);
    items.push({
      type: "message",
      role: message.role as InteractionMessage["role"],
      content: messageContent(message.content),
      contentShape: contentShape(message.content),
    });
    for (const [toolCallIndex, toolCall] of (message.tool_calls ?? []).entries()) {
      const fn = toolCall.function as Record<string, unknown>;
      const callId = String(toolCall.id);
      const name = String(fn.name);
      const hostedToolCall = chatHostedToolCall(
        callId,
        name,
        fn.arguments,
        reasoningItems,
        messageIndex,
        toolCallIndex,
      );
      if (hostedToolCall) {
        items.push(hostedToolCall);
        continue;
      }
      toolNames.set(callId, name);
      items.push({
        type: "tool_call",
        callId,
        kind: "function",
        name,
        input: typeof fn.arguments === "string" || isRecord(fn.arguments) ? fn.arguments : undefined,
      });
    }
  }

  const tools = chatTools(request.tools);
  toolsByWireName(tools);
  const responseFormat = toInteractionResponseFormat(request.response_format);
  // OpenAI spells the non-reasoning effort "none"; Dari spells it "off".
  const requestedEffort: string | undefined = request.reasoning_effort;
  const reasoningEffort = requestedEffort === "none" ? "off" : request.reasoning_effort;
  return {
    sourceProtocol: request.source_protocol ?? "openai_chat",
    model: request.model,
    items,
    tools,
    toolChoice: chatToolChoice(request.tool_choice),
    parallelToolCalls: request.parallel_tool_calls,
    generation: {
      temperature: request.temperature,
      topP: request.top_p,
      maxOutputTokens: request.max_completion_tokens ?? request.max_tokens,
      stop: request.stop,
    },
    reasoning: reasoningEffort === undefined ? undefined : { effort: reasoningEffort },
    responseFormat,
    promptCacheKey: request.prompt_cache_key,
    stream: request.stream === true,
    metadata: request.metadata,
    user: request.user,
  };
}

function chatHostedToolCall(
  callId: string,
  name: string,
  argumentsValue: unknown,
  reasoningItems: InteractionItem[],
  messageIndex: number,
  toolCallIndex: number,
): Extract<InteractionItem, { type: "hosted_tool_call" }> | null {
  if (name !== "web_search") return null;
  const payload = chatToolArgumentsRecord(argumentsValue);
  if (!payload || payload.type !== "web_search_call" || payload.id !== callId) return null;

  const status = hostedToolCallStatus(
    payload.status,
    `messages.${messageIndex}.tool_calls.${toolCallIndex}.function.arguments.status`,
  );
  const source = reasoningItems.flatMap((item) => {
    if (
      item.type !== "reasoning"
      || item.continuation?.kind !== "openai_reasoning"
      || !item.continuation.hostedToolCallIds?.includes(callId)
    ) {
      return [];
    }
    return [item.continuation.source];
  })[0];
  return {
    type: "hosted_tool_call",
    id: callId,
    tool: "web_search",
    providerType: "web_search_call",
    ...(status ? { status } : {}),
    payload: { ...payload },
    ...(source ? { source } : {}),
  };
}

function chatToolArgumentsRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hostedToolCallStatus(
  value: unknown,
  param: string,
): Extract<InteractionItem, { type: "hosted_tool_call" }>["status"] {
  if (value === undefined) return undefined;
  if (
    value === "in_progress"
    || value === "searching"
    || value === "completed"
    || value === "incomplete"
    || value === "failed"
  ) {
    return value;
  }
  throw new HttpError(400, `${param} is not supported.`, "invalid_request_error", param);
}

function chatReasoningItems(message: ChatMessage, messageIndex: number): InteractionItem[] {
  if (message.role !== "assistant") return [];
  const readable = [message.reasoning_content, message.reasoning, message.reasoning_text]
    .find((value) => typeof value === "string" && value.length > 0);
  const continuations = (message.reasoning_details ?? []).map((detail, detailIndex) => {
    if (detail.type !== "reasoning.encrypted" || typeof detail.data !== "string") {
      throw invalidChatContinuation(messageIndex, detailIndex);
    }
    const continuation = decodeUntrustedProviderContinuationState(detail.data);
    if (!continuation) throw invalidChatContinuation(messageIndex, detailIndex);
    return continuation;
  });
  if (continuations.length === 0) {
    return readable
      ? [{ type: "reasoning", summary: [readable], content: [] }]
      : [];
  }
  return continuations.map((continuation, index) => ({
    type: "reasoning" as const,
    summary: index === 0 && readable ? [readable] : [],
    content: [],
    source: continuation.source,
    continuation,
  }));
}

function invalidChatContinuation(messageIndex: number, detailIndex: number): HttpError {
  const param = `messages.${messageIndex}.reasoning_details.${detailIndex}.data`;
  return new HttpError(
    400,
    `${param} must be a Dari provider continuation envelope; raw provider state has no recoverable provider/model provenance.`,
    "invalid_provider_continuation_state",
    param,
  );
}

function contentShape(content: ChatMessage["content"]): InteractionMessage["contentShape"] {
  if (content === undefined) return "absent";
  if (content === null) return "null";
  return typeof content === "string" ? "string" : "parts";
}

function messageContent(content: ChatMessage["content"]): InteractionContent[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: String(part.text) };
    if (part.type === "tool_reference") {
      return { type: "text", text: `Referenced tool: ${String(part.tool_name)}` };
    }
    if (part.type === "file") {
      // Validation guarantees a base64 PDF data URL.
      const fileData = String((part.file as Record<string, unknown>).file_data);
      return { type: "document", mimeType: "application/pdf", data: parsePdfDataUrl(fileData)! };
    }
    const imageUrl = part.image_url as Record<string, unknown>;
    const detail = imageUrl.detail;
    return {
      type: "image",
      url: String(imageUrl.url),
      ...(detail === "auto" || detail === "low" || detail === "high" || detail === "original"
        ? { detail }
        : {}),
    };
  });
}

function chatTools(tools: ChatCompletionRequest["tools"]): InteractionTool[] {
  return (tools ?? []).map((tool) => {
    const fn = tool.function as Record<string, unknown>;
    return {
      kind: "function",
      name: String(fn.name),
      description: typeof fn.description === "string" ? fn.description : undefined,
      parameters: isRecord(fn.parameters) ? fn.parameters : undefined,
      strict: typeof fn.strict === "boolean" ? fn.strict : undefined,
    };
  });
}

function chatToolChoice(choice: ChatCompletionRequest["tool_choice"]): InteractionToolChoice | undefined {
  if (typeof choice === "string") return choice as InteractionToolChoice;
  if (!isRecord(choice) || !isRecord(choice.function)) return undefined;
  return { kind: "function", name: String(choice.function.name) };
}

function toInteractionResponseFormat(format: ResponseFormat | undefined): InteractionResponseFormat | undefined {
  if (format === undefined || format.type !== "json_schema") return format;
  return { type: "json_schema", ...format.json_schema };
}
