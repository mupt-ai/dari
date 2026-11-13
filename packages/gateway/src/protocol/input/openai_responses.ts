import { createHash } from "node:crypto";

import { isReasoningEffort, isRecord, type ReasoningEffort } from "@mupt-ai/dari-router/policy-engine";

import { HttpError } from "../../http/errors.js";
import { parseDataImageUrl } from "../../interaction/image.js";
import { decodeUntrustedProviderContinuationState } from "../../interaction/provider_continuation_state.js";
import { CANONICAL_ROUTER_MODEL, explicitModelId, unsupportedModelMessage } from "./router_model.js";
import {
  isProtocolToolCallId,
  TOOL_CALL_ID_MAX_LENGTH,
  toolsByWireName,
} from "../../interaction/tool_identity.js";
import type {
  InteractionContent,
  InteractionItem,
  InteractionMessage,
  InteractionRequest,
  InteractionResponseFormat,
  InteractionTool,
  InteractionToolChoice,
  ToolKind,
} from "../../interaction/types.js";
import { parsePdfDataUrl } from "../../interaction/document.js";

const UNSUPPORTED_INPUT_ITEM_TYPES = new Set([
  "additional_tools",
  "agent_message",
  "image_generation_call",
  "file_search_call",
  "code_interpreter_call",
  "computer_call",
  "mcp_call",
  "mcp_tool_call_output",
  "local_shell_call",
  "local_shell_call_output",
  "tool_search_call",
  "tool_search_output",
  "compaction_summary",
  "context_compaction",
]);
const CLIENT_TURN_ID_MAX_LENGTH = 200;

export function openAIResponsesToInteraction(payload: Record<string, unknown>): InteractionRequest {
  const model = optionalString(payload.model, "model");
  if (model !== CANONICAL_ROUTER_MODEL && explicitModelId(model) === null) {
    throw new HttpError(400, unsupportedModelMessage(), "unsupported_model", "model");
  }
  if (payload.previous_response_id !== undefined && payload.previous_response_id !== null) {
    throw new HttpError(
      400,
      "previous_response_id is not supported by this router endpoint; send full input context.",
      "invalid_request_error",
      "previous_response_id"
    );
  }
  if (payload.service_tier !== undefined && payload.service_tier !== null) {
    throw new HttpError(
      400,
      "service_tier is not supported by this router endpoint.",
      "invalid_request_error",
      "service_tier"
    );
  }

  const items = responseItems(payload.input);
  const tools = responseTools(payload.tools);
  toolsByWireName(tools);
  const requestReasoning = reasoningControls(payload.reasoning);
  const updatedEffort = latestReasoningConfiguration(items);
  const baseEffort = requestReasoning?.effort;
  if (updatedEffort !== undefined && baseEffort === undefined) {
    throw new HttpError(
      400,
      "reasoning.effort is required when input contains configuration_update.",
      "invalid_request_error",
      "reasoning.effort"
    );
  }
  const reasoning = updatedEffort === undefined
    ? requestReasoning
    : {
        effort: updatedEffort,
        baseEffort,
        hasConfigurationUpdate: true,
      };
  const responseFormat = responseFormatFromText(payload.text);
  validateTextControls(payload.text);
  const instructions = optionalString(payload.instructions, "instructions");
  const stream = optionalBoolean(payload.stream, "stream") ?? false;
  const parallelToolCalls = optionalBoolean(payload.parallel_tool_calls, "parallel_tool_calls");
  const generation = {
    temperature: optionalNumber(payload.temperature, "temperature"),
    topP: optionalNumber(payload.top_p, "top_p"),
    maxOutputTokens: optionalNumber(payload.max_output_tokens ?? payload.max_completion_tokens, "max_output_tokens"),
    stop: stopOption(payload.stop),
  };

  return {
    sourceProtocol: "openai_responses",
    model,
    instructions,
    items,
    tools,
    toolChoice: responseToolChoice(payload.tool_choice),
    parallelToolCalls,
    generation,
    reasoning,
    responseFormat,
    promptCacheKey: optionalString(payload.prompt_cache_key, "prompt_cache_key"),
    stream,
    metadata: responseMetadata(payload),
    user: optionalString(payload.user, "user"),
  };
}

function responseItems(input: unknown): InteractionItem[] {
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "text", text: input }], contentShape: "string" }];
  }
  if (!Array.isArray(input)) {
    throw new HttpError(400, "input must be a string or an array.", "invalid_request_error", "input");
  }
  if (input.length === 0) {
    throw new HttpError(400, "input must include at least one item.", "invalid_request_error", "input");
  }
  const hostedReplayIds = hostedReplayIdsByItemIndex(input);
  return input.map((value, itemIndex) => responseItem(value, itemIndex, hostedReplayIds.get(itemIndex)));
}

function hostedReplayIdsByItemIndex(input: unknown[]): Map<number, string> {
  const replayIds = new Map<number, string>();
  assignPositionedHostedReplayIds(input, replayIds);
  let groupStart = 0;

  // A reasoning continuation only describes native output items in its own
  // contiguous provider-output group. Do not let its IDs leak across a client
  // message or tool call/result into another response in the flattened input.
  while (groupStart < input.length) {
    if (!isHostedReplayItem(input[groupStart])) {
      groupStart += 1;
      continue;
    }

    let groupEnd = groupStart + 1;
    while (groupEnd < input.length && isHostedReplayItem(input[groupEnd])) groupEnd += 1;
    assignHostedReplayGroup(input, groupStart, groupEnd, replayIds);
    groupStart = groupEnd;
  }

  return replayIds;
}

function assignPositionedHostedReplayIds(input: unknown[], replayIds: Map<number, string>): void {
  for (let reasoningIndex = 0; reasoningIndex < input.length; reasoningIndex += 1) {
    const continuation = hostedReplayContinuationFromItem(input[reasoningIndex]);
    if (!continuation?.hostedToolCallIds || !continuation.hostedToolCallOffsets) continue;
    for (let index = 0; index < continuation.hostedToolCallIds.length; index += 1) {
      const callIndex = reasoningIndex + continuation.hostedToolCallOffsets[index];
      const value = input[callIndex];
      if (!isRecord(value) || value.type !== "web_search_call" || replayIds.has(callIndex)) continue;
      replayIds.set(callIndex, continuation.hostedToolCallIds[index]);
    }
  }
}

function isHostedReplayItem(value: unknown): boolean {
  return isRecord(value) && (value.type === "reasoning" || value.type === "web_search_call");
}

function assignHostedReplayGroup(
  input: unknown[],
  start: number,
  end: number,
  replayIds: Map<number, string>
): void {
  const explicitIdCounts = new Map<string, number>();
  const missingCallIndexes: number[] = [];
  const carriedIds: Array<{ id: string; reasoningIndex: number }> = [];

  for (let index = start; index < end; index += 1) {
    const value = input[index];
    if (!isRecord(value)) continue;
    if (value.type === "reasoning") {
      carriedIds.push(...legacyHostedReplayIdsFromItem(value).map((id) => ({ id, reasoningIndex: index })));
      continue;
    }
    if (value.type !== "web_search_call") continue;
    if (typeof value.id === "string" && value.id.trim()) {
      explicitIdCounts.set(value.id, (explicitIdCounts.get(value.id) ?? 0) + 1);
    } else if (replayIds.has(index)) {
      const replayId = replayIds.get(index);
      if (replayId) explicitIdCounts.set(replayId, (explicitIdCounts.get(replayId) ?? 0) + 1);
    } else {
      missingCallIndexes.push(index);
    }
  }

  const unclaimedIds = carriedIds.filter(({ id }) => {
    const count = explicitIdCounts.get(id) ?? 0;
    if (count === 0) return true;
    explicitIdCounts.set(id, count - 1);
    return false;
  });

  if (unclaimedIds.length === missingCallIndexes.length) {
    for (let index = 0; index < unclaimedIds.length; index += 1) {
      replayIds.set(missingCallIndexes[index], unclaimedIds[index].id);
    }
    return;
  }

  // Partial histories can contain more id-less calls than the continuation
  // carries. Prefer calls following the reasoning item that carried each ID;
  // earlier unrelated calls keep their deterministic stateless fallback.
  const unassignedCallIndexes = [...missingCallIndexes];
  for (const carried of unclaimedIds) {
    const followingIndex = unassignedCallIndexes.findIndex((itemIndex) => itemIndex > carried.reasoningIndex);
    const callIndex = unassignedCallIndexes.splice(followingIndex >= 0 ? followingIndex : 0, 1)[0];
    if (callIndex === undefined) return;
    replayIds.set(callIndex, carried.id);
  }
}

function responseItem(value: unknown, itemIndex: number, hostedReplayId?: string): InteractionItem {
  if (!isRecord(value)) {
    throw new HttpError(400, "input items must be objects.", "invalid_request_error", "input");
  }
  const type = typeof value.type === "string" ? value.type : "";
  if (UNSUPPORTED_INPUT_ITEM_TYPES.has(type)) {
    throw new HttpError(400, `Responses input item type '${type}' is not supported by this router MVP.`, "unsupported_response_item", "input");
  }
  if (type === "compaction" || type === "compaction_trigger") return { type: "compaction", payload: { ...value } };
  if (type === "reasoning") return reasoningItem(value);
  if (type === "configuration_update") return reasoningConfigurationItem(value);
  if (type === "web_search_call") return hostedWebSearchCallItem(value, itemIndex, hostedReplayId);
  if (type === "function_call" || type === "custom_tool_call") return toolCallItem(value, type === "function_call" ? "function" : "custom");
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    return toolResultItem(value, type === "function_call_output" ? "function" : "custom");
  }
  if (type === "message" || typeof value.role === "string") return messageItem(value);
  throw new HttpError(400, `Responses input item type '${type || "unknown"}' is not supported by this router MVP.`, "unsupported_response_item", "input");
}

function reasoningConfigurationItem(
  value: Record<string, unknown>
): InteractionItem {
  if (!isRecord(value.reasoning)) {
    throw new HttpError(
      400,
      "input.configuration_update.reasoning must be an object.",
      "invalid_request_error",
      "input.configuration_update.reasoning"
    );
  }
  const effort = normalizedReasoningEffort(
    value.reasoning.effort,
    "input.configuration_update.reasoning.effort"
  );
  if (effort === undefined) {
    throw new HttpError(
      400,
      "input.configuration_update.reasoning.effort is required.",
      "invalid_request_error",
      "input.configuration_update.reasoning.effort"
    );
  }
  const extraUpdateKeys = Object.keys(value).filter((key) => key !== "type" && key !== "reasoning");
  const extraReasoningKeys = Object.keys(value.reasoning).filter((key) => key !== "effort");
  if (extraUpdateKeys.length > 0 || extraReasoningKeys.length > 0) {
    throw new HttpError(
      400,
      "configuration_update supports only reasoning.effort.",
      "invalid_request_error",
      "input.configuration_update"
    );
  }
  return { type: "reasoning_configuration", effort };
}

function latestReasoningConfiguration(items: InteractionItem[]): ReasoningEffort | undefined {
  let latest: ReasoningEffort | undefined;
  let previousWasUpdate = false;
  for (const item of items) {
    if (item.type === "reasoning_configuration") {
      if (previousWasUpdate) {
        throw new HttpError(
          400,
          "Adjacent configuration_update items are not supported.",
          "invalid_request_error",
          "input"
        );
      }
      latest = item.effort;
      previousWasUpdate = true;
    } else {
      previousWasUpdate = false;
    }
  }
  return latest;
}

function hostedWebSearchCallItem(
  value: Record<string, unknown>,
  itemIndex: number,
  hostedReplayId?: string
): InteractionItem {
  const id = hostedWebSearchCallId(value, itemIndex, hostedReplayId);
  return {
    type: "hosted_tool_call",
    id,
    tool: "web_search",
    providerType: "web_search_call",
    status: hostedItemStatus(value.status, "input.web_search_call.status"),
    payload: { ...value, id },
  };
}

function hostedWebSearchCallId(
  value: Record<string, unknown>,
  itemIndex: number,
  hostedReplayId?: string
): string {
  if (typeof value.id === "string" && value.id.trim()) return value.id;
  if (value.id !== undefined && value.id !== null && typeof value.id !== "string") {
    throw new HttpError(400, "input.web_search_call.id must be a string.", "invalid_request_error", "input.web_search_call.id");
  }
  if (hostedReplayId) return hostedReplayId;
  // If no client-carried continuation survives, keep the call replayable
  // instead of dropping it from provider history.
  const { id: _, ...itemWithoutId } = value;
  const digest = createHash("sha256")
    .update(JSON.stringify([itemIndex, itemWithoutId]), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `ws_dari_${digest}`;
}

function hostedReplayContinuationFromItem(value: unknown) {
  if (!isRecord(value) || value.type !== "reasoning" || typeof value.encrypted_content !== "string") return null;
  const continuation = decodeUntrustedProviderContinuationState(value.encrypted_content);
  return continuation?.kind === "openai_reasoning" ? continuation : null;
}

function legacyHostedReplayIdsFromItem(value: unknown): string[] {
  const continuation = hostedReplayContinuationFromItem(value);
  return continuation && !continuation.hostedToolCallOffsets
    ? continuation.hostedToolCallIds ?? []
    : [];
}

function messageItem(value: Record<string, unknown>): InteractionMessage {
  const role = requiredString(value.role, "input.message.role");
  if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant") {
    throw new HttpError(400, `Unsupported Responses message role '${role}'.`, "invalid_request_error", "input.role");
  }
  const phase = value.phase;
  if (phase !== undefined && phase !== "commentary" && phase !== "final_answer") {
    throw new HttpError(400, "input.message.phase is not supported.", "invalid_request_error", "input.message.phase");
  }
  return {
    type: "message",
    id: optionalString(value.id, "input.message.id"),
    ...clientTurnId(value),
    role,
    content: responseContent(value.content, "input.message.content"),
    contentShape: responseContentShape(value.content),
    phase,
  };
}

function clientTurnId(
  value: Record<string, unknown>,
): Pick<InteractionMessage, "clientTurnId"> {
  const metadata = value.internal_chat_message_metadata_passthrough;
  if (!isRecord(metadata) || typeof metadata.turn_id !== "string") return {};
  const normalized = metadata.turn_id.trim();
  return normalized && normalized.length <= CLIENT_TURN_ID_MAX_LENGTH
    ? { clientTurnId: normalized }
    : {};
}

function reasoningItem(value: Record<string, unknown>): InteractionItem {
  const encoded = optionalString(value.encrypted_content, "input.reasoning.encrypted_content");
  const continuation = encoded ? decodeUntrustedProviderContinuationState(encoded) : null;
  if (encoded && !continuation) {
    throw new HttpError(
      400,
      "input.reasoning.encrypted_content must be a Dari provider continuation envelope; raw provider ciphertext has no recoverable provider/model provenance.",
      "invalid_provider_continuation_state",
      "input.reasoning.encrypted_content"
    );
  }
  return {
    type: "reasoning",
    id: optionalString(value.id, "input.reasoning.id"),
    summary: textEntries(value.summary, "input.reasoning.summary", "summary_text"),
    content: textEntries(value.content, "input.reasoning.content", "reasoning_text"),
    ...(continuation ? { continuation } : {}),
  };
}

function textEntries(value: unknown, param: string, expectedType: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, `${param} must be an array.`, "invalid_request_error", param);
  return value.map((entry, index) => {
    if (!isRecord(entry) || (entry.type !== undefined && entry.type !== expectedType) || typeof entry.text !== "string") {
      throw new HttpError(400, `${param}[${index}] is not supported.`, "invalid_request_error", `${param}.${index}`);
    }
    return entry.text;
  });
}

function toolCallItem(value: Record<string, unknown>, kind: ToolKind): InteractionItem {
  const prefix = `input.${kind === "function" ? "function_call" : "custom_tool_call"}`;
  return {
    type: "tool_call",
    id: optionalString(value.id, `${prefix}.id`),
    callId: requiredToolCallId(value.call_id, `${prefix}.call_id`),
    kind,
    name: requiredString(value.name, `${prefix}.name`),
    namespace: optionalString(value.namespace, `${prefix}.namespace`),
    input:
      kind === "function"
        ? requiredToolArguments(value.arguments, `${prefix}.arguments`)
        : requiredString(value.input, `${prefix}.input`),
    status: itemStatus(value.status, `${prefix}.status`),
  };
}

function toolResultItem(value: Record<string, unknown>, kind: ToolKind): InteractionItem {
  const prefix = `input.${kind === "function" ? "function_call_output" : "custom_tool_call_output"}`;
  return {
    type: "tool_result",
    id: optionalString(value.id, `${prefix}.id`),
    callId: requiredToolCallId(value.call_id, `${prefix}.call_id`),
    kind,
    name: optionalString(value.name, `${prefix}.name`),
    output: responseToolOutput(value.output, `${prefix}.output`),
    outputShape: responseContentShape(value.output),
  };
}

function responseToolOutput(value: unknown, param: string): string | InteractionContent[] | null {
  if (value === undefined || value === null || typeof value === "string") return value ?? null;
  return responseContent(value, param);
}

function responseContent(value: unknown, param: string): InteractionContent[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) {
    if (value === undefined || value === null) return [];
    throw new HttpError(400, `${param} must be a string or an array.`, "invalid_request_error", param);
  }
  return value.map((part, index) => {
    if (!isRecord(part)) throw new HttpError(400, `${param}[${index}] must be an object.`, "invalid_request_error", `${param}.${index}`);
    if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
      const annotations = responseAnnotations(part.annotations, `${param}.${index}.annotations`);
      return {
        type: "text",
        text: requiredStringAllowEmpty(part.text, `${param}.${index}.text`),
        ...(annotations.length ? { annotations } : {}),
      };
    }
    if (part.type === "input_image") {
      const detail = imageDetail(part.detail, `${param}.${index}.detail`);
      return {
        type: "image",
        url: requiredImageUrl(part, `${param}.${index}.image_url`),
        ...(detail !== undefined ? { detail } : {}),
      };
    }
    if (part.type === "input_file") {
      const data = typeof part.file_data === "string" ? parsePdfDataUrl(part.file_data) : undefined;
      if (data === undefined) {
        throw new HttpError(
          400,
          "Responses input_file parts must carry a base64 PDF data URL in file_data; file_id and file_url are not supported.",
          "unsupported_file_source",
          `${param}.${index}`
        );
      }
      return { type: "document", mimeType: "application/pdf", data };
    }
    throw new HttpError(400, `Responses content part type '${String(part.type ?? "unknown")}' is not supported.`, "unsupported_response_content", `${param}.${index}.type`);
  });
}

function responseContentShape(value: unknown): InteractionMessage["contentShape"] {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  return "parts";
}

function responseTools(value: unknown): InteractionTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "tools must be an array.", "invalid_request_error", "tools");
  const tools: InteractionTool[] = [];
  for (const tool of value) appendResponseTool(tools, tool, undefined);
  return tools;
}

function appendResponseTool(tools: InteractionTool[], value: unknown, namespace: string | undefined): void {
  if (!isRecord(value)) throw new HttpError(400, "tools entries must be objects.", "invalid_request_error", "tools");
  const type = typeof value.type === "string" ? value.type : "";
  if (type === "web_search" || type === "web_search_preview") {
    if (namespace !== undefined) {
      throw new HttpError(400, "Hosted web search cannot be nested in a namespace.", "unsupported_tool", "tools");
    }
    tools.push({ kind: "hosted", type, config: { ...value } });
    return;
  }
  if (type === "namespace") {
    if (namespace !== undefined) throw new HttpError(400, "Nested namespace tools are not supported.", "unsupported_tool", "tools");
    const nested = value.tools;
    if (!Array.isArray(nested)) throw new HttpError(400, "namespace tools must include a tools array.", "invalid_request_error", "tools");
    const name = requiredString(value.name, "tools.namespace.name");
    for (const tool of nested) appendResponseTool(tools, tool, name);
    return;
  }
  if (type !== "function" && type !== "custom") {
    throw new HttpError(400, `Tool type '${type || "unknown"}' is not supported by this router MVP.`, "unsupported_tool", "tools");
  }
  const definition = isRecord(value.function) ? value.function : value;
  const common = {
    name: requiredString(definition.name, `tools.${type}.name`),
    namespace,
    description: optionalString(definition.description, `tools.${type}.description`),
  };
  if (type === "custom") {
    const format = definition.format;
    if (format !== undefined && !isRecord(format)) {
      throw new HttpError(400, "tools.custom.format must be an object.", "invalid_request_error", "tools.custom.format");
    }
    tools.push({ kind: "custom", ...common, format });
    return;
  }
  const parameters = definition.parameters ?? definition.input_schema;
  if (parameters !== undefined && !isRecord(parameters)) {
    throw new HttpError(400, "tools.function.parameters must be an object.", "invalid_request_error", "tools.function.parameters");
  }
  const strict = definition.strict;
  if (strict !== undefined && typeof strict !== "boolean") {
    throw new HttpError(400, "tools.function.strict must be a boolean.", "invalid_request_error", "tools.function.strict");
  }
  tools.push({ kind: "function", ...common, parameters, strict });
}

function responseToolChoice(value: unknown): InteractionToolChoice | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (value === "none" || value === "auto" || value === "required" || value === "any") return value;
    throw new HttpError(400, "tool_choice is not supported.", "invalid_request_error", "tool_choice");
  }
  if (isRecord(value) && (value.type === "web_search" || value.type === "web_search_preview")) {
    return { kind: "hosted", type: value.type };
  }
  if (!isRecord(value) || (value.type !== "function" && value.type !== "custom")) {
    throw new HttpError(400, "tool_choice is not supported.", "invalid_request_error", "tool_choice");
  }
  const definition = isRecord(value.function) ? value.function : value;
  return {
    kind: value.type,
    name: requiredString(definition.name, "tool_choice.name"),
    namespace: optionalString(definition.namespace ?? value.namespace, "tool_choice.namespace"),
  };
}

function responseAnnotations(value: unknown, param: string): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, `${param} must be an array.`, "invalid_request_error", param);
  }
  return value.map((annotation, index) => {
    if (!isRecord(annotation) || typeof annotation.type !== "string") {
      throw new HttpError(400, `${param}[${index}] must be an annotation object.`, "invalid_request_error", `${param}.${index}`);
    }
    return { ...annotation };
  });
}

function reasoningControls(value: unknown): InteractionRequest["reasoning"] {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new HttpError(400, "reasoning must be an object.", "invalid_request_error", "reasoning");
  const normalizedEffort = normalizedReasoningEffort(value.effort, "reasoning.effort");
  // Summaries are display-only: clients such as Muse Code ask for them by
  // default, and the router serves the turn without them.
  return normalizedEffort === undefined ? undefined : { effort: normalizedEffort };
}

function normalizedReasoningEffort(
  value: unknown,
  param: string
): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "off") {
    throw new HttpError(400, `${param} is not supported.`, "unsupported_reasoning_effort", param);
  }
  const candidate = value === "none" ? "off" : value;
  if (!isReasoningEffort(candidate)) {
    throw new HttpError(400, `${param} is not supported.`, "unsupported_reasoning_effort", param);
  }
  return candidate;
}

function validateTextControls(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) throw new HttpError(400, "text must be an object.", "invalid_request_error", "text");
  const verbosity = value.verbosity;
  if (verbosity !== undefined) {
    throw new HttpError(
      400,
      "text.verbosity is not supported by this router MVP.",
      "invalid_request_error",
      "text.verbosity"
    );
  }
}

function responseFormatFromText(value: unknown): InteractionResponseFormat | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new HttpError(400, "text must be an object.", "invalid_request_error", "text");
  const format = value.format;
  if (format === undefined || format === null) return undefined;
  if (!isRecord(format) || typeof format.type !== "string") {
    throw new HttpError(400, "text.format must be an object with a supported type.", "invalid_request_error", "text.format");
  }
  if (format.type === "text" || format.type === "json_object") return { type: format.type };
  if (format.type !== "json_schema") {
    throw new HttpError(400, "text.format.type is not supported.", "invalid_request_error", "text.format.type");
  }
  if (!isRecord(format.schema)) {
    throw new HttpError(400, "text.format.schema must be a JSON schema object.", "invalid_request_error", "text.format.schema");
  }
  const strict = optionalBoolean(format.strict, "text.format.strict");
  return {
    type: "json_schema",
    name: requiredString(format.name, "text.format.name"),
    schema: format.schema,
    ...(strict !== undefined ? { strict } : {}),
    description: optionalString(format.description, "text.format.description"),
  };
}

function responseMetadata(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (isRecord(payload.metadata)) Object.assign(metadata, payload.metadata);
  if (isRecord(payload.client_metadata)) metadata.client_metadata = payload.client_metadata;
  return Object.keys(metadata).length ? metadata : undefined;
}

function itemStatus(value: unknown, param: string): "in_progress" | "completed" | "incomplete" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "in_progress" || value === "completed" || value === "incomplete") return value;
  throw new HttpError(400, `${param} is not supported.`, "invalid_request_error", param);
}

function hostedItemStatus(
  value: unknown,
  param: string
): "in_progress" | "searching" | "completed" | "incomplete" | "failed" | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    value === "in_progress" ||
    value === "searching" ||
    value === "completed" ||
    value === "incomplete" ||
    value === "failed"
  ) return value;
  throw new HttpError(400, `${param} is not supported.`, "invalid_request_error", param);
}

function imageDetail(
  value: unknown,
  param: string
): "auto" | "low" | "high" | "original" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "auto" || value === "low" || value === "high" || value === "original") return value;
  throw new HttpError(400, `${param} is not supported.`, "invalid_request_error", param);
}

function requiredImageUrl(value: Record<string, unknown>, param: string): string {
  let url = "";
  if (typeof value.image_url === "string") url = value.image_url;
  else if (isRecord(value.image_url) && typeof value.image_url.url === "string") url = value.image_url.url;
  else if (typeof value.url === "string") url = value.url;
  if (!parseDataImageUrl(url)) {
    throw new HttpError(400, `${param} must be a base64 image data URL.`, "invalid_request_error", param);
  }
  return url;
}

function stopOption(value: unknown): string | string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw new HttpError(400, "stop must be a string or an array of strings.", "invalid_request_error", "stop");
}

function optionalBoolean(value: unknown, param: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new HttpError(400, `${param} must be a boolean.`, "invalid_request_error", param);
  return value;
}

function optionalNumber(value: unknown, param: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, `${param} must be a number.`, "invalid_request_error", param);
  return value;
}

function optionalString(value: unknown, param: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${param} must be a string.`, "invalid_request_error", param);
  return value;
}

function requiredString(value: unknown, param: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new HttpError(400, `${param} must be a non-empty string.`, "invalid_request_error", param);
}

function requiredToolCallId(value: unknown, param: string): string {
  if (isProtocolToolCallId(value)) return value;
  throw new HttpError(
    400,
    `${param} must be a non-empty string no longer than ${TOOL_CALL_ID_MAX_LENGTH} characters.`,
    "invalid_request_error",
    param
  );
}

function requiredStringAllowEmpty(value: unknown, param: string): string {
  if (typeof value === "string") return value;
  throw new HttpError(400, `${param} must be a string.`, "invalid_request_error", param);
}

function requiredToolArguments(value: unknown, param: string): string {
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new HttpError(400, `${param} must contain a JSON object.`, "invalid_request_error", param);
    }
    if (!isRecord(parsed)) {
      throw new HttpError(400, `${param} must contain a JSON object.`, "invalid_request_error", param);
    }
    return value;
  }
  if (isRecord(value)) return JSON.stringify(value);
  throw new HttpError(400, `${param} must be a string or object.`, "invalid_request_error", param);
}
