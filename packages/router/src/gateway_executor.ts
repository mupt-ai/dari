// Executes the router's selected model on a Dari gateway.
//
// The router owns selection and leases; the gateway owns credentials,
// subscriptions, provider calls, and credential-level failover. The executor
// sends each request as a pinned `dari/model/<id>` call, which the gateway
// serves without its own selector or leases.
//
// It speaks the gateway's Anthropic Messages wire: that is the only gateway
// wire whose stream closes each thinking block with its continuation
// envelope before the next block starts, which the router's stream contract
// requires. Requests the wire cannot express fail with an explicit error
// rather than being silently altered.

import {
  decodeUntrustedProviderContinuationState,
  encodeProviderContinuationState,
} from "./continuation_state.js";
import { RouterFrameworkError } from "./framework_error.js";
import type {
  RouterCompletion,
  RouterContent,
  RouterExecutor,
  RouterFinishReason,
  RouterOutputItem,
  RouterReasoningItem,
  RouterRequest,
  RouterStreamEvent,
  RouterUsage,
} from "./framework_types.js";
import {
  decodeUntrustedPortableReasoningState,
  encodePortableReasoningState,
} from "./portable_reasoning_state.js";
import { isRecord, type ReasoningEffort } from "./types.js";

export type CreateGatewayExecutorOptions = {
  // Gateway origin, for example "http://localhost:8080". Requests go to
  // `${baseUrl}/v1/messages`.
  baseUrl: string;
  // A gateway key for a router that enables every model this router declares.
  apiKey: string;
  // Anthropic Messages requires max_tokens. Used only when a request sets no
  // output limit; such requests fail when this is unset.
  defaultMaxOutputTokens?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
};

export function createGatewayExecutor(options: CreateGatewayExecutorOptions): RouterExecutor {
  const baseUrl = options.baseUrl?.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new RouterFrameworkError("configuration", "createGatewayExecutor requires a baseUrl.", "gateway_base_url_missing");
  }
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    throw new RouterFrameworkError("configuration", "createGatewayExecutor requires an apiKey.", "gateway_api_key_missing");
  }
  const defaultMaxOutputTokens = options.defaultMaxOutputTokens;
  if (
    defaultMaxOutputTokens !== undefined &&
    (!Number.isSafeInteger(defaultMaxOutputTokens) || defaultMaxOutputTokens <= 0)
  ) {
    throw new RouterFrameworkError(
      "configuration",
      "createGatewayExecutor defaultMaxOutputTokens must be a positive integer.",
      "gateway_max_output_tokens_invalid",
    );
  }
  const fetchImpl = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));

  return {
    async execute({ request, model, decision, signal }) {
      const body = gatewayMessagesBody(request, {
        modelId: model.id,
        reasoningEffort: decision.reasoningEffort,
        defaultMaxOutputTokens,
      });
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new RouterFrameworkError(
          "executor",
          `Gateway request failed: ${errorMessage(error)}`,
          "gateway_request_failed",
          undefined,
          { cause: error },
        );
      }
      if (!response.ok) throw await gatewayHttpError(response);
      if (!request.stream) {
        return { type: "complete", output: gatewayCompletion(await response.json()) };
      }
      if (response.body === null) {
        throw new RouterFrameworkError("executor", "Gateway returned an empty stream.", "gateway_stream_empty");
      }
      return { type: "stream", events: gatewayStreamEvents(response.body) };
    },
  };
}

// ---------------------------------------------------------------------------
// Request: RouterRequest -> gateway Anthropic Messages body

export function gatewayMessagesBody(
  request: RouterRequest,
  args: { modelId: string; reasoningEffort: ReasoningEffort; defaultMaxOutputTokens?: number },
): Record<string, unknown> {
  const maxTokens = request.generation.maxOutputTokens ?? args.defaultMaxOutputTokens;
  if (maxTokens === undefined) {
    throw unrepresentable(
      "The request sets no output token limit and the gateway executor has no defaultMaxOutputTokens.",
      "max_tokens",
    );
  }
  const temperature = request.generation.temperature;
  if (temperature !== undefined && temperature > 1) {
    throw unrepresentable("Temperatures above 1 cannot be sent to the gateway executor.", "temperature");
  }
  const stop = request.generation.stop;
  const { system, messages } = gatewayMessages(request.items);
  const toolChoice = gatewayToolChoice(request);
  const metadata = gatewayMetadata(request);
  const responseFormat = gatewayResponseFormat(request);
  return {
    model: `dari/model/${args.modelId}`,
    max_tokens: maxTokens,
    ...(system.length === 0 ? {} : { system }),
    messages,
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            input_schema: tool.inputSchema,
            ...(tool.strict === undefined ? {} : { strict: tool.strict }),
          })),
        }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...reasoningFields(args.reasoningEffort, responseFormat, request.reasoning?.budgetTokens),
    ...(temperature === undefined ? {} : { temperature }),
    ...(request.generation.topP === undefined ? {} : { top_p: request.generation.topP }),
    ...(stop === undefined ? {} : { stop_sequences: typeof stop === "string" ? [stop] : stop }),
    ...(request.stream ? { stream: true } : {}),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

type WireMessage = { role: "user" | "assistant"; content: Array<Record<string, unknown>> };

function gatewayMessages(items: RouterRequest["items"]): {
  system: Array<Record<string, unknown>>;
  messages: WireMessage[];
} {
  const system: Array<Record<string, unknown>> = [];
  const messages: WireMessage[] = [];
  const append = (role: WireMessage["role"], blocks: Array<Record<string, unknown>>) => {
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };
  for (const [index, item] of items.entries()) {
    if (item.type === "message") {
      const role = item.role;
      if (role !== "system" && role !== "developer") {
        if (role === "assistant" && item.content.some((part) => part.type === "image")) {
          throw unrepresentable("Assistant images cannot be sent to the gateway executor.", `items.${index}`);
        }
        append(role, item.content.map(contentBlock));
        continue;
      }
      if (messages.length > 0) {
        throw unrepresentable(
          "System and developer messages after the conversation starts cannot be sent to the gateway executor.",
          `items.${index}`,
        );
      }
      for (const part of item.content) {
        if (part.type !== "text") {
          throw unrepresentable("System messages can only contain text on the gateway executor.", `items.${index}`);
        }
        system.push({ type: "text", text: part.text });
      }
      continue;
    }
    if (item.type === "reasoning") {
      append("assistant", [reasoningBlock(item)]);
      continue;
    }
    if (item.type === "tool_call") {
      append("assistant", [{
        type: "tool_use",
        id: item.id,
        name: item.name,
        input: toolInput(item.arguments, `items.${index}.arguments`),
      }]);
      continue;
    }
    if (item.type === "tool_result") {
      append("user", [{
        type: "tool_result",
        tool_use_id: item.toolCallId,
        content: item.content.map(contentBlock),
        ...(item.isError === undefined ? {} : { is_error: item.isError }),
      }]);
      continue;
    }
    throw unrepresentable(
      "Hosted tool calls cannot be sent to the gateway executor; serve hosted-tool models directly.",
      `items.${index}`,
    );
  }
  for (const message of messages) {
    if (message.content.length === 0) message.content.push({ type: "text", text: "" });
  }
  return { system, messages };
}

function contentBlock(part: RouterContent): Record<string, unknown> {
  if (part.type === "text") return { type: "text", text: part.text };
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.url);
  if (match) {
    return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
  }
  return { type: "image", source: { type: "url", url: part.url } };
}

function reasoningBlock(item: RouterReasoningItem): Record<string, unknown> {
  if (item.continuation?.kind === "anthropic_redacted_thinking") {
    return { type: "redacted_thinking", data: encodeProviderContinuationState(item.continuation) };
  }
  return {
    type: "thinking",
    thinking: [...(item.summary ?? []), ...item.content].join("\n"),
    signature: item.continuation
      ? encodeProviderContinuationState(item.continuation)
      : encodePortableReasoningState({
          ...(item.source === undefined ? {} : { source: item.source }),
          ...(item.id === undefined ? {} : { itemId: item.id }),
        }),
  };
}

function toolInput(value: string | Record<string, unknown>, param: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  // Providers emit "" for a call with no arguments.
  if (!value.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) {
    throw unrepresentable("Tool call arguments must be a JSON object for the gateway executor.", param);
  }
  return parsed;
}

function gatewayToolChoice(request: RouterRequest): Record<string, unknown> | undefined {
  const choice = request.toolChoice;
  const disableParallel = request.parallelToolCalls === false ? { disable_parallel_tool_use: true } : {};
  if (choice === undefined) {
    return request.parallelToolCalls === false ? { type: "auto", ...disableParallel } : undefined;
  }
  if (choice === "auto" || choice === "none") return { type: choice, ...disableParallel };
  if (choice === "required") return { type: "any", ...disableParallel };
  return { type: "tool", name: choice.name, ...disableParallel };
}

// A client's explicit thinking budget is kept; otherwise the model thinks
// adaptively at the selected effort.
function reasoningFields(
  effort: ReasoningEffort,
  format: Record<string, unknown> | undefined,
  budgetTokens: number | undefined,
): Record<string, unknown> {
  const outputConfig = (extra: Record<string, unknown>) => {
    const config = { ...extra, ...(format === undefined ? {} : { format }) };
    return Object.keys(config).length === 0 ? {} : { output_config: config };
  };
  if (effort === "off") return { thinking: { type: "disabled" }, ...outputConfig({}) };
  if (effort === "minimal") {
    throw unrepresentable("Minimal reasoning effort cannot be sent to the gateway executor.", "reasoning_effort");
  }
  return {
    thinking: budgetTokens === undefined
      ? { type: "adaptive" }
      : { type: "enabled", budget_tokens: budgetTokens },
    ...outputConfig({ effort }),
  };
}

function gatewayResponseFormat(request: RouterRequest): Record<string, unknown> | undefined {
  const format = request.responseFormat;
  if (format === undefined || format.type === "text") return undefined;
  if (format.type === "json_object") {
    throw unrepresentable("json_object response formats cannot be sent to the gateway executor; use json_schema.", "response_format");
  }
  return { type: "json_schema", name: format.name, schema: format.schema };
}

// The gateway keys conversations on metadata.user_id's session_id (the
// Claude Code convention); prompt_cache_key has no Anthropic field.
function gatewayMetadata(request: RouterRequest): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = { ...(request.metadata ?? {}) };
  const user = typeof metadata.user_id === "string" ? metadata.user_id : request.user;
  if (request.cacheKey !== undefined) {
    metadata.user_id = JSON.stringify({
      session_id: request.cacheKey,
      ...(user === undefined ? {} : { user_id: user }),
    });
  } else if (user !== undefined) {
    metadata.user_id = user;
  }
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

// ---------------------------------------------------------------------------
// Response: gateway Anthropic Messages -> RouterCompletion

export function gatewayCompletion(body: unknown): RouterCompletion {
  if (!isRecord(body) || !Array.isArray(body.content)) {
    throw gatewayOutputError("Gateway returned a response without a content array.");
  }
  const content: RouterOutputItem[] = body.content.map((block) => outputItem(block));
  const usage = gatewayUsage(body.usage);
  return {
    ...(typeof body.id === "string" ? { id: body.id } : {}),
    content,
    finishReason: finishReason(body.stop_reason),
    ...(usage === undefined ? {} : { usage }),
  };
}

function outputItem(block: unknown): RouterOutputItem {
  if (!isRecord(block)) throw gatewayOutputError("Gateway returned a malformed content block.");
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (block.type === "thinking" && typeof block.thinking === "string") {
    const { itemId: _itemId, ...state } = reasoningState(block.signature);
    return { type: "reasoning", text: block.thinking, ...state };
  }
  if (block.type === "redacted_thinking") {
    const { itemId: _itemId, ...state } = reasoningState(block.data);
    return { type: "reasoning", text: "", redacted: true, ...state };
  }
  if (
    block.type === "tool_use" &&
    typeof block.id === "string" &&
    typeof block.name === "string" &&
    isRecord(block.input)
  ) {
    return { type: "tool_call", id: block.id, name: block.name, arguments: block.input };
  }
  throw gatewayOutputError(`Gateway returned an unsupported content block '${String(block.type)}'.`);
}

type ReasoningState = Pick<Extract<RouterOutputItem, { type: "reasoning" }>, "source" | "continuation"> & {
  itemId?: string;
};

function reasoningState(encoded: unknown): ReasoningState {
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw gatewayOutputError("Gateway returned a thinking block without a reasoning-state envelope.");
  }
  const continuation = decodeUntrustedProviderContinuationState(encoded);
  if (continuation) return { source: continuation.source, continuation };
  const portable = decodeUntrustedPortableReasoningState(encoded);
  if (!portable) throw gatewayOutputError("Gateway returned a thinking block with an unreadable envelope.");
  return {
    ...(portable.source === undefined ? {} : { source: portable.source }),
    ...(portable.itemId === undefined ? {} : { itemId: portable.itemId }),
  };
}

function finishReason(value: unknown): RouterFinishReason {
  if (value === "tool_use") return "tool_calls";
  if (value === "max_tokens") return "length";
  return "stop";
}

function gatewayUsage(value: unknown, base?: RouterUsage): RouterUsage | undefined {
  if (!isRecord(value)) return base;
  const count = (field: string): number | undefined =>
    typeof value[field] === "number" && Number.isFinite(value[field]) ? (value[field] as number) : undefined;
  const inputTokens = count("input_tokens") ?? base?.inputTokens ?? 0;
  const outputTokens = count("output_tokens") ?? base?.outputTokens ?? 0;
  const cacheReadTokens = count("cache_read_input_tokens") ?? base?.cacheReadTokens;
  const cacheWriteTokens = count("cache_creation_input_tokens") ?? base?.cacheWriteTokens;
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

// ---------------------------------------------------------------------------
// Stream: gateway Anthropic SSE -> RouterStreamEvent

type OpenBlock =
  | { kind: "text" }
  | { kind: "thinking"; signature?: string }
  | { kind: "redacted"; data: unknown }
  | { kind: "tool" };

export async function* gatewayStreamEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RouterStreamEvent> {
  const blocks = new Map<number, OpenBlock>();
  let usage: RouterUsage | undefined;
  let stopReason: unknown;
  for await (const { event, data } of sseEvents(body)) {
    if (event === "ping") continue;
    if (event === "error") {
      const message = isRecord(data) && isRecord(data.error) && typeof data.error.message === "string"
        ? data.error.message
        : "Gateway stream failed.";
      throw new RouterFrameworkError("executor", message, "gateway_stream_error");
    }
    if (!isRecord(data)) throw gatewayOutputError(`Gateway sent a malformed '${event}' event.`);
    if (event === "message_start") {
      usage = gatewayUsage(isRecord(data.message) ? data.message.usage : undefined);
      continue;
    }
    if (event === "message_delta") {
      if (isRecord(data.delta) && data.delta.stop_reason !== undefined) stopReason = data.delta.stop_reason;
      usage = gatewayUsage(data.usage, usage);
      continue;
    }
    if (event === "message_stop") {
      yield { type: "finish", finishReason: finishReason(stopReason), ...(usage === undefined ? {} : { usage }) };
      return;
    }
    const index = data.index;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
      throw gatewayOutputError(`Gateway sent a '${event}' event without a valid index.`);
    }
    if (event === "content_block_start") {
      const block = data.content_block;
      if (!isRecord(block)) throw gatewayOutputError("Gateway started a malformed content block.");
      if (block.type === "text") {
        blocks.set(index, { kind: "text" });
        if (typeof block.text === "string" && block.text) yield { type: "text_delta", index, delta: block.text };
      } else if (block.type === "thinking") {
        blocks.set(index, { kind: "thinking" });
        if (typeof block.thinking === "string" && block.thinking) {
          yield { type: "reasoning_delta", index, delta: block.thinking };
        }
      } else if (block.type === "redacted_thinking") {
        blocks.set(index, { kind: "redacted", data: block.data });
      } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        blocks.set(index, { kind: "tool" });
        yield { type: "tool_call_start", index, id: block.id, name: block.name };
      } else {
        throw gatewayOutputError(`Gateway streamed an unsupported content block '${String(block.type)}'.`);
      }
      continue;
    }
    const open = blocks.get(index);
    if (open === undefined) throw gatewayOutputError(`Gateway sent '${event}' for unopened block ${index}.`);
    if (event === "content_block_delta") {
      const delta = data.delta;
      if (!isRecord(delta)) throw gatewayOutputError("Gateway sent a malformed content delta.");
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        if (delta.text) yield { type: "text_delta", index, delta: delta.text };
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        if (delta.thinking) yield { type: "reasoning_delta", index, delta: delta.thinking };
      } else if (delta.type === "signature_delta" && open.kind === "thinking" && typeof delta.signature === "string") {
        open.signature = delta.signature;
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        if (delta.partial_json) yield { type: "tool_call_delta", index, delta: delta.partial_json };
      } else {
        throw gatewayOutputError(`Gateway sent an unsupported '${String(delta.type)}' delta.`);
      }
      continue;
    }
    if (event === "content_block_stop") {
      blocks.delete(index);
      if (open.kind === "thinking") {
        yield { type: "reasoning_end", index, ...reasoningState(open.signature) };
      } else if (open.kind === "redacted") {
        yield { type: "reasoning_end", index, redacted: true, ...reasoningState(open.data) };
      } else if (open.kind === "tool") {
        yield { type: "tool_call_end", index };
      }
      continue;
    }
    throw gatewayOutputError(`Gateway sent an unsupported '${event}' event.`);
  }
  throw gatewayOutputError("Gateway stream ended before message_stop.");
}

async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
        const parsed = sseFrame(frame);
        if (parsed) yield parsed;
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (done) break;
    }
    const parsed = sseFrame(buffer);
    if (parsed) yield parsed;
  } finally {
    reader.releaseLock();
  }
}

function sseFrame(frame: string): { event: string; data: unknown } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    throw gatewayOutputError(`Gateway sent a '${event}' event whose data is not JSON.`);
  }
}

// ---------------------------------------------------------------------------
// Errors

async function gatewayHttpError(response: Response): Promise<RouterFrameworkError> {
  const text = await response.text().catch(() => "");
  let message = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      message = parsed.error.message;
    }
  } catch {
    // Keep the raw body as the message.
  }
  const detail = `Gateway returned HTTP ${response.status}: ${message}`;
  if (response.status === 401 || response.status === 403) {
    return new RouterFrameworkError("configuration", detail, "gateway_unauthorized");
  }
  if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
    return new RouterFrameworkError("invalid_request", detail, "gateway_rejected_request");
  }
  return new RouterFrameworkError("executor", detail, "gateway_http_error");
}

function unrepresentable(message: string, param: string): RouterFrameworkError {
  return new RouterFrameworkError("invalid_request", message, "gateway_unrepresentable_request", param);
}

function gatewayOutputError(message: string): RouterFrameworkError {
  return new RouterFrameworkError("executor", message, "gateway_output_invalid");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
