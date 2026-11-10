import {
  decodeUntrustedProviderContinuationState,
  encodeProviderContinuationState,
  type ProviderContinuationState,
  type ProviderIdentity,
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
  optionalPositiveInteger,
  optionalRecord,
  optionalString,
  portableTool,
  prefixedWireId,
  rejectUnknownFields,
  requiredString,
  stopSequenceValues,
  validateToolChoice,
} from "./protocol_validation.js";
import { isReasoningEffort, isRecord } from "./types.js";
import {
  isRouterHostedToolCallStatus,
  type RouterCompletion,
  type RouterContent,
  type RouterHostedToolCallStatus,
  type RouterOutputHostedToolCall,
  type RouterRequest,
  type RouterResponseFormat,
  type RouterSelection,
  type RouterStreamEvent,
  type RouterTool,
  type RouterToolChoice,
} from "./framework_types.js";

export function openAIChatRequest(payload: unknown): RouterRequest {
  if (!isRecord(payload)) throw invalid("Request body must be a JSON object.");
  rejectUnknownFields(payload, [
    "model",
    "messages",
    "stream",
    "stream_options",
    "n",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "temperature",
    "top_p",
    "max_completion_tokens",
    "max_tokens",
    "stop",
    "reasoning_effort",
    "response_format",
    "prompt_cache_key",
    "metadata",
    "user",
  ]);

  const requestedModel = requiredString(payload.model, "model");
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw invalid("messages must be a non-empty array.", "messages");
  }
  if (payload.n !== undefined && payload.n !== 1) {
    throw invalid("Only n=1 is supported.", "n");
  }
  if (payload.max_completion_tokens != null && payload.max_tokens != null) {
    throw invalid(
      "max_completion_tokens and max_tokens cannot both be provided.",
      "max_completion_tokens",
    );
  }

  const items: RouterRequest["items"] = [];
  for (const [messageIndex, value] of payload.messages.entries()) {
    const param = `messages.${messageIndex}`;
    if (!isRecord(value)) throw invalid(`${param} must be an object.`, param);
    const role = requiredString(value.role, `${param}.role`);
    if (role === "tool") {
      rejectUnknownFields(value, ["role", "content", "tool_call_id"], param);
      items.push({
        type: "tool_result",
        toolCallId: requiredString(value.tool_call_id, `${param}.tool_call_id`),
        content: openAIContent(value.content, `${param}.content`),
      });
      continue;
    }
    if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant") {
      throw invalid(`${param}.role is not supported.`, `${param}.role`);
    }
    rejectUnknownFields(
      value,
      role === "assistant"
        ? [
            "role",
            "content",
            "tool_calls",
            "reasoning_content",
            "reasoning",
            "reasoning_text",
            "reasoning_details",
          ]
        : ["role", "content"],
      param,
    );
    let reasoningItemCount = 0;
    if (role === "assistant") {
      const reasoningItems = openAIReasoningItems(value, messageIndex);
      reasoningItemCount = reasoningItems.length;
      items.push(...reasoningItems);
    }
    const toolCalls = value.tool_calls;
    if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
      throw invalid(`${param}.tool_calls must be an array.`, `${param}.tool_calls`);
    }
    const hasToolCalls = toolCalls !== undefined && toolCalls.length > 0;
    let content = openAIContent(value.content, `${param}.content`);
    if (hasToolCalls && isAllEmptyText(content)) {
      content = [];
    }
    if (
      role === "assistant" &&
      content.length === 0 &&
      !hasToolCalls &&
      reasoningItemCount === 0
    ) {
      throw invalid(`${param} is an empty assistant message with no tool calls.`, param);
    }
    if (content.length > 0 || (!hasToolCalls && reasoningItemCount === 0)) {
      items.push({ type: "message", role, content });
    }
    if (toolCalls === undefined) continue;
    for (const [callIndex, callValue] of toolCalls.entries()) {
      const callParam = `${param}.tool_calls.${callIndex}`;
      if (!isRecord(callValue) || callValue.type !== "function") {
        throw invalid(`${callParam} must be a function tool call.`, callParam);
      }
      rejectUnknownFields(callValue, ["id", "type", "function"], callParam);
      if (!isRecord(callValue.function)) {
        throw invalid(`${callParam}.function must be an object.`, `${callParam}.function`);
      }
      rejectUnknownFields(
        callValue.function,
        ["name", "arguments"],
        `${callParam}.function`,
      );
      const argumentsValue = callValue.function.arguments;
      if (typeof argumentsValue !== "string" && !isRecord(argumentsValue)) {
        throw invalid(
          `${callParam}.function.arguments must be a JSON string or object.`,
          `${callParam}.function.arguments`,
        );
      }
      const id = requiredString(callValue.id, `${callParam}.id`);
      const name = requiredString(callValue.function.name, `${callParam}.function.name`);
      const hosted = openAIHostedToolCall(
        id,
        name,
        argumentsValue,
        items.filter((item) => item.type === "reasoning"),
        `${callParam}.function.arguments`,
      );
      if (hosted !== null) items.push(hosted);
      else items.push({
        type: "tool_call",
        id,
        name,
        arguments: argumentsValue,
      });
    }
  }

  const tools = openAITools(payload.tools);
  const toolChoice = openAIToolChoice(payload.tool_choice);
  validateToolChoice(toolChoice, tools);
  const parallelToolCalls = optionalBoolean(
    payload.parallel_tool_calls,
    "parallel_tool_calls",
  );
  if (parallelToolCalls !== undefined && tools.length === 0) {
    throw invalid("parallel_tool_calls requires at least one tool.", "parallel_tool_calls");
  }
  const temperature = optionalNumberInRange(payload.temperature, "temperature", 0, 2);
  const topP = optionalNumberInRange(payload.top_p, "top_p", 0, 1);
  const maxOutputTokens = optionalPositiveInteger(
    payload.max_completion_tokens ?? payload.max_tokens,
    payload.max_completion_tokens == null ? "max_tokens" : "max_completion_tokens",
  );
  const stop = stopSequenceValues(payload.stop, "stop", true);
  const reasoning = openAIReasoning(payload.reasoning_effort);
  const responseFormat = openAIResponseFormat(payload.response_format);
  const cacheKey = optionalCacheKey(payload.prompt_cache_key, "prompt_cache_key");
  const stream = optionalBoolean(payload.stream, "stream") ?? false;
  // Accepted for ecosystem compatibility (Vercel AI SDK, LiteLLM) and ignored:
  // usage is always emitted by the streaming layer.
  optionalRecord(payload.stream_options, "stream_options");
  const metadata = optionalRecord(payload.metadata, "metadata");
  const user = optionalString(payload.user, "user");

  return {
    protocol: "openai_chat_completions",
    requestedModel,
    items,
    tools,
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
    generation: {
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { topP }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(stop === undefined ? {} : { stop }),
    },
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(responseFormat === undefined ? {} : { responseFormat }),
    ...(cacheKey === undefined ? {} : { cacheKey }),
    stream,
    ...(metadata === undefined ? {} : { metadata }),
    ...(user === undefined ? {} : { user }),
  };
}

export function openAIChatResponse<Metadata>(args: {
  id: string;
  model: string;
  requestedModel: string;
  output: RouterCompletion;
  selection: RouterSelection<Metadata>;
}): Record<string, unknown> {
  const text = args.output.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
  const toolCalls = args.output.content.flatMap((item) => {
    if (item.type === "hosted_tool_call") return [openAIHostedToolCallWire(item)];
    return item.type === "tool_call"
      ? [{
          id: item.id,
          type: "function",
          function: {
            name: item.name,
            arguments: typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments),
          },
        }]
      : [];
  });
  const reasoning = args.output.content.filter((item) => item.type === "reasoning");
  const reasoningDetails = reasoning.map((item, index) =>
    item.continuation
      ? encryptedReasoningDetail(index, item.continuation)
      : portableReasoningDetail(index, item.source),
  );
  return {
    id: prefixedWireId(args.output.id ?? args.id, "chatcmpl-"),
    object: "chat.completion",
    created: Math.floor((args.output.createdAtMs ?? Date.now()) / 1000),
    model: args.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: toolCalls.length > 0 && text.length === 0 ? null : text,
        ...(reasoning.some((item) => item.text.length > 0)
          ? { reasoning_content: reasoning.map((item) => item.text).filter(Boolean).join("\n") }
          : {}),
        ...(reasoningDetails.length === 0 ? {} : { reasoning_details: reasoningDetails }),
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      },
      finish_reason: args.output.finishReason,
    }],
    usage: openAIUsage(args.output.usage ?? { inputTokens: 0, outputTokens: 0 }),
    dari_routing: dariRoutingPayload(args.requestedModel, args.selection),
  };
}

export function openAIChatChunk<Metadata>(args: {
  id: string;
  created: number;
  model: string;
  delta: Record<string, unknown>;
  finishReason: string | null;
  routing?: { requestedModel: string; selection: RouterSelection<Metadata> };
  usage?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: prefixedWireId(args.id, "chatcmpl-"),
    object: "chat.completion.chunk",
    created: args.created,
    model: args.model,
    choices: [{ index: 0, delta: args.delta, finish_reason: args.finishReason }],
    ...(args.routing === undefined
      ? {}
      : { dari_routing: dariRoutingPayload(args.routing.requestedModel, args.routing.selection) }),
    ...(args.usage === undefined ? {} : { usage: args.usage }),
  };
}

export function openAIStreamDelta(
  event: Exclude<RouterStreamEvent, { type: "finish" }>,
  toolCallIndex: number = event.index,
  reasoningDetailIndex?: number,
): Record<string, unknown> | null {
  if (event.type === "text_delta") return { content: event.delta };
  if (event.type === "reasoning_delta") return { reasoning_content: event.delta };
  if (event.type === "reasoning_end") {
    const detailIndex = reasoningDetailIndex ?? 0;
    return {
      reasoning_details: [
        event.continuation === undefined
          ? portableReasoningDetail(detailIndex, event.source, event.itemId)
          : encryptedReasoningDetail(detailIndex, event.continuation),
      ],
    };
  }
  if (event.type === "tool_call_start") {
    return {
      tool_calls: [{
        index: toolCallIndex,
        id: event.id,
        type: "function",
        function: { name: event.name, arguments: "" },
      }],
    };
  }
  if (event.type === "tool_call_delta") {
    return { tool_calls: [{ index: toolCallIndex, function: { arguments: event.delta } }] };
  }
  if (event.type === "hosted_tool_call") {
    return { tool_calls: [{ index: toolCallIndex, ...openAIHostedToolCallWire(event) }] };
  }
  return null;
}

function openAIHostedToolCallWire(
  item: Omit<RouterOutputHostedToolCall, "type">,
): Record<string, unknown> {
  const replayPayload: Record<string, unknown> = {
    ...item.payload,
    type: item.providerType,
    id: item.id,
  };
  if (item.status) replayPayload.status = item.status;
  else delete replayPayload.status;
  return {
    id: item.id,
    type: "function",
    function: {
      name: item.tool,
      arguments: JSON.stringify(replayPayload),
    },
  };
}

function openAIContent(value: unknown, param: string): RouterContent[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) throw invalid(`${param} must be a string, array, or null.`, param);
  return value.map((part, index) => {
    const partParam = `${param}.${index}`;
    if (!isRecord(part)) throw invalid(`${partParam} must be an object.`, partParam);
    if (part.type === "text") {
      rejectUnknownFields(part, ["type", "text"], partParam);
      if (typeof part.text !== "string") throw invalid(`${partParam}.text must be a string.`, `${partParam}.text`);
      return { type: "text" as const, text: part.text };
    }
    if (part.type === "image_url") {
      if (!isRecord(part.image_url)) {
        throw invalid(`${partParam}.image_url must be an object.`, `${partParam}.image_url`);
      }
      rejectUnknownFields(part, ["type", "image_url"], partParam);
      rejectUnknownFields(part.image_url, ["url", "detail"], `${partParam}.image_url`);
      const url = requiredString(part.image_url.url, `${partParam}.image_url.url`);
      const detail = part.image_url.detail;
      if (detail !== undefined && detail !== "auto" && detail !== "low" && detail !== "high") {
        throw invalid(
          `${partParam}.image_url.detail must be 'auto', 'low', or 'high'.`,
          `${partParam}.image_url.detail`,
        );
      }
      return {
        type: "image" as const,
        url,
        ...(detail === undefined ? {} : { detail }),
      };
    }
    throw new RouterFrameworkError(
      "invalid_request",
      `${partParam}.type is not supported.`,
      "unsupported_content_block",
      `${partParam}.type`,
    );
  });
}

function openAITools(value: unknown): RouterTool[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid("tools must be an array.", "tools");
  const names = new Set<string>();
  return value.map((tool, index) => {
    const param = `tools.${index}`;
    if (!isRecord(tool) || tool.type !== "function" || !isRecord(tool.function)) {
      throw new RouterFrameworkError(
        "invalid_request",
        `${param} must be an OpenAI function tool.`,
        "unsupported_tool",
        param,
      );
    }
    rejectUnknownFields(tool, ["type", "function"], param);
    rejectUnknownFields(
      tool.function,
      ["name", "description", "parameters", "strict"],
      `${param}.function`,
    );
    return portableTool(tool.function, {
      names,
      param: `${param}.function`,
      schemaField: "parameters",
      schemaRequired: false,
    });
  });
}

function openAIToolChoice(value: unknown): RouterToolChoice | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "none" || value === "auto" || value === "required") return value;
  if (isRecord(value) && value.type === "function" && isRecord(value.function)) {
    rejectUnknownFields(value, ["type", "function"], "tool_choice");
    rejectUnknownFields(value.function, ["name"], "tool_choice.function");
    return { type: "tool", name: requiredString(value.function.name, "tool_choice.function.name") };
  }
  throw invalid("tool_choice is not supported.", "tool_choice");
}

function openAIReasoningItems(
  message: Record<string, unknown>,
  messageIndex: number,
): Array<Extract<RouterRequest["items"][number], { type: "reasoning" }>> {
  const readable = [message.reasoning_content, message.reasoning, message.reasoning_text]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const details = message.reasoning_details;
  if (details !== undefined && !Array.isArray(details)) {
    throw invalid(
      `messages.${messageIndex}.reasoning_details must be an array.`,
      `messages.${messageIndex}.reasoning_details`,
    );
  }
  const entries = (details ?? []).map((detail, detailIndex) => {
    const param = `messages.${messageIndex}.reasoning_details.${detailIndex}`;
    if (!isRecord(detail)) throw invalid(`${param} must be an object.`, param);
    rejectUnknownFields(detail, ["type", "id", "data"], param);
    if (detail.type !== "reasoning.encrypted" || typeof detail.data !== "string") {
      throw invalid(
        `${param}.data must be a Dari reasoning-state envelope.`,
        `${param}.data`,
      );
    }
    const continuation = decodeUntrustedProviderContinuationState(detail.data);
    const portable = continuation ? null : decodeUntrustedPortableReasoningState(detail.data);
    if (!continuation && !portable) {
      throw new RouterFrameworkError(
        "invalid_request",
        `${param}.data must be a Dari reasoning-state envelope; raw provider state has no recoverable provider/model provenance.`,
        "invalid_provider_continuation_state",
        `${param}.data`,
      );
    }
    return {
      id: typeof detail.id === "string" && detail.id.length > 0
        ? detail.id
        : portable?.itemId,
      continuation,
      portable,
    };
  });
  if (entries.length === 0) {
    return readable
      ? [{ type: "reasoning", summary: [readable], content: [] }]
      : [];
  }
  return entries.map(({ id, continuation, portable }, index) => ({
    type: "reasoning" as const,
    ...(id ? { id } : {}),
    summary: index === 0 && readable ? [readable] : [],
    content: [],
    ...(continuation
      ? { source: continuation.source, continuation }
      : portable?.source
        ? { source: portable.source }
        : {}),
  }));
}

function openAIHostedToolCall(
  callId: string,
  name: string,
  argumentsValue: unknown,
  reasoningItems: Array<Extract<RouterRequest["items"][number], { type: "reasoning" }>>,
  param: string,
): Extract<RouterRequest["items"][number], { type: "hosted_tool_call" }> | null {
  if (name !== "web_search") return null;
  const payload = openAIToolArgumentsRecord(argumentsValue);
  if (payload === null || payload.type !== "web_search_call" || payload.id !== callId) return null;
  const status = hostedToolCallStatus(payload.status, param);
  const source = reasoningItems.flatMap((item) =>
    item.continuation?.kind === "openai_reasoning" &&
    item.continuation.hostedToolCallIds?.includes(callId)
      ? [item.continuation.source]
      : [],
  )[0];
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

function openAIToolArgumentsRecord(value: unknown): Record<string, unknown> | null {
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
): RouterHostedToolCallStatus | undefined {
  if (value === undefined || isRouterHostedToolCallStatus(value)) return value;
  throw invalid(`${param} is not supported.`, param);
}

function openAIReasoning(value: unknown): RouterRequest["reasoning"] {
  if (value === undefined || value === null) return undefined;
  if (!isReasoningEffort(value)) throw invalid("reasoning_effort is not supported.", "reasoning_effort");
  return { effort: value, enabled: value !== "off" };
}

function openAIResponseFormat(value: unknown): RouterResponseFormat | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw invalid("response_format must be an object.", "response_format");
  if (value.type === "text" || value.type === "json_object") {
    rejectUnknownFields(value, ["type"], "response_format");
    return { type: value.type };
  }
  if (value.type !== "json_schema" || !isRecord(value.json_schema)) {
    throw new RouterFrameworkError(
      "invalid_request",
      "response_format.type is not supported.",
      "unsupported_response_format",
      "response_format.type",
    );
  }
  rejectUnknownFields(value, ["type", "json_schema"], "response_format");
  rejectUnknownFields(
    value.json_schema,
    ["name", "schema", "description", "strict"],
    "response_format.json_schema",
  );
  if (!isRecord(value.json_schema.schema)) {
    throw invalid("response_format.json_schema.schema must be an object.", "response_format.json_schema.schema");
  }
  const description = optionalString(
    value.json_schema.description,
    "response_format.json_schema.description",
  );
  const strict = optionalBoolean(
    value.json_schema.strict,
    "response_format.json_schema.strict",
  );
  return {
    type: "json_schema",
    name: requiredString(value.json_schema.name, "response_format.json_schema.name"),
    schema: value.json_schema.schema,
    ...(description === undefined ? {} : { description }),
    ...(strict === undefined ? {} : { strict }),
  };
}

export function openAIUsage(
  usage: NonNullable<RouterCompletion["usage"]>,
): Record<string, unknown> {
  const cacheTokens = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const promptTokens = usage.inputTokens + cacheTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: usage.outputTokens,
    // OpenAI counts cached tokens inside prompt_tokens; once cache tokens are
    // folded in, recompute the total rather than trusting upstream totalTokens.
    total_tokens: cacheTokens > 0
      ? promptTokens + usage.outputTokens
      : usage.totalTokens ?? promptTokens + usage.outputTokens,
    ...(cacheTokens > 0
      ? {
          prompt_tokens_details: {
            cached_tokens: usage.cacheReadTokens ?? 0,
            cache_write_tokens: usage.cacheWriteTokens ?? 0,
          },
        }
      : {}),
  };
}

function encryptedReasoningDetail(
  index: number,
  continuation: ProviderContinuationState,
): Record<string, unknown> {
  return {
    type: "reasoning.encrypted",
    id: `reasoning_${index}`,
    data: encodeProviderContinuationState(continuation),
  };
}

function portableReasoningDetail(
  index: number,
  source: ProviderIdentity | undefined,
  itemId?: string,
): Record<string, unknown> {
  const id = itemId ?? `reasoning_${index}`;
  return {
    type: "reasoning.encrypted",
    id,
    data: encodePortableReasoningState({
      ...(source === undefined ? {} : { source }),
      itemId: id,
    }),
  };
}
