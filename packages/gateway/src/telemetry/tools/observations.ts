import { isRecord, stableStringify } from "@mupt-ai/dari-router/policy-engine";

import { interactionPrefixChain } from "../../context/interaction_fingerprint.js";
import type {
  InteractionContent,
  InteractionItem,
  InteractionOutput,
  InteractionRequest,
  InteractionToolResult,
} from "../../interaction/types.js";
import { isProtocolToolCallId } from "../../interaction/tool_identity.js";
import { anthropicMessagesToInteraction } from "../../protocol/input/anthropic_messages.js";
import { internalChatCompletionsToInteraction } from "../../protocol/input/chat_completions.js";
import { anthropicContent } from "../../protocol/output/anthropic_messages_output.js";
import { assistantMessagePayload } from "../../protocol/output/chat_completions.js";
import type { HarnessConversationIdentity } from "../../runtime/harness_identity/index.js";
import {
  inputSkillObservations,
  outputSkillObservations,
} from "../skills/observations.js";

const MAX_TOOL_SKILL_EVENTS = 1000;

export type ToolSkillEventReport = {
  event_type: "tool_call" | "skill_use" | "skill_load";
  tool_call_id: string | null;
  exchange_context_hash: string | null;
  capability_id: string;
  observed_name: string;
  skill_version: null;
  evidence_source:
    | "model_tool_call"
    | "skill_content_injection"
    | "skill_command_expansion"
    | "skill_tool_activation"
    | "skill_file_read";
  ordinal: number;
};

export type ToolResultObservationReport = {
  tool_call_id: string;
  exchange_context_hash: string | null;
  ordinal: number;
};

export function toolSkillEvents(args: {
  routerId: string;
  request: InteractionRequest;
  output: InteractionOutput | undefined;
  harnessConversationIdentity?: HarnessConversationIdentity;
  zdr: boolean;
}): ToolSkillEventReport[] {
  if (args.zdr) return [];
  const outputEvents = (args.output?.items ?? [])
    .flatMap((item, ordinal) =>
      item.type === "tool_call"
        && isProtocolToolCallId(item.callId)
        ? [{ item, ordinal }]
        : []
    )
    .slice(0, MAX_TOOL_SKILL_EVENTS);
  const explicitSkills = inputSkillObservations({
    ...args,
    limit: MAX_TOOL_SKILL_EVENTS - outputEvents.length,
  });
  const outputCallIds = new Set(outputEvents.map(({ item }) => item.callId));
  const automaticSkills = args.output === undefined
    ? []
    : outputSkillObservations({
        request: args.request,
        output: args.output,
        harnessConversationIdentity: args.harnessConversationIdentity,
        limit: MAX_TOOL_SKILL_EVENTS,
      }).filter(
        (skill) =>
          skill.toolCallId !== null
          && outputCallIds.has(skill.toolCallId),
      ).slice(
        0,
        MAX_TOOL_SKILL_EVENTS - outputEvents.length - explicitSkills.length,
      );
  if (
    explicitSkills.length === 0
    && automaticSkills.length === 0
    && outputEvents.length === 0
  ) return [];

  const exchangeContextHash = outputEvents.length === 0 || args.output === undefined
    ? null
    : outputExchangeContextHash(args.routerId, args.request, args.output);
  const reportedExplicitSkills = explicitSkills.map((skill, ordinal) => ({
    event_type: skill.eventType,
    tool_call_id: skill.toolCallId,
    exchange_context_hash: null,
    capability_id: skill.capabilityId,
    observed_name: skill.observedName,
    skill_version: null,
    evidence_source: skill.evidenceSource,
    ordinal,
  }));
  const reportedAutomaticSkills = automaticSkills.map((skill, ordinal) => ({
    event_type: skill.eventType,
    tool_call_id: skill.toolCallId,
    exchange_context_hash: exchangeContextHash,
    capability_id: skill.capabilityId,
    observed_name: skill.observedName,
    skill_version: null,
    evidence_source: skill.evidenceSource,
    ordinal: explicitSkills.length + ordinal,
  }));
  const skillCount = explicitSkills.length + automaticSkills.length;
  const reportedOutputEvents = outputEvents.map(({ item, ordinal }) => {
    const observedName = item.namespace
      ? `${item.namespace}.${item.name}`
      : item.name;
    return {
      event_type: "tool_call" as const,
      tool_call_id: item.callId,
      exchange_context_hash: exchangeContextHash,
      capability_id: observedName,
      observed_name: observedName,
      skill_version: null,
      evidence_source: "model_tool_call" as const,
      ordinal: skillCount + ordinal,
    };
  });
  return [
    ...reportedExplicitSkills,
    ...reportedAutomaticSkills,
    ...reportedOutputEvents,
  ];
}

export function toolResultObservations(args: {
  routerId: string;
  request: InteractionRequest;
  zdr: boolean;
}): ToolResultObservationReport[] {
  if (args.zdr) return [];
  const submitted = newlySubmittedToolResults(args.request);
  if (submitted.results.length === 0) return [];

  const requestBeforeResults: InteractionRequest = {
    ...args.request,
    items: args.request.items.slice(0, submitted.contextEnd),
  };
  const exchangeContextHash =
    interactionPrefixChain(
      args.routerId,
      normalizeExchangeRequest(requestBeforeResults),
      null,
    ).at(-1) ??
    null;

  return submitted.results.slice(0, 1000).map(({ item, ordinal }) => ({
    tool_call_id: item.callId,
    exchange_context_hash: exchangeContextHash,
    ordinal,
  }));
}

function newlySubmittedToolResults(
  request: InteractionRequest
): {
  results: Array<{ item: InteractionToolResult; ordinal: number }>;
  contextEnd: number;
} {
  if (request.sourceProtocol === "anthropic_messages") {
    return currentAnthropicUserTurnResults(request.items);
  }

  const results: Array<{ item: InteractionToolResult; ordinal: number }> = [];
  for (let ordinal = request.items.length - 1; ordinal >= 0; ordinal -= 1) {
    const item = request.items[ordinal];
    if (item.type !== "tool_result") break;
    if (isProtocolToolCallId(item.callId)) results.push({ item, ordinal });
  }
  const ordered = results.reverse();
  return {
    results: ordered,
    contextEnd: ordered[0]?.ordinal ?? request.items.length,
  };
}

function currentAnthropicUserTurnResults(
  items: InteractionItem[]
): {
  results: Array<{ item: InteractionToolResult; ordinal: number }>;
  contextEnd: number;
} {
  const results: Array<{ item: InteractionToolResult; ordinal: number }> = [];
  let contextEnd = 0;
  for (let ordinal = items.length - 1; ordinal >= 0; ordinal -= 1) {
    const item = items[ordinal];
    if (isAssistantOutputItem(item)) {
      contextEnd = ordinal + 1;
      break;
    }
    if (item.type === "tool_result" && isProtocolToolCallId(item.callId)) {
      results.push({ item, ordinal });
    }
  }
  return { results: results.reverse(), contextEnd };
}

function isAssistantOutputItem(item: InteractionItem): boolean {
  return item.type === "reasoning"
    || item.type === "tool_call"
    || item.type === "hosted_tool_call"
    || (item.type === "message" && item.role === "assistant");
}

function outputExchangeContextHash(
  routerId: string,
  request: InteractionRequest,
  output: InteractionOutput
): string | null {
  const outputItems = clientVisibleOutputItems(request.sourceProtocol, output);
  const completedRequest = normalizeExchangeRequest({
    ...request,
    items: [...request.items, ...outputItems],
  });
  return interactionPrefixChain(routerId, completedRequest, null).at(-1) ?? null;
}

function clientVisibleOutputItems(
  sourceProtocol: InteractionRequest["sourceProtocol"],
  output: InteractionOutput,
): InteractionItem[] {
  if (sourceProtocol === "openai_chat") {
    return internalChatCompletionsToInteraction({
      model: "dari/routing",
      messages: [assistantMessagePayload(output)],
    }).items;
  }
  if (sourceProtocol === "anthropic_messages") {
    return anthropicMessagesToInteraction({
      model: "dari/routing",
      max_tokens: 1,
      messages: [{ role: "assistant", content: anthropicContent(output) }],
    }).items;
  }
  return output.items;
}

function normalizeExchangeRequest(request: InteractionRequest): InteractionRequest {
  // Claude Code may omit thinking blocks when it submits tool results even
  // though those blocks were present in the preceding Anthropic response.
  const items = request.sourceProtocol === "anthropic_messages"
    ? request.items.filter((item) => item.type !== "reasoning")
    : request.items;
  return {
    ...request,
    instructions: undefined,
    tools: [],
    items: items.map(normalizeExchangeItem),
  };
}

// Correlation follows semantic tool history, not wire-only item IDs, message
// phases, content container shapes, or JSON object insertion order.
function normalizeExchangeItem(item: InteractionItem): InteractionItem {
  if (item.type === "reasoning") {
    const { id: _id, ...rest } = item;
    return rest;
  }
  if (item.type === "message") {
    const { id: _id, phase: _phase, ...rest } = item;
    return {
      ...rest,
      ...normalizeContent(item.content, item.contentShape, item.role === "assistant"),
    };
  }
  if (item.type === "tool_call") {
    const { id: _id, ...rest } = item;
    return {
      ...rest,
      input: normalizeFunctionInput(item.kind, item.input),
    };
  }
  if (item.type === "tool_result") {
    const { id: _id, ...rest } = item;
    if (!Array.isArray(item.output)) return rest;
    const normalized = normalizeContent(item.output, item.outputShape);
    return { ...rest, output: normalized.content, outputShape: normalized.contentShape };
  }
  if (item.type === "hosted_tool_call") {
    const {
      id: _id,
      source: _source,
      payload: { id: _payloadId, status: _payloadStatus, ...payload },
      ...rest
    } = item;
    return {
      ...rest,
      id: "",
      payload: item.status ? { ...payload, status: item.status } : payload,
    };
  }
  return item;
}

function normalizeContent(
  content: InteractionContent[],
  contentShape: "string" | "parts" | "null" | "absent",
  collapseEmpty = false,
): { content: InteractionContent[]; contentShape: "string" | "parts" | "null" | "absent" } {
  if (
    collapseEmpty
    && content.every(
      (part) => part.type === "text" && part.text.length === 0 && !part.annotations?.length,
    )
  ) {
    return { content: [], contentShape: "null" };
  }
  if (contentShape === "null" || contentShape === "absent") {
    return { content, contentShape };
  }
  if (
    content.every(
      (part) => part.type === "text" && !part.annotations?.length,
    )
  ) {
    return {
      content: [{
        type: "text",
        text: content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join(""),
      }],
      contentShape: "string",
    };
  }
  return { content, contentShape: "parts" };
}

function normalizeFunctionInput(
  kind: "function" | "custom",
  input: string | Record<string, unknown> | undefined
): string | Record<string, unknown> | undefined {
  if (kind === "custom" || input === undefined) return input;
  if (isRecord(input)) return stableStringify(input);
  try {
    const parsed: unknown = JSON.parse(input);
    return isRecord(parsed) ? stableStringify(parsed) : input;
  } catch {
    return input;
  }
}
