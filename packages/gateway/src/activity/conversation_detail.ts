/* One conversation: its agent streams, context runs, a page of its steps
   (newest page first, each page oldest first), and the tool exchanges and
   skill events of that page. */

import {
  consecutivePath,
  contextRun,
  conversationSummary,
  decisionDetails,
  findRecord,
  groupsCondition,
  loadEntities,
  loadRecords,
  optionalFixed,
  pyRepr,
  recordKey,
  requestBlobFormat,
  selectedEffort,
  supported,
  type ConversationRecord,
} from "./conversation_records.js";
import type { SourceProtocol } from "./filters.js";
import type { ActivityRoute } from "./http.js";
import { notFound } from "./params.js";
import { sessionCommits, withPullRequests } from "./pull_requests.js";
import { thinkingLevelValue } from "./shared.js";
import { sql, type ActivityDb } from "./sql.js";
import { formatInstant, readOptionalString } from "./values.js";
import { EXCHANGE_MAX_LIMIT, EXCHANGE_STATES, loadToolExchanges } from "./tool_exchanges.js";

const REQUEST_CLASSES = ["main", "subagent", "workflow", "auxiliary", "compaction", "side_reply", "unknown"] as const;

/** The selector reason older rows carry for the single-candidate fast path. */
const SINGLE_CANDIDATE_REASON = "The router has only one compatible model/thinking-level pair.";

type AgentContext = { requestClass: string; agentId: string | null; parentAgentId: string | null; agentType: string | null };

/** The stored agent context, or an unknown request class. */
function agentContext(record: ConversationRecord): AgentContext {
  const metadata = record.requestMetadata;
  const context = metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).agent_context
    : null;
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    return { requestClass: "unknown", agentId: null, parentAgentId: null, agentType: null };
  }
  const value = context as Record<string, unknown>;
  return {
    requestClass: typeof value.requestClass === "string" && (REQUEST_CLASSES as readonly string[]).includes(value.requestClass)
      ? value.requestClass
      : "unknown",
    agentId: readOptionalString(value.agentId),
    parentAgentId: readOptionalString(value.parentAgentId),
    agentType: readOptionalString(value.agentType),
  };
}

/** The name of the plan that served the request, when one did. */
function subscriptionAccount(record: ConversationRecord): string | null {
  const metadata = record.requestMetadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return readOptionalString((metadata as Record<string, unknown>).subscription_account);
}

function routePath(records: readonly ConversationRecord[]) {
  const path: Array<{ model: string; thinking_level: string | null }> = [];
  for (const record of records) {
    if (record.selectedModel === null) continue;
    const route = { model: record.selectedModel, thinking_level: selectedEffort(record) };
    const last = path.at(-1);
    if (last?.model === route.model && last.thinking_level === route.thinking_level) continue;
    path.push(route);
  }
  return path;
}

function modelPath(records: readonly ConversationRecord[]): string[] {
  return consecutivePath(records.map((record) => record.selectedModel));
}

/** Records grouped by a key, groups in first-seen order. */
function groupBy<K>(records: readonly ConversationRecord[], keyOf: (record: ConversationRecord) => K, text: (key: K) => string) {
  const groups = new Map<string, { key: K; records: ConversationRecord[] }>();
  for (const record of records) {
    const key = keyOf(record);
    const group = groups.get(text(key)) ?? { key, records: [] };
    group.records.push(record);
    groups.set(text(key), group);
  }
  return [...groups.values()];
}

export const conversation: ActivityRoute = async (request) => {
  const { params, db } = request;
  const limit = params.int("limit", { default: 25, ge: 1, le: 100 });
  const offset = params.int("offset", { default: 0, ge: 0 });
  const requestClass = params.literal("request_class", REQUEST_CLASSES);
  const agentId = params.string("agent_id", { minLength: 1, maxLength: 200 });
  const focusStepId = params.string("focus_step_id", { minLength: 1, maxLength: 200 });
  params.done();
  const organizationId = request.admitted();
  const ref = request.path.conversation_ref!;
  const unknown = notFound(`Unknown routing conversation ${pyRepr(ref)}.`);

  const reference = await findRecord(db, ref, organizationId);
  if (!supported(reference, organizationId)) throw unknown;
  const all = await loadRecords(db, sql`
    r.organization_id = ${organizationId}
    and r.source_protocol = ${reference.sourceProtocol}
    and ${groupsCondition([recordKey(reference)])}`);
  if (all.length === 0) throw unknown;
  const entities = await loadEntities(db, all);
  const currentRouterZdr = reference.routerId !== null && (entities.routers.get(reference.routerId)?.zdr ?? false);

  let wantedClass: string | null = requestClass ?? null;
  let wantedAgent: string | null = agentId ?? null;
  let focused = false;
  let focusedRequestClass: string | null = null;
  let focusedAgentId: string | null = null;
  if (focusStepId !== undefined) {
    const step = all.find((record) => record.id === focusStepId);
    if (step === undefined) throw notFound("Unknown step in this conversation.");
    const context = agentContext(step);
    focused = true;
    wantedClass = focusedRequestClass = context.requestClass;
    wantedAgent = focusedAgentId = context.agentId;
  }
  const filtered = all.filter((record) => {
    const context = agentContext(record);
    if (wantedClass !== null && context.requestClass !== wantedClass) return false;
    if ((wantedAgent !== null || focused) && context.agentId !== wantedAgent) return false;
    return true;
  });
  // The offset counts from the newest step; a page stays oldest first.
  const end = filtered.length - offset;
  const start = Math.max(0, end - limit);
  const page = end > 0 ? filtered.slice(start, end) : [];
  const skills = await loadSkillEvents(db, page);
  const exchanges = await pageToolExchanges(db, organizationId, page);

  const streams = groupBy(all, agentContext, (c) => JSON.stringify([c.requestClass, c.agentId])).map(({ key, records }) => {
    const first = agentContext(records[0]!);
    return {
      request_class: key.requestClass,
      agent_id: key.agentId,
      parent_agent_id: first.parentAgentId,
      agent_type: first.agentType,
      model_steps: records.length,
      model_path: modelPath(records),
      route_path: routePath(records),
    };
  });
  const contextRuns = groupBy(filtered, contextRun, (run) => run).map(({ records }) => ({
    context_run_ref: records[0]!.id,
    conversation_id: records[0]!.conversationId || null,
    first_at: formatInstant(records[0]!.receivedAt),
    last_at: formatInstant(records.at(-1)!.receivedAt),
    model_steps: records.length,
    model_path: modelPath(records),
    route_path: routePath(records),
  }));
  const hasMore = start > 0;
  const [summary] = await withPullRequests(db, organizationId, [conversationSummary(all, entities, undefined, null)]);
  return {
    conversation: summary!,
    commits: await sessionCommits(db, organizationId, summary!.source_protocol, summary!.agent_session_id),
    streams,
    filtered_model_steps: filtered.length,
    focused_request_class: focusedRequestClass,
    focused_agent_id: focusedAgentId,
    context_runs: contextRuns,
    steps: page.map((record) => conversationStep(record, organizationId, currentRouterZdr, skills.get(record.id) ?? [])),
    tool_exchanges: exchanges.items,
    tool_exchanges_truncated: exchanges.next_offset !== null,
    limit,
    offset,
    has_more: hasMore,
    next_offset: hasMore ? offset + limit : null,
  };
};

function conversationStep(record: ConversationRecord, organizationId: string, currentRouterZdr: boolean, skillEvents: object[]) {
  const details = decisionDetails(record);
  const agent = agentContext(record);
  const effort = selectedEffort(record);
  const bypassed = details?.selector_policy_bypass === "single_candidate" || record.selectorReason === SINGLE_CANDIDATE_REASON;
  let selectorModel: string | null = null;
  let selectorEffort: string | null = null;
  if (details !== null) {
    if (details.decision_source !== "speculative_selector") {
      selectorModel = record.selectedModel;
      selectorEffort = effort;
    } else {
      const speculative = details.speculative_routing;
      if (speculative !== null && typeof speculative === "object" && !Array.isArray(speculative)) {
        const next = speculative as Record<string, unknown>;
        selectorModel = typeof next.next_model === "string" ? next.next_model : null;
        selectorEffort = thinkingLevelValue(next.next_reasoning_effort);
      }
    }
  }
  const zdr = record.zdr || currentRouterZdr;
  // ZDR content is never served, even when an older blob is still stored.
  const available = (key: string | null) => !zdr && Boolean(record.blobBucket) && Boolean(key);
  const url = (name: string) => `/v1/organizations/${organizationId}/routing/activity/requests/${record.id}/${name}`;
  return {
    id: record.id,
    conversation_id: record.conversationId || null,
    source_protocol: record.sourceProtocol,
    request_kind: record.requestKind,
    request_class: agent.requestClass,
    agent_id: agent.agentId,
    parent_agent_id: agent.parentAgentId,
    agent_type: agent.agentType,
    status: record.status,
    error_code: record.errorCode,
    error_message: record.errorMessage,
    selected_model: record.selectedModel,
    selected_reasoning_effort: effort,
    selected_provider: record.selectedProvider,
    subscription_account: subscriptionAccount(record),
    provider_input_tokens: record.providerInputTokens,
    provider_cache_read_tokens: record.providerCacheReadTokens,
    provider_cache_write_tokens: record.providerCacheWriteTokens,
    provider_output_tokens: record.providerOutputTokens,
    provider_total_tokens: record.providerTotalTokens,
    provider_spend_usd: optionalFixed(record.providerTotalCostUsd),
    provider_pricing_known: record.providerPricingKnown,
    selector_latency_ms: record.selectorLatencyMs,
    provider_latency_ms: record.providerLatencyMs,
    total_latency_ms: record.totalLatencyMs,
    message_count: record.messageCount,
    has_declared_tools: record.hasTools,
    received_at: formatInstant(record.receivedAt),
    completed_at: record.completedAt === null ? null : formatInstant(record.completedAt),
    zdr,
    decision_source: typeof details?.decision_source === "string" ? details.decision_source : null,
    selector_reason: record.selectorReason,
    selector_policy_bypassed: bypassed,
    selector_selected_model: selectorModel,
    selector_selected_reasoning_effort: selectorEffort,
    selector_lease_turns: record.leaseTurns,
    client_request_url: available(record.requestBlobKey) ? url("client-request") : null,
    client_response_url: available(record.responseBlobKey) ? url("client-response") : null,
    selector_output_url: !bypassed && available(record.selectorOutputBlobKey) ? url("selector-output") : null,
    client_request_format: requestBlobFormat(record),
    client_response_format: record.sourceProtocol,
    skill_events: skillEvents,
  };
}

/** The skill uses and loads of the steps, by step, in ordinal order. */
async function loadSkillEvents(db: ActivityDb, records: readonly ConversationRecord[]): Promise<Map<string, object[]>> {
  const events = new Map<string, object[]>();
  if (records.length === 0) return events;
  const rows = await db.all(sql`
    select routing_request_id, event_type, capability_id, observed_name, skill_version, evidence_source
    from routing_tool_skill_events
    where routing_request_id in (${records.map((record) => record.id)})
      and event_type in ('skill_use', 'skill_load')
    order by routing_request_id, ordinal`);
  for (const row of rows) {
    const id = String(row.routing_request_id);
    events.set(id, [...(events.get(id) ?? []), {
      event_type: row.event_type,
      capability_id: row.capability_id,
      observed_name: row.observed_name,
      skill_version: readOptionalString(row.skill_version),
      evidence_source: row.evidence_source,
    }]);
  }
  return events;
}

/** The tool exchanges of the page's steps, regardless of the time window. */
async function pageToolExchanges(db: ActivityDb, organizationId: string, page: readonly ConversationRecord[]) {
  if (page.length === 0) return { items: [], next_offset: null };
  const start = Math.min(...page.map((record) => record.receivedAt));
  const protocols = [...new Set(page.map((record) => record.sourceProtocol as SourceProtocol))];
  return loadToolExchanges(db, organizationId, {
    start,
    end: start + 1_000_000,
    bucketSeconds: 0,
    protocols,
    apiKeyIds: [],
    userIds: [],
    models: [],
  }, {
    states: EXCHANGE_STATES,
    capabilityId: null,
    requestIds: page.map((record) => record.id),
    includeTotal: false,
    limit: EXCHANGE_MAX_LIMIT,
    offset: 0,
  });
}
