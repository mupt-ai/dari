import { isReasoningEffort, isRecord, type ReasoningEffort } from "@mupt-ai/dari-router/policy-engine";

import { HttpError } from "../../http/errors.js";
import { parseDataImageUrl } from "../../interaction/image.js";
import { decodeUntrustedProviderContinuationState } from "../../interaction/provider_continuation_state.js";
import { decodeUntrustedPortableReasoningState } from "../../interaction/portable_reasoning_state.js";
import { toolsByWireName } from "../../interaction/tool_identity.js";
import { explicitModelId, isAnthropicRouterModel, unsupportedModelMessage } from "./router_model.js";
import type {
  ClientTool,
  InteractionContent,
  InteractionDocument,
  InteractionItem,
  InteractionRequest,
  InteractionResponseFormat,
  InteractionTool,
  InteractionToolChoice,
  InteractionToolReference,
  ReasoningControls,
  ServerToolKind,
} from "../../interaction/types.js";

const SUPPORTED_SERVER_TOOL_TYPES: readonly ServerToolKind[] = [
  "bash_20250124",
  "text_editor_20250124",
  "tool_search_tool_20250919",
  "tool_search_tool_regex_20250919",
  "tool_search_tool_regex",
  "tool_search_tool_regex_20251119",
  "tool_search_tool_bm25",
  "tool_search_tool_bm25_20251119",
] as const;

const isServerToolType = (type: string): type is ServerToolKind =>
  SUPPORTED_SERVER_TOOL_TYPES.includes(type as ServerToolKind);

export function anthropicMessagesToInteraction(
  payload: Record<string, unknown>,
): InteractionRequest {
  const model = requiredString(payload.model, "model");
  if (!isAnthropicRouterModel(model) && explicitModelId(model) === null) {
    throw invalidRequest(unsupportedModelMessage(), "model");
  }

  const tools = anthropicTools(payload.tools);
  toolsByWireName(tools);
  const toolChoice = anthropicToolChoice(payload.tool_choice);
  const maxOutputTokens = requiredPositiveInteger(payload.max_tokens, "max_tokens");
  const stream = optionalBoolean(payload.stream, "stream") ?? false;
  const sessionId = metadataSessionId(payload.metadata);

  return {
    sourceProtocol: "anthropic_messages",
    model,
    instructions: anthropicSystem(payload.system),
    items: anthropicItems(payload.messages),
    tools,
    toolChoice,
    parallelToolCalls: parallelToolCalls(payload.tool_choice),
    generation: {
      temperature: optionalNumber(payload.temperature, "temperature"),
      topP: optionalNumber(payload.top_p, "top_p"),
      maxOutputTokens,
      stop: stopSequences(payload.stop_sequences),
    },
    reasoning: anthropicReasoning(payload.thinking, payload.output_config),
    responseFormat: anthropicResponseFormat(payload.output_config),
    stream,
    metadata: optionalRecord(payload.metadata, "metadata"),
    user: metadataUser(payload.metadata),
    ...(sessionId !== undefined ? { promptCacheKey: sessionId } : {}),
  };
}

function anthropicItems(value: unknown): InteractionItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidRequest("messages must be a non-empty array.", "messages");
  }

  const items: InteractionItem[] = [];
  for (const [messageIndex, rawMessage] of value.entries()) {
    if (!isRecord(rawMessage)) {
      throw invalidRequest(`messages[${messageIndex}] must be an object.`, `messages.${messageIndex}`);
    }
    const role = requiredString(rawMessage.role, `messages.${messageIndex}.role`);
    if (role !== "system" && role !== "user" && role !== "assistant") {
      throw invalidRequest(`Unsupported Anthropic message role '${role}'.`, `messages.${messageIndex}.role`);
    }
    appendAnthropicMessage(items, role, rawMessage.content, messageIndex);
  }
  return items;
}

function appendAnthropicMessage(
  items: InteractionItem[],
  role: "system" | "user" | "assistant",
  value: unknown,
  messageIndex: number
): void {
  if (typeof value === "string") {
    items.push({
      type: "message",
      role,
      content: [{ type: "text", text: value }],
      contentShape: "string",
    });
    return;
  }
  if (!Array.isArray(value)) {
    throw invalidRequest(
      `messages[${messageIndex}].content must be a string or an array.`,
      `messages.${messageIndex}.content`
    );
  }

  let buffered: InteractionContent[] = [];
  const flushMessage = () => {
    if (buffered.length === 0) return;
    items.push({ type: "message", role, content: buffered, contentShape: "parts" });
    buffered = [];
  };
  let pendingServerToolUse: { callId: string; name: string; input: Record<string, unknown> } | null = null;

  for (const [contentIndex, rawBlock] of value.entries()) {
    const param = `messages.${messageIndex}.content.${contentIndex}`;
    if (!isRecord(rawBlock)) throw invalidRequest(`${param} must be an object.`, param);
    const type = requiredString(rawBlock.type, `${param}.type`);

    if (type === "text") {
      buffered.push({ type: "text", text: requiredStringAllowEmpty(rawBlock.text, `${param}.text`) });
      continue;
    }
    if (type === "image") {
      if (role !== "user") throw invalidRequest("Anthropic image blocks are only supported on user messages.", param);
      buffered.push(anthropicImage(rawBlock.source, `${param}.source`));
      continue;
    }
    if (type === "document") {
      if (role !== "user") throw invalidRequest("Anthropic document blocks are only supported on user messages.", param);
      buffered.push(...anthropicDocument(rawBlock, param));
      continue;
    }
    if (type === "search_result") {
      if (role !== "user") throw invalidRequest("Anthropic search_result blocks are only supported on user messages.", param);
      buffered.push(anthropicSearchResult(rawBlock, param));
      continue;
    }
    if (type === "thinking" || type === "redacted_thinking") {
      if (role !== "assistant") throw invalidRequest(`${type} blocks require the assistant role.`, param);
      flushMessage();
      items.push(anthropicReasoningItem(rawBlock, type, param));
      continue;
    }
    if (type === "tool_use") {
      if (role !== "assistant") throw invalidRequest("tool_use blocks require the assistant role.", param);
      flushMessage();
      const input = rawBlock.input;
      if (!isRecord(input)) throw invalidRequest(`${param}.input must be an object.`, `${param}.input`);
      items.push({
        type: "tool_call",
        callId: requiredString(rawBlock.id, `${param}.id`),
        kind: "function",
        name: requiredString(rawBlock.name, `${param}.name`),
        input,
        status: "completed",
      });
      continue;
    }
    if (type === "server_tool_use") {
      if (role !== "assistant") throw invalidRequest("server_tool_use blocks require the assistant role.", param);
      flushMessage();
      const serverId = requiredString(rawBlock.id, `${param}.id`);
      const serverName = requiredString(rawBlock.name, `${param}.name`);
      const serverInput = isRecord(rawBlock.input) ? rawBlock.input : {};
      pendingServerToolUse = { callId: serverId, name: serverName, input: serverInput };
      items.push({
        type: "hosted_tool_call",
        id: serverId,
        tool: "server_tool_use",
        providerType: "server_tool_use",
        payload: { id: serverId, name: serverName, input: serverInput },
        serverToolUseId: serverId,
        serverToolName: serverName,
        serverToolInput: serverInput,
      });
      continue;
    }
    if (type === "tool_search_tool_result") {
      if (role !== "assistant") throw invalidRequest("tool_search_tool_result blocks require the assistant role.", param);
      flushMessage();
      const toolUseId = requiredString(rawBlock.tool_use_id, `${param}.tool_use_id`);
      const resultContent = rawBlock.content;
      if (!Array.isArray(resultContent)) {
        throw invalidRequest("tool_search_tool_result blocks require a content array.", `${param}.content`);
      }
      const references: InteractionToolReference[] = [];
      for (const [refIndex, refBlock] of resultContent.entries()) {
        if (!isRecord(refBlock) || refBlock.type !== "tool_reference") {
          throw invalidRequest(`tool_search_tool_result content.${refIndex} must be a tool_reference block.`, `${param}.content.${refIndex}`);
        }
        references.push({
          type: "tool_reference",
          toolName: requiredString(refBlock.tool_name, `${param}.content.${refIndex}.tool_name`),
        });
      }
      const serverToolUse = pendingServerToolUse?.callId === toolUseId ? pendingServerToolUse : null;
      if (serverToolUse) pendingServerToolUse = null;
      items.push({
        type: "hosted_tool_call",
        id: `${toolUseId}_result`,
        tool: "tool_search",
        providerType: "tool_search_result",
        payload: {
          tool_use_id: toolUseId,
          content: references,
          ...(serverToolUse ? { name: serverToolUse.name, input: serverToolUse.input } : {}),
        },
        serverToolUseId: toolUseId,
        serverToolName: serverToolUse?.name,
        serverToolInput: serverToolUse?.input,
        serverToolResult: references,
      });
      continue;
    }
    if (type === "tool_result") {
      if (role !== "user") throw invalidRequest("tool_result blocks require the user role.", param);
      flushMessage();
      const result = anthropicToolResultContent(rawBlock.content, `${param}.content`);
      const loadedTools = result.output
        ? (Array.isArray(result.output)
            ? result.output.flatMap((part) =>
                part.type === "tool_reference" ? [part.toolName] : []
              )
            : [])
        : [];
      // Deduplicate and filter out any empty names
      const uniqueLoadedTools = [...new Set(loadedTools)].filter(Boolean);
      items.push({
        type: "tool_result",
        callId: requiredString(rawBlock.tool_use_id, `${param}.tool_use_id`),
        kind: "function",
        output: result.output,
        outputShape: result.shape,
        isError: optionalBoolean(rawBlock.is_error, `${param}.is_error`),
        ...(uniqueLoadedTools.length > 0 ? { loadedTools: uniqueLoadedTools } : {}),
      });
      continue;
    }
    throw new HttpError(400, `Anthropic content block type '${type}' is not supported.`, "unsupported_content_block", param);
  }
  flushMessage();
}

/* PDFs stay native documents; they route only to models that read PDFs.
   Text and content documents become ordinary parts so every model can read
   them. Title and context travel as a leading text part. Citations are not
   requested from the provider, so the citations setting is dropped. */
function anthropicDocument(block: Record<string, unknown>, param: string): InteractionContent[] {
  const source = block.source;
  const sourceParam = `${param}.source`;
  if (!isRecord(source)) throw invalidRequest(`${sourceParam} must be an object.`, sourceParam);
  const header = [optionalString(block.title, `${param}.title`), optionalString(block.context, `${param}.context`)]
    .filter((line): line is string => line !== undefined && line.length > 0)
    .join("\n");
  const withHeader = (body: InteractionContent[]): InteractionContent[] =>
    header ? [{ type: "text", text: `Document: ${header}` }, ...body] : body;
  const type = requiredString(source.type, `${sourceParam}.type`);
  if (type === "base64") {
    const mediaType = requiredString(source.media_type, `${sourceParam}.media_type`);
    if (mediaType !== "application/pdf") {
      throw new HttpError(400, "Base64 document sources must be application/pdf.", "unsupported_document_source", `${sourceParam}.media_type`);
    }
    const document: InteractionDocument = { type: "document", mimeType: "application/pdf", data: requiredString(source.data, `${sourceParam}.data`) };
    return withHeader([document]);
  }
  if (type === "text") {
    return withHeader([{ type: "text", text: requiredStringAllowEmpty(source.data, `${sourceParam}.data`) }]);
  }
  if (type === "content") {
    if (typeof source.content === "string") return withHeader([{ type: "text", text: source.content }]);
    if (!Array.isArray(source.content)) throw invalidRequest(`${sourceParam}.content must be a string or an array.`, `${sourceParam}.content`);
    return withHeader(source.content.map((part, index): InteractionContent => {
      const partParam = `${sourceParam}.content.${index}`;
      if (!isRecord(part)) throw invalidRequest(`${partParam} must be an object.`, partParam);
      if (part.type === "text") return { type: "text", text: requiredStringAllowEmpty(part.text, `${partParam}.text`) };
      if (part.type === "image") return anthropicImage(part.source, `${partParam}.source`);
      throw new HttpError(400, `Document content block type '${String(part.type ?? "unknown")}' is not supported.`, "unsupported_content_block", partParam);
    }));
  }
  throw new HttpError(
    400,
    `Anthropic document source type '${type}' is not supported; use a base64 PDF, text, or content source.`,
    "unsupported_document_source",
    `${sourceParam}.type`
  );
}

// Search results are text with provenance; they reach every model as text.
function anthropicSearchResult(block: Record<string, unknown>, param: string): InteractionContent {
  const title = requiredStringAllowEmpty(block.title, `${param}.title`);
  const source = requiredStringAllowEmpty(block.source, `${param}.source`);
  if (!Array.isArray(block.content)) throw invalidRequest(`${param}.content must be an array.`, `${param}.content`);
  const body = block.content.map((part, index) => {
    const partParam = `${param}.content.${index}`;
    if (!isRecord(part) || part.type !== "text") throw invalidRequest(`${partParam} must be a text block.`, partParam);
    return requiredStringAllowEmpty(part.text, `${partParam}.text`);
  });
  return { type: "text", text: [`Search result: ${title}`, `Source: ${source}`, "", ...body].join("\n") };
}

function anthropicImage(value: unknown, param: string): InteractionContent {
  if (!isRecord(value)) throw invalidRequest(`${param} must be an object.`, param);
  const type = requiredString(value.type, `${param}.type`);
  if (type === "base64") {
    const mediaType = requiredString(value.media_type, `${param}.media_type`);
    if (!mediaType.startsWith("image/")) throw invalidRequest(`${param}.media_type must be an image MIME type.`, `${param}.media_type`);
    const data = requiredString(value.data, `${param}.data`);
    const url = `data:${mediaType};base64,${data}`;
    if (!parseDataImageUrl(url)) throw invalidRequest(`${param} must contain a base64 image.`, param);
    return { type: "image", url };
  }
  if (type === "url") {
    throw new HttpError(
      400,
      "Anthropic URL image sources are not supported; use a base64 image source.",
      "unsupported_image_source",
      `${param}.type`
    );
  }
  throw new HttpError(400, `Anthropic image source type '${type}' is not supported.`, "unsupported_image_source", `${param}.type`);
}

function anthropicReasoningItem(
  block: Record<string, unknown>,
  type: "thinking" | "redacted_thinking",
  param: string
): Extract<InteractionItem, { type: "reasoning" }> {
  const encoded = requiredString(
    type === "thinking" ? block.signature : block.data,
    `${param}.${type === "thinking" ? "signature" : "data"}`
  );
  const continuation = decodeUntrustedProviderContinuationState(encoded);
  const portable = continuation ? null : decodeUntrustedPortableReasoningState(encoded);
  if (!continuation && !portable) {
    const field = type === "thinking" ? "signature" : "data";
    throw new HttpError(
      400,
      `${param}.${field} must be a Dari reasoning-state envelope; raw provider state has no recoverable provider/model provenance.`,
      "invalid_provider_continuation_state",
      `${param}.${field}`,
    );
  }
  const thinking = type === "thinking" ? requiredStringAllowEmpty(block.thinking, `${param}.thinking`) : "";
  const reasoning: Extract<InteractionItem, { type: "reasoning" }> = {
    type: "reasoning",
    summary: thinking ? [thinking] : [],
    content: [],
  };
  if (continuation) {
    reasoning.source = continuation.source;
    reasoning.continuation = continuation;
  } else if (portable?.source) {
    reasoning.source = portable.source;
  }
  return reasoning;
}

function anthropicToolResultContent(
  value: unknown,
  param: string
): { output: string | InteractionContent[] | null; shape: "string" | "parts" | "null" | "absent" } {
  if (value === undefined) return { output: null, shape: "absent" };
  if (value === null) return { output: null, shape: "null" };
  if (typeof value === "string") return { output: value, shape: "string" };
  if (!Array.isArray(value)) throw invalidRequest(`${param} must be a string or an array.`, param);
  return {
    output: value.flatMap((rawBlock, index): InteractionContent | InteractionContent[] => {
      const blockParam = `${param}.${index}`;
      if (!isRecord(rawBlock)) throw invalidRequest(`${blockParam} must be an object.`, blockParam);
      if (rawBlock.type === "text") {
        return { type: "text", text: requiredStringAllowEmpty(rawBlock.text, `${blockParam}.text`) };
      }
      if (rawBlock.type === "image") return anthropicImage(rawBlock.source, `${blockParam}.source`);
      if (rawBlock.type === "document") return anthropicDocument(rawBlock, blockParam);
      if (rawBlock.type === "search_result") return [anthropicSearchResult(rawBlock, blockParam)];
      if (rawBlock.type === "tool_reference") {
        return {
          type: "tool_reference",
          toolName: requiredString(rawBlock.tool_name, `${blockParam}.tool_name`),
        } satisfies InteractionToolReference;
      }
      throw new HttpError(
        400,
        `Anthropic tool result block type '${String(rawBlock.type ?? "unknown")}' is not supported.`,
        "unsupported_content_block",
        blockParam
      );
    }),
    shape: "parts",
  };
}

function anthropicSystem(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw invalidRequest("system must be a string or an array.", "system");
  return value.map((rawBlock, index) => {
    if (!isRecord(rawBlock) || rawBlock.type !== "text") {
      throw new HttpError(400, "Only text system blocks are supported.", "unsupported_content_block", `system.${index}`);
    }
    return requiredStringAllowEmpty(rawBlock.text, `system.${index}.text`);
  }).join("\n\n");
}

function anthropicTools(value: unknown): InteractionTool[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidRequest("tools must be an array.", "tools");
  return value.map((rawTool, index) => {
    if (!isRecord(rawTool)) throw invalidRequest(`tools[${index}] must be an object.`, `tools.${index}`);
    const type = rawTool.type;
    if (type !== undefined && type !== "custom") {
      if (typeof type === "string" && isServerToolType(type)) {
        if (type === "bash_20250124" || type === "text_editor_20250124") {
          return {
            kind: "client_tool",
            name: requiredString(rawTool.name, `tools.${index}.name`),
            type,
            description: optionalString(rawTool.description, `tools.${index}.description`),
          } satisfies ClientTool;
        }
        return {
          kind: "server_tool" as const,
          name: requiredString(rawTool.name, `tools.${index}.name`),
          type,
          description: optionalString(rawTool.description, `tools.${index}.description`),
        };
      }
      throw new HttpError(
        400,
        `Anthropic tool type '${String(type)}' is not supported by this router.`,
        "unsupported_tool",
        `tools.${index}.type`
      );
    }
    const schema = rawTool.input_schema;
    if (!isRecord(schema)) throw invalidRequest(`tools[${index}].input_schema must be an object.`, `tools.${index}.input_schema`);
    return {
      kind: "function" as const,
      name: requiredString(rawTool.name, `tools.${index}.name`),
      description: optionalString(rawTool.description, `tools.${index}.description`),
      parameters: schema,
      strict: optionalBoolean(rawTool.strict, `tools.${index}.strict`),
      deferLoading: optionalBoolean(rawTool.defer_loading, `tools.${index}.defer_loading`),
    };
  });
}

function anthropicToolChoice(value: unknown): InteractionToolChoice | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw invalidRequest("tool_choice must be an object.", "tool_choice");
  const type = requiredString(value.type, "tool_choice.type");
  if (type === "auto" || type === "any" || type === "none") return type;
  if (type === "tool") return { kind: "function", name: requiredString(value.name, "tool_choice.name") };
  throw invalidRequest(`Unsupported Anthropic tool choice '${type}'.`, "tool_choice.type");
}

function parallelToolCalls(value: unknown): boolean | undefined {
  if (!isRecord(value) || value.disable_parallel_tool_use === undefined) return undefined;
  return !requiredBoolean(value.disable_parallel_tool_use, "tool_choice.disable_parallel_tool_use");
}

function anthropicReasoning(thinkingValue: unknown, outputConfigValue: unknown): ReasoningControls | undefined {
  const effort = anthropicEffort(outputConfigValue);
  if (thinkingValue === undefined || thinkingValue === null) {
    return effort ? { effort, enabled: effort !== "off" } : undefined;
  }
  if (!isRecord(thinkingValue)) throw invalidRequest("thinking must be an object.", "thinking");
  const type = requiredString(thinkingValue.type, "thinking.type");
  if (type === "disabled") return { effort: effort ?? "off", enabled: false };
  if (type !== "enabled" && type !== "adaptive") {
    throw invalidRequest(`Unsupported Anthropic thinking type '${type}'.`, "thinking.type");
  }
  const budgetTokens = type === "enabled"
    ? requiredPositiveInteger(thinkingValue.budget_tokens, "thinking.budget_tokens")
    : undefined;
  return {
    ...(effort ? { effort } : {}),
    enabled: true,
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
  };
}

function anthropicEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw invalidRequest("output_config must be an object.", "output_config");
  if (value.effort === undefined || value.effort === null) return undefined;
  const effort = requiredString(value.effort, "output_config.effort");
  if (
    !isReasoningEffort(effort)
    || (effort !== "low" && effort !== "medium" && effort !== "high" && effort !== "xhigh" && effort !== "max")
  ) {
    throw invalidRequest(`Unsupported Anthropic effort '${effort}'.`, "output_config.effort");
  }
  return effort;
}

function anthropicResponseFormat(value: unknown): InteractionResponseFormat | undefined {
  if (!isRecord(value) || value.format === undefined || value.format === null) return undefined;
  if (!isRecord(value.format)) throw invalidRequest("output_config.format must be an object.", "output_config.format");
  if (value.format.type !== "json_schema") {
    throw new HttpError(400, "Only Anthropic json_schema output formats are supported.", "unsupported_response_format", "output_config.format.type");
  }
  const schema = value.format.schema;
  if (!isRecord(schema)) throw invalidRequest("output_config.format.schema must be an object.", "output_config.format.schema");
  return {
    type: "json_schema",
    name: optionalString(value.format.name, "output_config.format.name") ?? "response",
    schema,
  };
}

function stopSequences(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalidRequest("stop_sequences must be an array of strings.", "stop_sequences");
  }
  return value;
}

function metadataUser(value: unknown): string | undefined {
  return isRecord(value) && typeof value.user_id === "string" ? value.user_id : undefined;
}

/**
 * Anthropic Messages has no prompt-cache field, but Claude Code packs a JSON
 * object into metadata.user_id whose session_id changes per conversation. Only
 * that member identifies a conversation — the surrounding device and account
 * ids are shared by every conversation on the machine, so keying provider
 * cache affinity on the raw string would collide across concurrent sessions.
 */
function metadataSessionId(value: unknown): string | undefined {
  const userId = metadataUser(value);
  if (!userId) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(userId);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.session_id !== "string") return undefined;
  return parsed.session_id.trim() || undefined;
}

function optionalRecord(value: unknown, param: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw invalidRequest(`${param} must be an object.`, param);
  return value;
}

function optionalString(value: unknown, param: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalidRequest(`${param} must be a string.`, param);
  return value;
}

function requiredString(value: unknown, param: string): string {
  if (typeof value !== "string" || !value) throw invalidRequest(`${param} must be a non-empty string.`, param);
  return value;
}

function requiredStringAllowEmpty(value: unknown, param: string): string {
  if (typeof value !== "string") throw invalidRequest(`${param} must be a string.`, param);
  return value;
}

function optionalNumber(value: unknown, param: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidRequest(`${param} must be a finite number.`, param);
  return value;
}

function optionalBoolean(value: unknown, param: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredBoolean(value, param);
}

function requiredBoolean(value: unknown, param: string): boolean {
  if (typeof value !== "boolean") throw invalidRequest(`${param} must be a boolean.`, param);
  return value;
}

function requiredPositiveInteger(value: unknown, param: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalidRequest(`${param} must be a positive integer.`, param);
  }
  return value;
}

function invalidRequest(message: string, param?: string): HttpError {
  return new HttpError(400, message, "invalid_request_error", param);
}
