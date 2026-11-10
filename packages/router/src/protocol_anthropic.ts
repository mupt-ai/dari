import {
  decodeUntrustedProviderContinuationState,
  encodeProviderContinuationState,
  type ProviderContinuationState,
} from "./continuation_state.js";
import {
  decodeUntrustedPortableReasoningState,
  encodePortableReasoningState,
} from "./portable_reasoning_state.js";
import { RouterFrameworkError } from "./framework_error.js";
import {
  dariRoutingPayload,
  invalidProtocolRequest as invalid,
  isAllEmptyText,
  optionalBoolean,
  optionalCacheKey,
  optionalNumberInRange,
  optionalRecord,
  optionalString,
  portableTool,
  positiveInteger,
  prefixedWireId,
  rejectUnknownFields,
  requiredString,
  stopSequenceValues,
  validateToolChoice,
} from "./protocol_validation.js";
import { isReasoningEffort, isRecord, type ReasoningEffort } from "./types.js";
import type {
  RouterCompletion,
  RouterContent,
  RouterRequest,
  RouterResponseFormat,
  RouterSelection,
  RouterTool,
  RouterToolChoice,
} from "./framework_types.js";

export function anthropicRequest(payload: unknown): RouterRequest {
  if (!isRecord(payload)) throw invalid("Request body must be a JSON object.");
  rejectUnknownFields(payload, [
    "model",
    "max_tokens",
    "messages",
    "system",
    "tools",
    "tool_choice",
    "thinking",
    "output_config",
    "temperature",
    "top_p",
    "stop_sequences",
    "stream",
    "metadata",
    // Dari extension: optional conversation key for lease correlation.
    "prompt_cache_key",
  ]);

  const requestedModel = requiredString(payload.model, "model");
  const maxOutputTokens = positiveInteger(payload.max_tokens, "max_tokens");
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw invalid("messages must be a non-empty array.", "messages");
  }

  const items: RouterRequest["items"] = [];
  const system = anthropicSystem(payload.system);
  if (system.length > 0) {
    items.push({ type: "message", role: "system", content: system });
  }
  for (const [messageIndex, message] of payload.messages.entries()) {
    const param = `messages.${messageIndex}`;
    if (!isRecord(message)) throw invalid(`${param} must be an object.`, param);
    rejectUnknownFields(message, ["role", "content"], param);
    const role = requiredString(message.role, `${param}.role`);
    if (role !== "user" && role !== "assistant") {
      throw invalid(`${param}.role must be 'user' or 'assistant'.`, `${param}.role`);
    }
    appendAnthropicContent(items, role, message.content, param);
  }

  const tools = anthropicTools(payload.tools);
  const toolChoice = anthropicToolChoice(payload.tool_choice);
  validateToolChoice(toolChoice.choice, tools);
  if (toolChoice.parallel !== undefined && tools.length === 0) {
    throw invalid("tool_choice requires at least one tool.", "tool_choice");
  }
  const temperature = optionalNumberInRange(payload.temperature, "temperature", 0, 1);
  const topP = optionalNumberInRange(payload.top_p, "top_p", 0, 1);
  const stop = stopSequenceValues(payload.stop_sequences, "stop_sequences", false);
  const outputConfig = anthropicOutputConfig(payload.output_config);
  const reasoning = anthropicReasoning(payload.thinking, outputConfig.effort);
  const responseFormat = outputConfig.format;
  const stream = optionalBoolean(payload.stream, "stream") ?? false;
  const cacheKey = optionalCacheKey(payload.prompt_cache_key, "prompt_cache_key");
  const metadata = optionalRecord(payload.metadata, "metadata");
  const user = metadata === undefined
    ? undefined
    : optionalString(metadata.user_id, "metadata.user_id");

  return {
    protocol: "anthropic_messages",
    requestedModel,
    items,
    tools,
    ...(toolChoice.choice === undefined ? {} : { toolChoice: toolChoice.choice }),
    ...(toolChoice.parallel === undefined ? {} : { parallelToolCalls: toolChoice.parallel }),
    generation: {
      maxOutputTokens,
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { topP }),
      ...(stop === undefined ? {} : { stop }),
    },
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(responseFormat === undefined ? {} : { responseFormat }),
    stream,
    ...(cacheKey === undefined ? {} : { cacheKey }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(user === undefined ? {} : { user }),
  };
}

export function anthropicResponse<Metadata>(args: {
  id: string;
  model: string;
  requestedModel: string;
  output: RouterCompletion;
  selection: RouterSelection<Metadata>;
}): Record<string, unknown> {
  return {
    id: prefixedWireId(args.output.id ?? args.id, "msg_"),
    type: "message",
    role: "assistant",
    model: args.model,
    content: anthropicOutputContent(args.output),
    stop_reason: anthropicStopReason(args.output.finishReason),
    stop_sequence: null,
    usage: anthropicUsage(args.output.usage),
    dari_routing: dariRoutingPayload(args.requestedModel, args.selection),
  };
}

export function anthropicOutputContent(output: RouterCompletion): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  for (const [index, item] of output.content.entries()) {
    if (item.type === "text") {
      content.push({ type: "text", text: item.text });
      continue;
    }
    if (item.type === "reasoning") {
      const encoded = item.continuation
        ? encodeProviderContinuationState(item.continuation)
        : encodePortableReasoningState({ source: item.source, itemId: `reasoning_${index}` });
      if (item.redacted || item.continuation?.kind === "anthropic_redacted_thinking") {
        content.push({ type: "redacted_thinking", data: encoded });
      } else {
        content.push({ type: "thinking", thinking: item.text, signature: encoded });
      }
      continue;
    }
    if (item.type === "hosted_tool_call") {
      throw new RouterFrameworkError(
        "configuration",
        "Hosted tool calls are not representable on the anthropic_messages protocol; route hosted-tool models over the OpenAI protocol.",
        "hosted_tool_call_unrepresentable",
      );
    }
    content.push({
      type: "tool_use",
      id: item.id,
      name: item.name,
      input: toolArguments(item.arguments),
    });
  }
  return content.length > 0 ? content : [{ type: "text", text: "" }];
}

export function anthropicStopReason(reason: RouterCompletion["finishReason"]): string {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls") return "tool_use";
  return "end_turn";
}

// Anthropic semantics: input_tokens excludes cache reads/writes, which are
// reported as the separate cache_read_input_tokens and
// cache_creation_input_tokens fields — matching RouterUsage, where
// inputTokens is likewise cache-exclusive.
export function anthropicUsage(usage: RouterCompletion["usage"]): Record<string, unknown> {
  return {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    ...(usage?.cacheReadTokens === undefined
      ? {}
      : { cache_read_input_tokens: usage.cacheReadTokens }),
    ...(usage?.cacheWriteTokens === undefined
      ? {}
      : { cache_creation_input_tokens: usage.cacheWriteTokens }),
  };
}

export function anthropicMessageStart<Metadata>(args: {
  id: string;
  model: string;
  requestedModel: string;
  selection: RouterSelection<Metadata>;
}): Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      id: prefixedWireId(args.id, "msg_"),
      type: "message",
      role: "assistant",
      model: args.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
      dari_routing: dariRoutingPayload(args.requestedModel, args.selection),
    },
  };
}

function appendAnthropicContent(
  items: RouterRequest["items"],
  role: "user" | "assistant",
  value: unknown,
  messageParam: string,
): void {
  if (typeof value === "string") {
    items.push({ type: "message", role, content: [{ type: "text", text: value }] });
    return;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(`${messageParam}.content must be a string or non-empty array.`, `${messageParam}.content`);
  }

  const hasToolUse = role === "assistant" && value.some(
    (block) => isRecord(block) && block.type === "tool_use",
  );
  let buffered: RouterContent[] = [];
  const flush = () => {
    if (buffered.length === 0) return;
    if (!hasToolUse || !isAllEmptyText(buffered)) {
      items.push({ type: "message", role, content: buffered });
    }
    buffered = [];
  };
  for (const [blockIndex, block] of value.entries()) {
    const param = `${messageParam}.content.${blockIndex}`;
    if (!isRecord(block)) throw invalid(`${param} must be an object.`, param);
    if (block.type === "text") {
      rejectUnknownFields(block, ["type", "text"], param);
      if (typeof block.text !== "string") throw invalid(`${param}.text must be a string.`, `${param}.text`);
      buffered.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      rejectUnknownFields(block, ["type", "source"], param);
      if (role !== "user") throw invalid("Image blocks require the user role.", param);
      buffered.push(anthropicImage(block.source, `${param}.source`));
      continue;
    }
    if (block.type === "tool_use") {
      rejectUnknownFields(block, ["type", "id", "name", "input"], param);
      if (role !== "assistant" || !isRecord(block.input)) {
        throw invalid("tool_use blocks require the assistant role and object input.", param);
      }
      flush();
      items.push({
        type: "tool_call",
        id: requiredString(block.id, `${param}.id`),
        name: requiredString(block.name, `${param}.name`),
        arguments: block.input,
      });
      continue;
    }
    if (block.type === "tool_result") {
      rejectUnknownFields(
        block,
        ["type", "tool_use_id", "content", "is_error"],
        param,
      );
      if (role !== "user") throw invalid("tool_result blocks require the user role.", param);
      const isError = optionalBoolean(block.is_error, `${param}.is_error`);
      flush();
      items.push({
        type: "tool_result",
        toolCallId: requiredString(block.tool_use_id, `${param}.tool_use_id`),
        content: anthropicResultContent(block.content, `${param}.content`),
        ...(isError === undefined ? {} : { isError }),
      });
      continue;
    }
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      if (role !== "assistant") {
        throw invalid("Thinking blocks require the assistant role.", param);
      }
      flush();
      items.push(anthropicReasoningItem(block, param));
      continue;
    }
    throw new RouterFrameworkError(
      "invalid_request",
      `Anthropic content block '${String(block.type ?? "unknown")}' is not supported.`,
      "unsupported_content_block",
      `${param}.type`,
    );
  }
  flush();
}

function anthropicReasoningItem(
  block: Record<string, unknown>,
  param: string,
): Extract<RouterRequest["items"][number], { type: "reasoning" }> {
  const redacted = block.type === "redacted_thinking";
  rejectUnknownFields(
    block,
    redacted ? ["type", "data"] : ["type", "thinking", "signature"],
    param,
  );
  const field = redacted ? "data" : "signature";
  const encoded = requiredString(block[field], `${param}.${field}`);
  const continuation = decodeUntrustedProviderContinuationState(encoded);
  const portable = continuation ? null : decodeUntrustedPortableReasoningState(encoded);
  if (!continuation && !portable) {
    throw new RouterFrameworkError(
      "invalid_request",
      `${param}.${field} must be a Dari reasoning-state envelope; raw provider state has no recoverable provider/model provenance.`,
      "invalid_provider_continuation_state",
      `${param}.${field}`,
    );
  }
  const thinking = redacted ? "" : stringAllowEmpty(block.thinking, `${param}.thinking`);
  return {
    type: "reasoning",
    summary: thinking ? [thinking] : [],
    content: [],
    ...(continuation
      ? { source: continuation.source, continuation }
      : portable?.source
        ? { source: portable.source }
        : {}),
    ...(portable?.itemId ? { id: portable.itemId } : {}),
  };
}

function stringAllowEmpty(value: unknown, param: string): string {
  if (typeof value !== "string") throw invalid(`${param} must be a string.`, param);
  return value;
}

function anthropicSystem(value: unknown): RouterContent[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) throw invalid("system must be a string or array.", "system");
  return value.map((block, index) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      throw new RouterFrameworkError(
        "invalid_request",
        "Only text system blocks are supported.",
        "unsupported_content_block",
        `system.${index}`,
      );
    }
    rejectUnknownFields(block, ["type", "text"], `system.${index}`);
    return { type: "text" as const, text: block.text };
  });
}

function anthropicImage(value: unknown, param: string): RouterContent {
  if (!isRecord(value)) throw invalid(`${param} must be an object.`, param);
  if (value.type === "base64") {
    rejectUnknownFields(value, ["type", "media_type", "data"], param);
    const mediaType = requiredString(value.media_type, `${param}.media_type`);
    if (!mediaType.startsWith("image/")) {
      throw invalid(
        `${param}.media_type must be an image MIME type.`,
        `${param}.media_type`,
      );
    }
    return {
      type: "image",
      url: `data:${mediaType};base64,${requiredString(value.data, `${param}.data`)}`,
    };
  }
  if (value.type === "url") {
    rejectUnknownFields(value, ["type", "url"], param);
    return { type: "image", url: requiredString(value.url, `${param}.url`) };
  }
  throw new RouterFrameworkError(
    "invalid_request",
    `Anthropic image source '${String(value.type ?? "unknown")}' is not supported.`,
    "unsupported_image_source",
    `${param}.type`,
  );
}

function anthropicResultContent(value: unknown, param: string): RouterContent[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) throw invalid(`${param} must be a string or array.`, param);
  return value.map((block, index) => {
    if (!isRecord(block)) throw invalid(`${param}.${index} must be an object.`, `${param}.${index}`);
    if (block.type === "text" && typeof block.text === "string") {
      rejectUnknownFields(block, ["type", "text"], `${param}.${index}`);
      return { type: "text" as const, text: block.text };
    }
    if (block.type === "image") {
      rejectUnknownFields(block, ["type", "source"], `${param}.${index}`);
      return anthropicImage(block.source, `${param}.${index}.source`);
    }
    throw new RouterFrameworkError(
      "invalid_request",
      `Anthropic tool result block '${String(block.type ?? "unknown")}' is not supported.`,
      "unsupported_content_block",
      `${param}.${index}.type`,
    );
  });
}

function anthropicTools(value: unknown): RouterTool[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid("tools must be an array.", "tools");
  const names = new Set<string>();
  return value.map((tool, index) => {
    const param = `tools.${index}`;
    if (!isRecord(tool) || (tool.type !== undefined && tool.type !== "custom")) {
      throw new RouterFrameworkError(
        "invalid_request",
        `${param} must be an Anthropic custom tool.`,
        "unsupported_tool",
        param,
      );
    }
    rejectUnknownFields(
      tool,
      ["type", "name", "description", "input_schema", "strict"],
      param,
    );
    return portableTool(tool, {
      names,
      param,
      schemaField: "input_schema",
      schemaRequired: true,
    });
  });
}

function anthropicToolChoice(value: unknown): {
  choice?: RouterToolChoice;
  parallel?: boolean;
} {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw invalid("tool_choice must be an object.", "tool_choice");
  const type = requiredString(value.type, "tool_choice.type");
  rejectUnknownFields(
    value,
    type === "tool"
      ? ["type", "name", "disable_parallel_tool_use"]
      : ["type", "disable_parallel_tool_use"],
    "tool_choice",
  );
  let choice: RouterToolChoice;
  if (type === "auto" || type === "none") choice = type;
  else if (type === "any") choice = "required";
  else if (type === "tool") choice = { type: "tool", name: requiredString(value.name, "tool_choice.name") };
  else throw invalid(`tool_choice.type '${type}' is not supported.`, "tool_choice.type");
  const disabled = optionalBoolean(value.disable_parallel_tool_use, "tool_choice.disable_parallel_tool_use");
  return { choice, ...(disabled === undefined ? {} : { parallel: !disabled }) };
}

function anthropicReasoning(
  thinkingValue: unknown,
  effort: ReasoningEffort | undefined,
): RouterRequest["reasoning"] {
  if (thinkingValue === undefined || thinkingValue === null) {
    return effort === undefined ? undefined : { effort, enabled: effort !== "off" };
  }
  if (!isRecord(thinkingValue)) throw invalid("thinking must be an object.", "thinking");
  const type = requiredString(thinkingValue.type, "thinking.type");
  rejectUnknownFields(
    thinkingValue,
    type === "enabled" ? ["type", "budget_tokens"] : ["type"],
    "thinking",
  );
  if (type === "disabled") {
    if (effort !== undefined && effort !== "off") {
      throw invalid("Disabled thinking requires output_config.effort 'off'.", "output_config.effort");
    }
    return { effort: "off", enabled: false };
  }
  if (type !== "enabled" && type !== "adaptive") {
    throw invalid(`thinking.type '${type}' is not supported.`, "thinking.type");
  }
  if (effort === "off") {
    throw invalid("Enabled thinking cannot use output_config.effort 'off'.", "output_config.effort");
  }
  return {
    ...(effort === undefined ? {} : { effort }),
    enabled: true,
    ...(type === "enabled"
      ? { budgetTokens: positiveInteger(thinkingValue.budget_tokens, "thinking.budget_tokens") }
      : {}),
  };
}

function anthropicOutputConfig(value: unknown): {
  effort?: ReasoningEffort;
  format?: RouterResponseFormat;
} {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw invalid("output_config must be an object.", "output_config");
  rejectUnknownFields(value, ["effort", "format"], "output_config");
  let effort: ReasoningEffort | undefined;
  if (value.effort !== undefined && value.effort !== null) {
    if (!isReasoningEffort(value.effort)) {
      throw invalid("output_config.effort is not supported.", "output_config.effort");
    }
    effort = value.effort;
  }
  const formatValue = value.format;
  if (formatValue === undefined || formatValue === null) {
    return effort === undefined ? {} : { effort };
  }
  if (!isRecord(formatValue) || formatValue.type !== "json_schema" || !isRecord(formatValue.schema)) {
    throw new RouterFrameworkError(
      "invalid_request",
      "Only Anthropic json_schema output formats are supported.",
      "unsupported_response_format",
      "output_config.format",
    );
  }
  rejectUnknownFields(
    formatValue,
    ["type", "name", "schema"],
    "output_config.format",
  );
  return {
    ...(effort === undefined ? {} : { effort }),
    format: {
      type: "json_schema",
      name: optionalString(formatValue.name, "output_config.format.name") ?? "response",
      schema: formatValue.schema,
    },
  };
}

function toolArguments(value: string | Record<string, unknown>): Record<string, unknown> {
  if (isRecord(value)) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new RouterFrameworkError(
      "executor",
      "Executor returned tool arguments that are not valid JSON.",
      "executor_output_invalid",
      undefined,
      { cause: error },
    );
  }
  if (!isRecord(parsed)) {
    throw new RouterFrameworkError(
      "executor",
      "Executor returned tool arguments that are not a JSON object.",
      "executor_output_invalid",
    );
  }
  return parsed;
}

