/* `POST .../routing/activity/imports`: sessions a coding agent kept on a
   user's machine (`dari traces import`), stored as the requests Activity
   shows. Each model call becomes a request under the organization's
   "Imported" router with its token counts; none has a cost, a selector, or
   billing facts, so nothing is billed for it. */

import { isRecord } from "@mupt-ai/dari-router/policy-engine";

import type {
  InteractionItem,
  InteractionOutput,
  InteractionOutputItem,
  InteractionRequest,
  SourceProtocol,
} from "../interaction/types.js";
import {
  anthropicContent,
  anthropicStopReason,
  anthropicUsage,
} from "../protocol/output/anthropic_messages_output.js";
import { assistantMessagePayload } from "../protocol/output/chat_completions.js";
import {
  openAIResponsesOutputItems,
  openAIResponsesTerminal,
  openAIResponsesUsage,
} from "../protocol/output/openai_responses_output.js";
import { extractInteractionObservability } from "../telemetry/requests/interaction_observability.js";
import { encodeRetainedInteractionRequest } from "../telemetry/requests/retained_interaction_request.js";
import { toolResultObservations, toolSkillEvents } from "../telemetry/tools/observations.js";
import type { ActivityRequest } from "./http.js";
import { activityError, notFound } from "./params.js";

/** The router imported requests are filed under. */
export const IMPORTED_ROUTER_NAME = "Imported";

// The protocol each agent speaks, which Activity reads its responses in.
const AGENT_PROTOCOLS: Record<string, SourceProtocol> = {
  claude: "anthropic_messages",
  codex: "openai_responses",
  opencode: "openai_chat",
  pi: "openai_chat",
};
const MAX_TURNS = 100;
const SESSION_ID_MAX_CHARS = 64;
// An imported request's ID is the CLI's hash of its agent, session, and
// transcript entry; the prefix keeps it apart from a served request's.
const REQUEST_ID = /^imp_[0-9a-f]{32}$/;
const STOP_REASONS = ["stop", "length", "tool_use"] as const;
const TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const;

type ImportedTurn = {
  request_id: string;
  input_items: number;
  output_items: number;
  model: string;
  provider: string;
  received_at: string;
  completed_at: string;
  stop_reason: (typeof STOP_REASONS)[number];
  usage: Record<(typeof TOKEN_FIELDS)[number], number>;
};

type ImportedSession = {
  agent: string;
  session_id: string;
  agent_id?: string;
  items: InteractionItem[];
  turns: ImportedTurn[];
};

/** Store one session's model calls; answers how many were new. */
export async function importSession(request: ActivityRequest): Promise<object> {
  const store = request.platform.importRequest;
  if (store === undefined) throw notFound("Not Found");
  const session = importedSession(await request.body());
  const organizationId = request.admitted();
  let imported = 0;
  for (const turn of session.turns) {
    const report = importedRequestReport(organizationId, session, turn);
    if (await store({ organizationId, userId: request.userId }, report)) imported += 1;
  }
  return { imported, existing: session.turns.length - imported };
}

/** One imported model call as a request report, without a router. */
export function importedRequestReport(
  organizationId: string,
  session: ImportedSession,
  turn: ImportedTurn,
): Record<string, unknown> {
  const sourceProtocol = AGENT_PROTOCOLS[session.agent]!;
  const interaction: InteractionRequest = {
    sourceProtocol,
    ...(session.agent_id === undefined
      ? {}
      : { agentContext: { requestClass: "subagent" as const, agentId: session.agent_id } }),
    model: turn.model,
    items: session.items.slice(0, turn.input_items),
    tools: [],
    generation: {},
    stream: false,
  };
  const { usage } = turn;
  const totalTokens = TOKEN_FIELDS.reduce((sum, field) => sum + usage[field], 0);
  const output: InteractionOutput = {
    createdAtMs: Date.parse(turn.completed_at),
    source: { provider: turn.provider, api: sourceProtocol, model: turn.model },
    items: session.items.slice(turn.input_items, turn.input_items + turn.output_items) as InteractionOutputItem[],
    usage: {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_tokens,
      cacheWrite: usage.cache_write_tokens,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: turn.stop_reason,
  };
  const observability = extractInteractionObservability(interaction);
  const retained = encodeRetainedInteractionRequest(interaction);
  // The tool events' context hash only pairs a call with its result, so any
  // one name for the router serves.
  const tools = { routerId: IMPORTED_ROUTER_NAME, request: interaction, zdr: false };
  return {
    request_id: turn.request_id,
    client_request_id: null,
    organization_id: organizationId,
    api_key_id: null,
    attributed_user_id: null,
    source_protocol: sourceProtocol,
    request_kind: observability.requestKind,
    received_at: turn.received_at,
    completed_at: turn.completed_at,
    stream: false,
    zdr: false,
    status: "completed",
    error_code: null,
    error_message: null,
    conversation_id: session.session_id,
    agent_session_id: session.session_id,
    message_count: observability.messageCount,
    has_tools: observability.hasTools,
    request_metadata: observability.metadata,
    selected_model: turn.model,
    selected_provider: turn.provider,
    provider_key_source: null,
    total_latency_ms: Date.parse(turn.completed_at) - Date.parse(turn.received_at),
    client_request_json: retained.json,
    client_request_format: retained.format,
    client_response_json: JSON.stringify(responseBody(sourceProtocol, turn, output)),
    // Token counts only: an imported request has no cost.
    provider_call: {
      stop_reason: turn.stop_reason,
      usage: { ...usage, total_tokens: totalTokens, pricing_known: false },
    },
    tool_skill_events: toolSkillEvents({ ...tools, output }),
    tool_result_observations: toolResultObservations(tools),
  };
}

// The response as the agent's protocol would have carried it.
function responseBody(protocol: SourceProtocol, turn: ImportedTurn, output: InteractionOutput): Record<string, unknown> {
  if (protocol === "anthropic_messages") {
    return {
      id: turn.request_id,
      type: "message",
      role: "assistant",
      model: turn.model,
      content: anthropicContent(output),
      stop_reason: anthropicStopReason(output),
      stop_sequence: null,
      usage: anthropicUsage(output),
    };
  }
  if (protocol === "openai_responses") {
    return {
      id: turn.request_id,
      object: "response",
      created_at: Math.floor(output.createdAtMs / 1000),
      ...openAIResponsesTerminal(output),
      model: turn.model,
      output: openAIResponsesOutputItems(output),
      usage: openAIResponsesUsage(output),
    };
  }
  return {
    id: turn.request_id,
    object: "chat.completion",
    created: Math.floor(output.createdAtMs / 1000),
    model: turn.model,
    choices: [{
      index: 0,
      message: assistantMessagePayload(output),
      finish_reason: turn.stop_reason === "tool_use" ? "tool_calls" : turn.stop_reason,
    }],
  };
}

function importedSession(body: unknown): ImportedSession {
  const invalid = (message: string) => activityError(422, message);
  if (!isRecord(body)) throw invalid("The body must be a JSON object.");
  const { agent, session_id: sessionId, agent_id: agentId, items, turns } = body;
  if (typeof agent !== "string" || !Object.hasOwn(AGENT_PROTOCOLS, agent)) {
    throw invalid(`agent must be one of ${Object.keys(AGENT_PROTOCOLS).join(", ")}.`);
  }
  if (typeof sessionId !== "string" || sessionId === "" || sessionId.length > SESSION_ID_MAX_CHARS) {
    throw invalid(`session_id must be 1 to ${SESSION_ID_MAX_CHARS} characters.`);
  }
  if (agentId !== undefined && (typeof agentId !== "string" || agentId === "")) {
    throw invalid("agent_id must be a non-empty string.");
  }
  if (!Array.isArray(items) || !items.every(isInteractionItem)) {
    throw invalid("items must be messages, reasoning, tool calls, and tool results.");
  }
  if (!Array.isArray(turns) || turns.length === 0 || turns.length > MAX_TURNS) {
    throw invalid(`turns must hold 1 to ${MAX_TURNS} model calls.`);
  }
  for (const turn of turns) {
    if (!isRecord(turn) || typeof turn.request_id !== "string" || !REQUEST_ID.test(turn.request_id)) {
      throw invalid("Each turn needs a request_id of imp_ and 32 hex digits.");
    }
    const invalidTurn = (message: string) => invalid(`Turn ${turn.request_id}: ${message}`);
    const { input_items: input, output_items: count } = turn;
    if (!isCount(input) || !isCount(count) || input + count > items.length) {
      throw invalidTurn("input_items and output_items must lie within items.");
    }
    if (items.slice(input, input + count).some((item) => item.type === "tool_result")) {
      throw invalidTurn("a response holds no tool results.");
    }
    if (typeof turn.model !== "string" || turn.model === "" || typeof turn.provider !== "string" || turn.provider === "") {
      throw invalidTurn("model and provider are required.");
    }
    if (!isInstant(turn.received_at) || !isInstant(turn.completed_at) || Date.parse(turn.completed_at) < Date.parse(turn.received_at)) {
      throw invalidTurn("received_at and completed_at must be timestamps with an offset, in order.");
    }
    if (!STOP_REASONS.includes(turn.stop_reason as (typeof STOP_REASONS)[number])) {
      throw invalidTurn(`stop_reason must be one of ${STOP_REASONS.join(", ")}.`);
    }
    const { usage } = turn;
    if (!isRecord(usage) || !TOKEN_FIELDS.every((field) => isCount(usage[field]))) {
      throw invalidTurn(`usage needs ${TOKEN_FIELDS.join(", ")}.`);
    }
  }
  return body as ImportedSession;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

// An RFC 3339 timestamp, whose offset the stored request needs.
function isInstant(value: unknown): value is string {
  return typeof value === "string" && /(Z|[+-]\d\d:\d\d)$/.test(value) && !Number.isNaN(Date.parse(value));
}

const isText = (value: unknown) => typeof value === "string";

// The items the CLI's transcript parsers write.
function isInteractionItem(item: unknown): item is InteractionItem {
  if (!isRecord(item)) return false;
  const toolKind = item.kind === "function" || item.kind === "custom";
  switch (item.type) {
    case "message":
      return ["system", "developer", "user", "assistant"].includes(item.role as string)
        && Array.isArray(item.content)
        && item.content.every((part) => isRecord(part) && part.type === "text" && isText(part.text));
    case "reasoning":
      return Array.isArray(item.summary) && item.summary.every(isText)
        && Array.isArray(item.content) && item.content.every(isText);
    case "tool_call":
      return toolKind && isText(item.callId) && isText(item.name)
        && (item.namespace === undefined || isText(item.namespace));
    case "tool_result":
      return toolKind && isText(item.callId) && isText(item.output);
    default:
      return false;
  }
}
