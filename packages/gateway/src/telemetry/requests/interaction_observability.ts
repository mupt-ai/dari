import {
  isBackgroundRequest,
  type AgentRequestContext,
  type InteractionContent,
  type InteractionRequest,
  type InteractionToolChoice,
  type ProviderContinuationState,
} from "../../interaction/types.js";

const SCHEMA_VERSION = 1 as const;

type CountBy<T extends string> = Record<T, number>;

type ItemKind =
  | "hosted_tool_call"
  | "hosted_tool_result"
  | "message"
  | "reasoning"
  | "tool_call"
  | "tool_result";

type MessageRole = "assistant" | "developer" | "system" | "user";
type ToolKind = "custom" | "function" | "hosted";
type ContentModality = "image" | "text";
type ContinuationKind = ProviderContinuationState["kind"];

export type InteractionObservabilityMetadata = {
  schema_version: typeof SCHEMA_VERSION;
  agent_context?: AgentRequestContext;
  item_counts: CountBy<ItemKind> & { total: number };
  message_role_counts: CountBy<MessageRole>;
  tool_call_counts: CountBy<ToolKind>;
  declared_tool_counts: CountBy<ToolKind> & { total: number };
  item_content_modality_counts: CountBy<ContentModality>;
  continuation_state_counts: CountBy<ContinuationKind> & { total: number };
  instructions_present: boolean;
  reasoning_history_present: boolean;
  prompt_cache_key_present: boolean;
  user_present: boolean;
  controls: {
    reasoning_effort?: NonNullable<InteractionRequest["reasoning"]>["effort"];
    reasoning_enabled?: boolean;
    response_format?: NonNullable<InteractionRequest["responseFormat"]>["type"];
    tool_choice?: "any" | "auto" | "custom" | "function" | "hosted" | "none" | "required";
    parallel_tool_calls?: boolean;
  };
};

export type InteractionRequestKind =
  | "other"
  | "tool_continuation"
  | "user_message";

export type InteractionObservability = {
  requestKind: InteractionRequestKind;
  messageCount: number;
  hasTools: boolean;
  metadata: InteractionObservabilityMetadata;
};

export function extractInteractionObservability(
  request: InteractionRequest,
): InteractionObservability {
  const metadata = interactionObservabilityMetadata(request);
  return {
    requestKind: interactionRequestKind(request),
    messageCount: metadata.item_counts.message,
    hasTools: metadata.declared_tool_counts.total > 0,
    metadata,
  };
}

function interactionObservabilityMetadata(
  request: InteractionRequest,
): InteractionObservabilityMetadata {
  const itemCounts = {
    total: request.items.length,
    message: 0,
    reasoning: 0,
    tool_call: 0,
    tool_result: 0,
    hosted_tool_call: 0,
    hosted_tool_result: 0,
  };
  const messageRoleCounts: CountBy<MessageRole> = {
    system: 0,
    developer: 0,
    user: 0,
    assistant: 0,
  };
  const toolCallCounts: CountBy<ToolKind> = {
    function: 0,
    custom: 0,
    hosted: 0,
  };
  const itemContentModalityCounts: CountBy<ContentModality> = {
    text: 0,
    image: 0,
  };
  const continuationStateCounts: CountBy<ContinuationKind> & {
    total: number;
  } = {
    total: 0,
    openai_reasoning: 0,
    anthropic_thinking: 0,
    anthropic_redacted_thinking: 0,
  };

  for (const item of request.items) {
    if (item.type === "message") {
      itemCounts.message += 1;
      messageRoleCounts[item.role] += 1;
      addContentModalities(itemContentModalityCounts, item.content);
      continue;
    }
    if (item.type === "reasoning") {
      itemCounts.reasoning += 1;
      if (item.continuation) {
        continuationStateCounts.total += 1;
        continuationStateCounts[item.continuation.kind] += 1;
      }
      continue;
    }
    if (item.type === "tool_call") {
      itemCounts.tool_call += 1;
      toolCallCounts[item.kind] += 1;
      continue;
    }
    if (item.type === "tool_result") {
      itemCounts.tool_result += 1;
      addContentModalities(itemContentModalityCounts, item.output);
      continue;
    }
    if (item.type === "reasoning_configuration") {
      continue;
    }
    if (item.providerType === "tool_search_result") {
      itemCounts.hosted_tool_result += 1;
    } else {
      itemCounts.hosted_tool_call += 1;
      toolCallCounts.hosted += 1;
    }
  }

  const declaredToolCounts = {
    total: request.tools.length,
    function: 0,
    custom: 0,
    hosted: 0,
  };
  for (const tool of request.tools) {
    const kind = tool.kind === "server_tool" ? "hosted" : tool.kind === "client_tool" ? "function" : tool.kind;
    declaredToolCounts[kind] += 1;
  }

  const controls: InteractionObservabilityMetadata["controls"] = {};
  if (request.reasoning?.effort !== undefined) {
    controls.reasoning_effort = request.reasoning.effort;
  }
  if (request.reasoning?.enabled !== undefined) {
    controls.reasoning_enabled = request.reasoning.enabled;
  }
  if (request.responseFormat !== undefined) {
    controls.response_format = request.responseFormat.type;
  }
  if (request.toolChoice !== undefined) {
    controls.tool_choice = toolChoiceKind(request.toolChoice);
  }
  if (request.parallelToolCalls !== undefined) {
    controls.parallel_tool_calls = request.parallelToolCalls;
  }

  return {
    schema_version: SCHEMA_VERSION,
    ...(request.agentContext === undefined ? {} : { agent_context: request.agentContext }),
    item_counts: itemCounts,
    message_role_counts: messageRoleCounts,
    tool_call_counts: toolCallCounts,
    declared_tool_counts: declaredToolCounts,
    item_content_modality_counts: itemContentModalityCounts,
    continuation_state_counts: continuationStateCounts,
    instructions_present:
      request.instructions !== undefined
      || messageRoleCounts.system > 0
      || messageRoleCounts.developer > 0,
    reasoning_history_present: itemCounts.reasoning > 0,
    prompt_cache_key_present: request.promptCacheKey !== undefined,
    user_present: request.user !== undefined,
    controls,
  };
}

function interactionRequestKind(
  request: InteractionRequest,
): InteractionRequestKind {
  if (
    isBackgroundRequest(request) ||
    request.requestPurpose === "memory_extraction"
  ) return "other";
  if (request.requestPurpose === "tool_continuation") {
    return "tool_continuation";
  }

  let hasTrailingToolResult = false;
  for (let index = request.items.length - 1; index >= 0; index -= 1) {
    const item = request.items[index];
    if (item.type === "tool_result") {
      hasTrailingToolResult = true;
      continue;
    }
    if (
      item.type === "tool_call"
      || item.type === "hosted_tool_call"
      || item.type === "reasoning"
    ) {
      return hasTrailingToolResult ? "tool_continuation" : "other";
    }
    if (item.type !== "message") continue;
    if (item.role === "system" || item.role === "developer") continue;
    if (item.role === "user") {
      if (hasMeaningfulUserContent(item.content)) return "user_message";
      continue;
    }
    return hasTrailingToolResult ? "tool_continuation" : "other";
  }
  return hasTrailingToolResult ? "tool_continuation" : "other";
}

export function hasMeaningfulUserContent(
  content: InteractionContent[] | string | null,
): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (part.type === "text") return part.text.trim().length > 0;
    return true;
  });
}

function addContentModalities(
  counts: CountBy<ContentModality>,
  content: InteractionContent[] | string | null,
): void {
  if (typeof content === "string") {
    counts.text += 1;
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (part.type === "text" || part.type === "image") counts[part.type] += 1;
  }
}

function toolChoiceKind(
  choice: InteractionToolChoice,
): NonNullable<InteractionObservabilityMetadata["controls"]["tool_choice"]> {
  return typeof choice === "string" ? choice : choice.kind;
}
