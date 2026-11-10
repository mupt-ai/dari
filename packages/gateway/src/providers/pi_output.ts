import { isRecord } from "@mupt-ai/dari-router/policy-engine";

import { HttpError } from "../http/errors.js";
import { providerToolCallIdentity, toolsByWireName } from "../interaction/tool_identity.js";
import { isAnthropicEffort } from "../interaction/provider_continuation_state.js";
import { isBedrockApi, isOpenAIResponsesApi } from "./model_capabilities.js";
import type {
  InteractionItem,
  InteractionOutput,
  InteractionRequest,
  InteractionTool,
  InteractionUsage,
  ProviderContinuationState,
  ProviderIdentity,
  ToolKind,
} from "../interaction/types.js";

export function piMessageToInteractionOutput(
  message: Record<string, unknown>,
  source: ProviderIdentity,
  request: Pick<InteractionRequest, "tools">
): InteractionOutput {
  if (isRecord(message.providerResponse) && isOpenAIResponsesApi(source.api)) {
    return openAIProviderResponseToInteractionOutput(message.providerResponse, message, source, request);
  }
  const tools = toolsByWireName(request.tools);
  const items: InteractionOutput["items"] = [];
  const content = message.content;
  if (content !== undefined && !Array.isArray(content)) throw invalidProviderOutput("content must be an array.");

  let pendingServerToolCall: { id: string; name: string; input: Record<string, unknown> } | null = null;
  for (const block of content ?? []) {
    if (!isRecord(block)) throw invalidProviderOutput("content blocks must be objects.");
    if (block.type === "text") {
      if (typeof block.text !== "string") throw invalidProviderOutput("text content is missing text.");
      const signature = textSignature(block.textSignature);
      items.push({
        type: "message",
        ...(signature?.id ? { id: signature.id } : {}),
        role: "assistant",
        content: [{ type: "text", text: block.text }],
        contentShape: "parts",
        ...(signature?.phase ? { phase: signature.phase } : {}),
        source,
      });
      continue;
    }
    if (block.type === "thinking") {
      items.push(reasoningItem(block, source, message.providerThinkingLevel));
      continue;
    }
    if (block.type === "toolCall") {
      items.push(toolCallItem(block, source, tools));
      continue;
    }
    if (block.type === "serverToolCall") {
      const serverId = requiredString(block.id, "server tool call ID");
      const serverName = requiredString(block.name, "server tool call name");
      const serverInput = isRecord(block.arguments) ? block.arguments : {};
      pendingServerToolCall = { id: serverId, name: serverName, input: serverInput };
      items.push({
        type: "hosted_tool_call",
        id: requiredString(block.id, "server tool call ID"),
        tool: "server_tool_use",
        providerType: "server_tool_use",
        payload: { id: block.id, name: block.name, input: block.arguments },
        serverToolUseId: requiredString(block.id, "server tool call ID"),
        serverToolName: serverName,
        serverToolInput: serverInput,
        source,
      });
      continue;
    }
    if (block.type === "toolSearchResult") {
      const references = (Array.isArray(block.content) ? block.content : []).filter(
        (ref) => isRecord(ref) && ref.type === "tool_reference"
      ).map((ref) => ({
        type: "tool_reference" as const,
        toolName: String(ref.tool_name ?? ""),
      }));
      const serverToolCall = pendingServerToolCall?.id === String(block.toolUseId) ? pendingServerToolCall : null;
      if (serverToolCall) pendingServerToolCall = null;
      items.push({
        type: "hosted_tool_call",
        id: `${String(block.toolUseId)}_result`,
        tool: "tool_search",
        providerType: "tool_search_result",
        payload: {
          tool_use_id: block.toolUseId,
          content: references,
          ...(serverToolCall ? { name: serverToolCall.name, input: serverToolCall.input } : {}),
        },
        serverToolUseId: requiredString(block.toolUseId, "tool search result tool_use_id"),
        serverToolName: serverToolCall?.name,
        serverToolInput: serverToolCall?.input,
        serverToolResult: references,
        source,
      });
      continue;
    }
    throw invalidProviderOutput(`content block type '${String(block.type ?? "unknown")}' is not supported.`);
  }

  if (items.length === 0) {
    items.push({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      contentShape: "parts",
      source,
    });
  }

  return {
    responseId: optionalString(message.responseId),
    createdAtMs: finiteNumber(message.timestamp) ?? Date.now(),
    source,
    items,
    usage: interactionUsage(message.usage, source),
    stopReason: stopReason(message.stopReason),
    ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}),
    ...(Array.isArray(message.safeguardResults) ? { safeguardResults: message.safeguardResults } : {}),
  };
}

function openAIProviderResponseToInteractionOutput(
  response: Record<string, unknown>,
  message: Record<string, unknown>,
  source: ProviderIdentity,
  request: Pick<InteractionRequest, "tools">
): InteractionOutput {
  if (!Array.isArray(response.output)) {
    throw invalidProviderOutput("OpenAI Responses output must be an array.");
  }
  const tools = toolsByWireName(request.tools);
  const items: InteractionOutput["items"] = response.output.map((value) => {
    if (!isRecord(value) || typeof value.type !== "string") {
      throw invalidProviderOutput("OpenAI Responses output items must be typed objects.");
    }
    if (value.type === "reasoning") return openAIProviderReasoningItem(value, source);
    if (value.type === "message") return openAIProviderMessageItem(value, source);
    if (value.type === "function_call") {
      const argumentsValue = requiredString(value.arguments, "function call arguments");
      let parsed: unknown;
      try {
        parsed = JSON.parse(argumentsValue);
      } catch {
        throw invalidProviderOutput("function call arguments are not valid JSON.");
      }
      if (!isRecord(parsed)) throw invalidProviderOutput("function call arguments must be an object.");
      return toolCallItem({
        id: `${requiredString(value.call_id, "function call ID")}|${requiredString(value.id, "function item ID")}`,
        name: requiredString(value.name, "function call name"),
        arguments: parsed,
      }, source, tools);
    }
    if (value.type === "web_search_call") {
      return {
        type: "hosted_tool_call" as const,
        id: requiredString(value.id, "web search call ID"),
        tool: "web_search" as const,
        providerType: "web_search_call" as const,
        ...(openAIHostedStatus(value.status) ? { status: openAIHostedStatus(value.status) } : {}),
        payload: { ...value },
        source,
      };
    }
    throw invalidProviderOutput(`OpenAI Responses output item type '${value.type}' is not supported.`);
  });
  attachHostedReplayIds(items);

  return {
    responseId: optionalString(response.id) ?? optionalString(message.responseId),
    createdAtMs: (finiteNumber(response.created_at) ?? Date.now() / 1000) * 1000,
    source,
    items,
    usage: interactionUsage(message.usage, source),
    stopReason: stopReason(message.stopReason),
    ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}),
  };
}

function attachHostedReplayIds(items: InteractionOutput["items"]): void {
  const firstReasoningIndex = items.findIndex((item) => item.type === "reasoning");
  if (firstReasoningIndex < 0) return;

  const callsByReasoning = new Map<number, Array<{ id: string; offset: number }>>();
  // Provider output is ordered into reasoning groups: leading calls belong to
  // the first group, and each later reasoning item starts the next group.
  let currentReasoningIndex = firstReasoningIndex;
  for (let callIndex = 0; callIndex < items.length; callIndex += 1) {
    const item = items[callIndex];
    if (item.type === "reasoning") {
      currentReasoningIndex = callIndex;
      continue;
    }
    if (item.type !== "hosted_tool_call") continue;
    const reasoning = items[currentReasoningIndex];
    if (reasoning.type !== "reasoning" || reasoning.continuation?.kind !== "openai_reasoning") continue;
    const calls = callsByReasoning.get(currentReasoningIndex) ?? [];
    calls.push({ id: item.id, offset: callIndex - currentReasoningIndex });
    callsByReasoning.set(currentReasoningIndex, calls);
  }

  for (const [reasoningIndex, calls] of callsByReasoning) {
    const item = items[reasoningIndex];
    if (item.type !== "reasoning" || item.continuation?.kind !== "openai_reasoning") continue;
    item.continuation = {
      ...item.continuation,
      hostedToolCallIds: calls.map(({ id }) => id),
      hostedToolCallOffsets: calls.map(({ offset }) => offset),
    };
  }
}

function openAIProviderReasoningItem(
  value: Record<string, unknown>,
  source: ProviderIdentity
): Extract<InteractionItem, { type: "reasoning" }> {
  const encryptedContent = optionalString(value.encrypted_content);
  const id = optionalString(value.id);
  return {
    type: "reasoning",
    ...(id ? { id } : {}),
    summary: providerTextEntries(value.summary, "summary_text"),
    content: providerTextEntries(value.content, "reasoning_text"),
    source,
    ...(encryptedContent
      ? {
          continuation: {
            kind: "openai_reasoning" as const,
            source,
            encryptedContent,
            ...(id ? { providerItemId: id } : {}),
          },
        }
      : {}),
  };
}

function openAIProviderMessageItem(
  value: Record<string, unknown>,
  source: ProviderIdentity
): Extract<InteractionItem, { type: "message" }> {
  if (!Array.isArray(value.content)) throw invalidProviderOutput("message content must be an array.");
  const content = value.content.map((part) => {
    if (!isRecord(part)) throw invalidProviderOutput("message content parts must be objects.");
    if (part.type !== "output_text" && part.type !== "refusal") {
      throw invalidProviderOutput(`message content type '${String(part.type ?? "unknown")}' is not supported.`);
    }
    const text = requiredStringAllowEmpty(
      part.type === "refusal" ? part.refusal : part.text,
      "message content text"
    );
    const annotations = providerAnnotations(part.annotations);
    return {
      type: "text" as const,
      text,
      ...(annotations.length ? { annotations } : {}),
    };
  });
  const phase = value.phase === "commentary" || value.phase === "final_answer" ? value.phase : undefined;
  return {
    type: "message",
    ...(optionalString(value.id) ? { id: optionalString(value.id) } : {}),
    role: "assistant",
    content,
    contentShape: "parts",
    ...(phase ? { phase } : {}),
    source,
  };
}

function providerTextEntries(value: unknown, type: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidProviderOutput(`${type} entries must be an array.`);
  return value.map((entry) => {
    if (!isRecord(entry) || entry.type !== type || typeof entry.text !== "string") {
      throw invalidProviderOutput(`${type} entries are malformed.`);
    }
    return entry.text;
  });
}

function providerAnnotations(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidProviderOutput("message annotations must be an array.");
  return value.map((annotation) => {
    if (!isRecord(annotation) || typeof annotation.type !== "string") {
      throw invalidProviderOutput("message annotations must be typed objects.");
    }
    return { ...annotation };
  });
}

function openAIHostedStatus(
  value: unknown
): "in_progress" | "searching" | "completed" | "incomplete" | "failed" | undefined {
  return value === "in_progress" ||
    value === "searching" ||
    value === "completed" ||
    value === "incomplete" ||
    value === "failed"
    ? value
    : undefined;
}

function reasoningItem(
  block: Record<string, unknown>,
  source: ProviderIdentity,
  providerThinkingLevel: unknown,
): Extract<InteractionItem, { type: "reasoning" }> {
  const thinking = typeof block.thinking === "string" ? block.thinking : "";
  const signature = optionalString(block.thinkingSignature);
  if (isOpenAIResponsesApi(source.api)) {
    const native = signature ? openAIReasoningItem(signature) : null;
    return {
      type: "reasoning",
      ...(native?.id ? { id: native.id } : {}),
      summary: native?.summary ?? (thinking ? [thinking] : []),
      content: native?.content ?? [],
      source,
      ...(native?.encryptedContent
        ? {
            continuation: {
              kind: "openai_reasoning",
              source,
              encryptedContent: native.encryptedContent,
              ...(native.id ? { providerItemId: native.id } : {}),
            },
          }
        : {}),
    };
  }
  if ((source.api === "anthropic-messages" || isBedrockApi(source.api)) && signature) {
    // Pi stamps the effort marker it sent on managed-effort Claude turns; the
    // envelope carries it so replay can put the marker back (see pi_context).
    const effort = isAnthropicEffort(providerThinkingLevel) ? { effort: providerThinkingLevel } : {};
    const continuation: ProviderContinuationState = block.redacted === true
      ? { kind: "anthropic_redacted_thinking", source, data: signature, ...effort }
      : { kind: "anthropic_thinking", source, thinking, signature, ...effort };
    return {
      type: "reasoning",
      summary: block.redacted === true || !thinking ? [] : [thinking],
      content: [],
      source,
      continuation,
    };
  }
  return {
    type: "reasoning",
    summary: thinking ? [thinking] : [],
    content: [],
    source,
  };
}

function toolCallItem(
  block: Record<string, unknown>,
  source: ProviderIdentity,
  tools: Map<string, InteractionTool>
): Extract<InteractionItem, { type: "tool_call" }> {
  const piId = requiredString(block.id, "tool call ID");
  const flattenedName = requiredString(block.name, "tool call name");
  const identity = providerToolCallIdentity(piId, source);
  const candidate = tools.get(flattenedName);
  const tool = candidate?.kind === "hosted" || candidate?.kind === "server_tool" ? undefined : candidate;
  const kind: ToolKind = tool?.kind === "custom" ? "custom" : "function";
  const argumentsValue = isRecord(block.arguments) ? block.arguments : {};
  return {
    type: "tool_call",
    ...(identity.itemId ? { id: identity.itemId } : {}),
    callId: identity.callId,
    kind,
    name: tool?.name ?? flattenedName,
    ...(tool && "namespace" in tool && tool.namespace ? { namespace: tool.namespace } : {}),
    input: kind === "custom" ? customInput(argumentsValue) : argumentsValue,
    status: "completed",
  };
}

function customInput(value: Record<string, unknown>): string {
  return typeof value.input === "string" ? value.input : "";
}

function openAIReasoningItem(value: string): {
  id?: string;
  summary: string[];
  content: string[];
  encryptedContent?: string;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "reasoning") return null;
  return {
    id: optionalString(parsed.id),
    summary: reasoningText(parsed.summary, "summary_text"),
    content: reasoningText(parsed.content, "reasoning_text"),
    encryptedContent: optionalString(parsed.encrypted_content),
  };
}

function reasoningText(value: unknown, type: "summary_text" | "reasoning_text"): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) && entry.type === type && typeof entry.text === "string" ? [entry.text] : []
  );
}

export function textSignature(value: unknown): { id?: string; phase?: "commentary" | "final_answer" } | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.v !== 1) return { id: value };
    const phase = parsed.phase === "commentary" || parsed.phase === "final_answer" ? parsed.phase : undefined;
    return { id: optionalString(parsed.id), ...(phase ? { phase } : {}) };
  } catch {
    return { id: value };
  }
}

function interactionUsage(value: unknown, source: ProviderIdentity): InteractionUsage {
  const usage = isRecord(value) ? value : {};
  const cost = isRecord(usage.cost) ? usage.cost : {};
  const reportedInput = finiteNumber(usage.input) ?? 0;
  const output = finiteNumber(usage.output) ?? 0;
  const cacheRead = finiteNumber(usage.cacheRead) ?? 0;
  const cacheWrite = finiteNumber(usage.cacheWrite) ?? 0;
  const reportedInputCost = finiteNumber(cost.input) ?? 0;
  const outputCost = finiteNumber(cost.output) ?? 0;
  const cacheReadCost = finiteNumber(cost.cacheRead) ?? 0;
  const cacheWriteCost = finiteNumber(cost.cacheWrite) ?? 0;

  // OpenAI models on Bedrock Converse report cache reads and writes as subsets
  // of inputTokens. Canonical usage keeps those buckets separate. Claude's
  // Bedrock usage is already cache-exclusive.
  const inclusiveCacheTokens = isBedrockApi(source.api) && /(^|[./])openai[./]/.test(source.model);
  const input = inclusiveCacheTokens
    ? Math.max(0, reportedInput - cacheRead - cacheWrite)
    : reportedInput;
  const inputCost = inclusiveCacheTokens && reportedInput > 0
    ? reportedInputCost * input / reportedInput
    : reportedInputCost;
  const calculatedTotalTokens = input + output + cacheRead + cacheWrite;
  const calculatedTotalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: inclusiveCacheTokens
      ? calculatedTotalTokens
      : finiteNumber(usage.totalTokens) ?? calculatedTotalTokens,
    cost: {
      input: inputCost,
      output: outputCost,
      cacheRead: cacheReadCost,
      cacheWrite: cacheWriteCost,
      total: inclusiveCacheTokens
        ? calculatedTotalCost
        : finiteNumber(cost.total) ?? calculatedTotalCost,
    },
    ...(usage.costSource === "provider" ? { costSource: "provider" as const } : {}),
  };
}

function stopReason(value: unknown): InteractionOutput["stopReason"] {
  if (value === "length") return "length";
  if (value === "toolUse") return "tool_use";
  if (value === "error") return "error";
  if (value === "aborted") return "aborted";
  return "stop";
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw invalidProviderOutput(`${field} is missing.`);
  return value;
}

function requiredStringAllowEmpty(value: unknown, field: string): string {
  if (typeof value !== "string") throw invalidProviderOutput(`${field} is missing.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function invalidProviderOutput(message: string): HttpError {
  return new HttpError(502, `Provider output ${message}`, "provider_output_invalid");
}
