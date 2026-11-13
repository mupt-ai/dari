import { encodeOpenAIReasoningSignature } from "@mupt-ai/dari-router/protocols";
import { isRecord } from "@mupt-ai/dari-router/policy-engine";

import { HttpError } from "../http/errors.js";
import type {
  InteractionContent,
  InteractionItem,
  InteractionRequest,
  InteractionTool,
  ProviderContinuationState,
  ProviderIdentity,
} from "../interaction/types.js";
import { parseDataImageUrl } from "../interaction/image.js";
import { providerToolCallId, toolWireName } from "../interaction/tool_identity.js";
import {
  compatibleProviderContinuation,
  sameProviderIdentity,
} from "../interaction/provider_continuation_state.js";
import { isOpenAIResponsesApi } from "./model_capabilities.js";
import { apiSupportsDocumentInput } from "./model_capabilities.js";

const UNKNOWN_SOURCE: ProviderIdentity = {
  provider: "dari",
  api: "interaction-history",
  model: "unknown",
};

type PiAssistant = {
  role: "assistant";
  content: Array<Record<string, unknown>>;
  api: string;
  provider: string;
  model: string;
  providerThinkingLevel?: string;
  usage: Record<string, unknown>;
  stopReason: "stop" | "toolUse";
  timestamp: number;
};

export type PiContext = Record<string, unknown> & {
  messages: Array<Record<string, unknown>>;
  systemPrompt?: string;
  tools?: Array<Record<string, unknown>>;
};

export function buildContext(
  request: InteractionRequest,
  target: ProviderIdentity,
): PiContext {
  const systemParts: string[] = request.instructions ? [request.instructions] : [];
  const messages: Array<Record<string, unknown>> = [];
  const toolCalls = new Map<string, { id: string; name: string }>();
  const timestamp = Date.now();
  let pending: PiAssistant | null = null;
  let sawConversationItem = false;

  const flushAssistant = () => {
    if (!pending) return;
    if (pending.content.length === 0) pending.content.push({ type: "text", text: "" });
    pending.stopReason = pending.content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
    messages.push(pending);
    pending = null;
  };
  const assistantFor = (source: ProviderIdentity): PiAssistant => {
    if (pending && !sameProviderIdentity(pending, source)) flushAssistant();
    pending ??= {
      role: "assistant",
      content: [],
      ...source,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp,
    };
    return pending;
  };
  const assistantForReasoning = (source: ProviderIdentity): PiAssistant => {
    // Codex can persist a streamed tool call before reasoning recovered from
    // the terminal response. Both items still belong to one assistant turn.
    if (pending && sameProviderIdentity(pending, UNKNOWN_SOURCE)) {
      pending.provider = source.provider;
      pending.api = source.api;
      pending.model = source.model;
    }
    return assistantFor(source);
  };
  for (const [itemIndex, item] of request.items.entries()) {
    if (item.type === "message" && (item.role === "system" || item.role === "developer")) {
      flushAssistant();
      const text = readableContent(item.content);
      if (!text) continue;
      if (!sawConversationItem) {
        // Leading preamble is identical on every request, so folding it into
        // the system prompt keeps the provider payload prefix stable.
        systemParts.push(text);
        continue;
      }
      // Mid-conversation system/developer notes arrive between turns (Claude
      // Code appends a `<total_tokens>` reminder after every tool result).
      // Folding them into the system prompt mutates the front of the provider
      // payload, so prefix-matching prompt caches miss and re-write the whole
      // conversation at cache-write prices. Keep them positional instead.
      appendPositionalNote(messages, text, timestamp);
      continue;
    }
    sawConversationItem = true;
    if (item.type === "message" && item.role === "user") {
      flushAssistant();
      appendUserMessage(messages, userContent(item.content, item.contentShape, target), timestamp);
      continue;
    }
    if (item.type === "tool_result") {
      flushAssistant();
      const call = toolCalls.get(item.callId);
      messages.push({
        role: "toolResult",
        toolCallId: call?.id ?? item.callId,
        toolName: call?.name ?? item.name ?? "tool",
        content: toolResultContent(item.output, target),
        isError: item.isError ?? false,
        timestamp,
        ...(item.loadedTools?.length ? { addedToolNames: [...item.loadedTools] } : {}),
      });
      continue;
    }
    if (item.type === "reasoning_configuration") {
      if (!isOpenAIResponsesApi(target.api)) {
        throw new HttpError(
          400,
          "Reasoning configuration updates require a GPT-6 Responses model.",
          "unsupported_reasoning_configuration",
          "input"
        );
      }
      const assistant = assistantFor(target);
      assistant.content.push({
        type: "providerItem",
        item: {
          type: "configuration_update",
          reasoning: { effort: item.effort === "off" ? "none" : item.effort },
        },
        name: "providerItem",
        arguments: {},
      });
      continue;
    }
    if (item.type === "reasoning") {
      const continuation = compatibleProviderContinuation(item.continuation, target);
      if (continuation) {
        const assistant = assistantForReasoning(continuation.source);
        const firstNonReasoning = assistant.content.findIndex((content) => content.type !== "thinking");
        assistant.content.splice(
          firstNonReasoning === -1 ? assistant.content.length : firstNonReasoning,
          0,
          thinkingContent(item, continuation)
        );
        // Managed-effort Claude models bind each thinking block to the prefix
        // it was generated under, which ended in an effort marker. Pi only
        // re-inserts that marker before turns that carry their level; without
        // it the API silently drops the replayed block.
        if (continuation.kind !== "openai_reasoning" && continuation.effort !== undefined) {
          assistant.providerThinkingLevel = continuation.effort;
        }
      } else {
        const readable = [...item.summary, ...item.content].join("\n");
        if (readable) {
          const assistant = assistantForReasoning(item.source ?? item.continuation?.source ?? UNKNOWN_SOURCE);
          const firstToolCall = assistant.content.findIndex((content) => content.type === "toolCall");
          assistant.content.splice(firstToolCall === -1 ? assistant.content.length : firstToolCall, 0, {
            type: "text",
            text: portableReasoningText(request.items, itemIndex, readable, target),
          });
        }
      }
      continue;
    }
    if (item.type === "tool_call") {
      const assistant = assistantFor(pending ? identityOf(pending) : UNKNOWN_SOURCE);
      const id = providerToolCallId(item.callId, item.id, target.api);
      const name = toolWireName(item.namespace, item.name);
      assistant.content.push({
        type: "toolCall",
        id,
        name,
        arguments: toolArguments(item.kind, item.input),
      });
      toolCalls.set(item.callId, { id, name });
      continue;
    }
    if (item.type === "compaction") {
      // Routing narrows compaction-bearing requests to native-compaction targets.
      if (!isOpenAIResponsesApi(target.api)) {
        throw new HttpError(400, "Native compaction state can only be sent to OpenAI Responses models.", "unsupported_response_item", "input");
      }
      assistantFor(item.source ?? target).content.push({
        type: "providerItem",
        item: item.payload,
        name: "providerItem",
        arguments: item.payload,
      });
      continue;
    }
    if (item.type === "hosted_tool_call") {
      if (item.tool === "server_tool_use" || item.tool === "tool_search") {
        // Server tool use and tool search results are Anthropic-specific.
        // Handle them before the generic OpenAI Responses branch to avoid
        // emitting Anthropic-shaped payloads as Responses provider items.
        if (target.api === "anthropic-messages") {
          // Round-trip preservation when routing to Anthropic.
          if (item.tool === "server_tool_use") {
            const assistant = assistantFor(item.source ?? target);
            assistant.content.push({
              type: "serverToolCall",
              id: item.serverToolUseId ?? item.id,
              name: item.serverToolName ?? "tool",
              arguments: item.serverToolInput ?? {},
            });
          } else {
            const assistant = assistantFor(item.source ?? target);
            assistant.content.push({
              type: "toolSearchResult",
              toolUseId: item.serverToolUseId ?? item.id,
              content: (item.serverToolResult ?? []).map((ref) => ({
                type: "tool_reference",
                tool_name: ref.toolName,
              })),
            });
          }
        } else {
          // Emit as text for non-Anthropic providers at reduced fidelity.
          // Append to the current assistant turn to avoid splitting it with a
          // fabricated user message.
          const assistant = assistantFor(item.source ?? target);
          assistant.content.push({
            type: "text",
            text: `[Server tool ${item.serverToolName ?? item.tool}: ${JSON.stringify(item.payload)}]`,
          });
        }
      } else if (isOpenAIResponsesApi(target.api)) {
        const assistant = assistantFor(item.source ?? target);
        assistant.content.push({
          type: "providerItem",
          item: item.payload,
          // Pi's generic estimator treats non-text assistant blocks like tool calls.
          // These compatibility fields stay in process; the Responses adapter emits only `item`.
          name: "providerItem",
          arguments: item.payload,
        });
      }
      continue;
    }
    if (item.role === "assistant") {
      const assistant = assistantFor(item.source ?? (pending ? identityOf(pending) : UNKNOWN_SOURCE));
      for (const [contentIndex, content] of item.content.entries()) {
        if (content.type === "text") {
          const signatureId = item.id ?? (item.phase ? `msg_dari_${itemIndex}_${contentIndex}` : undefined);
          assistant.content.push({
            type: "text",
            text: content.text,
            ...(content.annotations?.length ? { annotations: content.annotations } : {}),
            ...(signatureId ? { textSignature: textSignature(signatureId, item.phase) } : {}),
          });
        } else {
          assistant.content.push({ type: "text", text: "(assistant image omitted)" });
        }
      }
    }
  }
  flushAssistant();

  const context: PiContext = { messages };
  if (systemParts.length > 0) context.systemPrompt = systemParts.join("\n\n");
  const clientTools = request.tools.filter(
    (tool): tool is Exclude<InteractionTool, { kind: "hosted" }> =>
      tool.kind !== "hosted" && (tool.kind !== "server_tool" || target.api === "anthropic-messages")
  );
  if (clientTools.length > 0) context.tools = clientTools.map((tool) => toolToPi(tool, target.api));
  return context;
}

function thinkingContent(
  item: Extract<InteractionItem, { type: "reasoning" }>,
  continuation: ProviderContinuationState
): Record<string, unknown> {
  if (continuation.kind === "openai_reasoning") {
    const providerItemId = continuation.providerItemId ?? item.id;
    return {
      type: "thinking",
      thinking: [...item.summary, ...item.content].join("\n"),
      thinkingSignature: encodeOpenAIReasoningSignature({
        ...(providerItemId ? { id: providerItemId } : {}),
        summary: item.summary,
        content: item.content,
        encryptedContent: continuation.encryptedContent,
      }),
    };
  }
  if (continuation.kind === "anthropic_thinking") {
    return {
      type: "thinking",
      thinking: continuation.thinking,
      thinkingSignature: continuation.signature,
    };
  }
  return {
    type: "thinking",
    thinking: "",
    thinkingSignature: continuation.data,
    redacted: true,
  };
}

function userContent(
  content: InteractionContent[],
  shape: "string" | "parts" | "null" | "absent",
  target: ProviderIdentity,
): string | Array<Record<string, unknown>> {
  if (shape !== "parts") return content.filter((part) => part.type === "text").map((part) => part.text).join("");
  return content.map((part) => contentToPi(part, target));
}

function appendPositionalNote(
  messages: Array<Record<string, unknown>>,
  text: string,
  timestamp: number,
): void {
  const previous = messages.at(-1);
  if (previous?.role === "toolResult") {
    previous.content = [...contentBlocks(previous.content), { type: "text", text }];
    return;
  }
  appendUserMessage(messages, [{ type: "text", text }], timestamp);
}

function appendUserMessage(
  messages: Array<Record<string, unknown>>,
  content: string | Array<Record<string, unknown>>,
  timestamp: number,
): void {
  const previous = messages.at(-1);
  if (previous?.role === "user") {
    previous.content = [...contentBlocks(previous.content), ...contentBlocks(content)];
    return;
  }
  messages.push({ role: "user", content, timestamp });
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
}

function toolResultContent(
  content: string | InteractionContent[] | null,
  target: ProviderIdentity,
): Array<Record<string, unknown>> {
  if (content === null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  // Anthropic emits tool_reference parts natively via addedToolNames, so
  // flattening them to synthetic text here would duplicate the names. Other
  // providers have no native tool_reference representation, so keep the text
  // fallback for them.
  const filtered = target.api === "anthropic-messages"
    ? content.filter((part) => part.type !== "tool_reference")
    : content;
  return filtered.map((part) => contentToPi(part, target));
}

function contentToPi(content: InteractionContent, target: ProviderIdentity): Record<string, unknown> {
  if (content.type === "text") return { type: "text", text: content.text };
  if (content.type === "tool_reference") return { type: "text", text: `Referenced tool: ${content.toolName}` };
  if (content.type === "document") {
    // Routing keeps PDFs on document-capable models; this guards direct callers.
    if (!apiSupportsDocumentInput(target.api)) {
      throw new HttpError(400, `PDF document input is not supported by the ${target.api} API.`, "unsupported_input_modality", "input.document");
    }
    return { type: "document", mimeType: content.mimeType, data: content.data };
  }
  const image = parseDataImageUrl(content.url);
  if (!image) {
    throw new HttpError(400, "Only base64 data URLs are supported for routed image input.", "invalid_request_error", "input.image_url");
  }
  return {
    type: "image",
    mimeType: image.mimeType,
    data: image.data,
    ...(content.detail !== undefined ? { detail: content.detail } : {}),
  };
}

function portableReasoningText(
  items: ReadonlyArray<InteractionItem>,
  itemIndex: number,
  readable: string,
  target: ProviderIdentity
): string {
  if (target.api !== "openai-completions") return readable;
  for (let index = itemIndex + 1; index < items.length; index += 1) {
    const next = items[index];
    if (next.type === "reasoning" || next.type === "tool_call") continue;
    if (next.type === "message" && next.role === "assistant") {
      return next.content.some((part) => part.type === "text" && part.text.length > 0)
        ? `${readable}\n\n`
        : readable;
    }
    break;
  }
  return readable;
}

function readableContent(content: InteractionContent[]): string {
  return content.map((part) => (part.type === "text" ? part.text : "(image omitted)")).join("\n");
}

function toolToPi(
  tool: Exclude<InteractionTool, { kind: "hosted" }>,
  targetApi: string,
): Record<string, unknown> {
  if (tool.kind === "client_tool" && targetApi === "anthropic-messages") {
    return {
      name: tool.name,
      type: tool.type,
      serverTool: true,
    };
  }
  const result: Record<string, unknown> = {
    name: (tool.kind === "server_tool" || tool.kind === "client_tool"
      ? tool.name
      : toolWireName(tool.namespace, tool.name)),
    // Anthropic rejects description on server tool definitions as an extra input.
    ...(tool.kind === "server_tool" ? {} : { description: tool.description ?? "" }),
  };
  if (tool.kind === "function") {
    result.parameters = tool.parameters ?? { type: "object", properties: {} };
    if (tool.deferLoading !== undefined) result.deferLoading = tool.deferLoading;
  } else if (tool.kind === "server_tool") {
    // Server tools are Anthropic-specific; Pi doesn't handle them. We pass
    // the type through so the Pi adapter can preserve it for Anthropic.
    result.type = tool.type;
    // Server tools don't have input_schema; but Pi's convertTools would add one
    // if we set parameters. Mark it to skip the schema.
    result.serverTool = true;
  } else if (tool.kind === "client_tool") {
    result.parameters = { type: "object", properties: {}, additionalProperties: true };
  } else {
    result.parameters = {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
      additionalProperties: false,
    };
  }
  return result;
}

function toolArguments(kind: "function" | "custom", input: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (kind === "custom") return { input: typeof input === "string" ? input : "" };
  if (input && typeof input === "object") return input;
  if (typeof input !== "string" || input.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new HttpError(400, "Function tool arguments must contain a JSON object.", "invalid_request_error", "input.arguments");
  }
  if (!isRecord(parsed)) {
    throw new HttpError(400, "Function tool arguments must contain a JSON object.", "invalid_request_error", "input.arguments");
  }
  return parsed;
}

function textSignature(id: string, phase: "commentary" | "final_answer" | undefined): string {
  return JSON.stringify({ v: 1, id, ...(phase ? { phase } : {}) });
}

function identityOf(value: Pick<PiAssistant, "provider" | "api" | "model">): ProviderIdentity {
  return { provider: value.provider, api: value.api, model: value.model };
}

function zeroUsage(): Record<string, unknown> {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
