/* Conversations as Activity reads them: the `routing_requests` rows of one
   inferred conversation, the names those rows point at, and the summary the
   list and the detail both show. A conversation is the steps sharing a
   protocol, agent session marker, router, API key, and attributed person. */

import { SUPPORTED_SOURCE_PROTOCOLS } from "./filters.js";
import { AGENT_SESSION_KEY, thinkingLevelValue, type ReasoningEffort } from "./shared.js";
import { or, sql, type ActivityDb, type Sql } from "./sql.js";
import {
  addDecimals,
  formatInstant,
  parseDecimal,
  readBool,
  readInstant,
  readInt,
  readJson,
  readOptionalBool,
  readOptionalInstant,
  readOptionalInt,
  readOptionalString,
  type Decimal,
  type Instant,
} from "./values.js";

/** A routing_requests row as the conversation reads use it. */
export type ConversationRecord = {
  id: string;
  requestId: string;
  organizationId: string | null;
  sourceProtocol: string | null;
  routerId: string | null;
  apiKeyId: string | null;
  attributedUserId: string | null;
  requestKind: string | null;
  conversationId: string | null;
  agentSessionId: string | null;
  conversationTitle: string | null;
  zdr: boolean;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  selectedModel: string | null;
  selectedProvider: string | null;
  providerInputTokens: number | null;
  providerCacheReadTokens: number | null;
  providerCacheWriteTokens: number | null;
  providerOutputTokens: number | null;
  providerTotalTokens: number | null;
  providerTotalCostUsd: string | number | null;
  providerPricingKnown: boolean | null;
  selectorLatencyMs: number | null;
  providerLatencyMs: number | null;
  totalLatencyMs: number | null;
  messageCount: number;
  hasTools: boolean;
  receivedAt: Instant;
  completedAt: Instant | null;
  decisionDetails: unknown;
  requestMetadata: unknown;
  selectorReason: string | null;
  blobBucket: string | null;
  requestBlobKey: string | null;
  responseBlobKey: string | null;
  selectorOutputBlobKey: string | null;
  requestBlobFormat: string | null;
  /** `selector_lease_turns` when it is a positive integer. */
  leaseTurns: number | null;
};

/** The columns `readRecord` reads. */
function recordColumns(db: ActivityDb): Sql {
  // `selector_lease_turns` as text when it is a JSON integer, which a parsed
  // JSON value cannot tell from a float such as `3.0`.
  const leaseTurns = db.dialect === "postgres"
    ? sql`case when jsonb_typeof(r.decision_details -> 'selector_lease_turns') = 'number'
               then r.decision_details ->> 'selector_lease_turns' end`
    : sql`case when json_type(r.decision_details, '$.selector_lease_turns') = 'integer'
               then cast(json_extract(r.decision_details, '$.selector_lease_turns') as text) end`;
  return sql`
    r.id, r.request_id, r.organization_id, r.source_protocol, r.router_id, r.api_key_id, r.attributed_user_id,
    r.request_kind, r.conversation_id, r.agent_session_id, r.conversation_title,
    r.zdr, r.status, r.error_code, r.error_message,
    r.selected_model, r.selected_provider,
    r.provider_input_tokens, r.provider_cache_read_tokens, r.provider_cache_write_tokens,
    r.provider_output_tokens, r.provider_total_tokens,
    cast(r.provider_total_cost_usd as text) as provider_total_cost_usd,
    r.provider_pricing_known,
    r.selector_latency_ms, r.provider_latency_ms, r.total_latency_ms,
    r.message_count, r.has_tools,
    cast(r.received_at as text) as received_at,
    cast(r.completed_at as text) as completed_at,
    r.decision_details, r.request_metadata, r.selector_reason,
    r.blob_bucket, r.request_blob_key, r.response_blob_key, r.selector_output_blob_key, r.request_blob_format,
    ${leaseTurns} as lease_turns`;
}

function readRecord(db: ActivityDb, row: Record<string, unknown>): ConversationRecord {
  const text = readOptionalString;
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    organizationId: text(row.organization_id),
    sourceProtocol: text(row.source_protocol),
    routerId: text(row.router_id),
    apiKeyId: text(row.api_key_id),
    attributedUserId: text(row.attributed_user_id),
    requestKind: text(row.request_kind),
    conversationId: text(row.conversation_id),
    agentSessionId: text(row.agent_session_id),
    conversationTitle: text(row.conversation_title),
    zdr: readBool(row.zdr),
    status: String(row.status),
    errorCode: text(row.error_code),
    errorMessage: text(row.error_message),
    selectedModel: text(row.selected_model),
    selectedProvider: text(row.selected_provider),
    providerInputTokens: readOptionalInt(row.provider_input_tokens),
    providerCacheReadTokens: readOptionalInt(row.provider_cache_read_tokens),
    providerCacheWriteTokens: readOptionalInt(row.provider_cache_write_tokens),
    providerOutputTokens: readOptionalInt(row.provider_output_tokens),
    providerTotalTokens: readOptionalInt(row.provider_total_tokens),
    providerTotalCostUsd: (row.provider_total_cost_usd ?? null) as string | number | null,
    providerPricingKnown: readOptionalBool(row.provider_pricing_known),
    selectorLatencyMs: readOptionalInt(row.selector_latency_ms),
    providerLatencyMs: readOptionalInt(row.provider_latency_ms),
    totalLatencyMs: readOptionalInt(row.total_latency_ms),
    messageCount: readInt(row.message_count),
    hasTools: readBool(row.has_tools),
    receivedAt: readInstant(row.received_at),
    completedAt: readOptionalInstant(row.completed_at),
    decisionDetails: readJson(db, row.decision_details),
    requestMetadata: readJson(db, row.request_metadata),
    selectorReason: text(row.selector_reason),
    blobBucket: text(row.blob_bucket),
    requestBlobKey: text(row.request_blob_key),
    responseBlobKey: text(row.response_blob_key),
    selectorOutputBlobKey: text(row.selector_output_blob_key),
    requestBlobFormat: text(row.request_blob_format),
    leaseTurns: /^\d+$/.test(String(row.lease_turns)) && Number(row.lease_turns) > 0 ? Number(row.lease_turns) : null,
  };
}

/** The rows matching a condition, oldest first. */
export async function loadRecords(db: ActivityDb, condition: Sql): Promise<ConversationRecord[]> {
  const rows = await db.all(sql`
    select ${recordColumns(db)}
    from routing_requests r
    where ${condition}
    order by r.received_at, r.id`);
  return rows.map((row) => readRecord(db, row));
}

/** The row with this ID, or the organization's row with this gateway request ID. */
export async function findRecord(db: ActivityDb, ref: string, organizationId?: string): Promise<ConversationRecord | null> {
  const byId = await db.all(sql`
    select ${recordColumns(db)}
    from routing_requests r
    where r.id = ${ref}`);
  if (byId.length > 0) return readRecord(db, byId[0]!);
  if (organizationId === undefined) return null;
  const byRequest = await db.all(sql`
    select ${recordColumns(db)}
    from routing_requests r
    where r.organization_id = ${organizationId}
      and r.request_id = ${ref}
    limit 1`);
  return byRequest.length > 0 ? readRecord(db, byRequest[0]!) : null;
}

/** A row of the organization with a protocol Activity reads. */
export function supported(record: ConversationRecord | null, organizationId: string): record is ConversationRecord {
  return record !== null && record.organizationId === organizationId && record.sourceProtocol !== null
    && (SUPPORTED_SOURCE_PROTOCOLS as readonly string[]).includes(record.sourceProtocol);
}

/** Python's `a or b or ...` over optional strings. */
export function firstTruthy(...values: Array<string | null | undefined>): string {
  return values.find((value) => value) ?? "";
}

export type GroupKey = {
  sourceProtocol: string;
  conversationKey: string;
  routerId: string | null;
  apiKeyId: string | null;
  attributedUserId: string | null;
};

export function groupKeyText(key: GroupKey): string {
  return JSON.stringify([key.sourceProtocol, key.conversationKey, key.routerId, key.apiKeyId, key.attributedUserId]);
}

export function recordKey(record: ConversationRecord): GroupKey {
  return {
    sourceProtocol: record.sourceProtocol!,
    conversationKey: firstTruthy(record.agentSessionId, record.conversationId, record.id),
    routerId: record.routerId,
    apiKeyId: record.apiKeyId,
    attributedUserId: record.attributedUserId,
  };
}

/** The record's context run: its conversation ID, or its own row ID. */
export function contextRun(record: ConversationRecord): string {
  return firstTruthy(record.conversationId, record.id);
}

/** The steps of any of the conversations, in any time range. */
export function groupsCondition(keys: readonly GroupKey[]): Sql {
  const equal = (column: Sql, value: string | null) =>
    value === null ? sql`${column} is null` : sql`${column} = ${value}`;
  return or(keys.map((key) => sql`
    r.source_protocol = ${key.sourceProtocol}
    and ${AGENT_SESSION_KEY} = ${key.conversationKey}
    and ${equal(sql`r.router_id`, key.routerId)}
    and ${equal(sql`r.api_key_id`, key.apiKeyId)}
    and ${equal(sql`r.attributed_user_id`, key.attributedUserId)}`));
}

/** Each conversation's latest non-empty title, from steps in any time range. */
export async function conversationTitles(db: ActivityDb, organizationId: string, keys: readonly GroupKey[]): Promise<Map<string, string>> {
  const records = await loadRecords(db, sql`
    r.organization_id = ${organizationId}
    and r.conversation_title is not null
    and ${groupsCondition(keys)}`);
  const titles = new Map<string, string>();
  for (const record of records) {
    if (record.conversationTitle) titles.set(groupKeyText(recordKey(record)), record.conversationTitle);
  }
  return titles;
}

export type Entities = {
  routers: Map<string, { name: string; zdr: boolean }>;
  keys: Map<string, { label: string; keyPrefix: string }>;
  users: Map<string, { displayName: string | null; email: string }>;
};

/** The routers, API keys, and people the steps name, deleted ones included. */
export async function loadEntities(db: ActivityDb, records: readonly ConversationRecord[]): Promise<Entities> {
  const ids = (pick: (record: ConversationRecord) => string | null) =>
    [...new Set(records.map(pick).filter((id): id is string => Boolean(id)))];
  const entities: Entities = { routers: new Map(), keys: new Map(), users: new Map() };
  const routers = await db.all(sql`select id, name, zdr from model_routers where id in (${ids((r) => r.routerId)})`);
  for (const row of routers) {
    entities.routers.set(String(row.id), { name: String(row.name), zdr: readBool(row.zdr) });
  }
  const keys = await db.all(sql`
    select id, label, key_prefix from organization_api_keys where id in (${ids((r) => r.apiKeyId)})`);
  for (const row of keys) {
    entities.keys.set(String(row.id), { label: String(row.label), keyPrefix: String(row.key_prefix) });
  }
  const users = await db.all(sql`
    select id, display_name, email from users where id in (${ids((r) => r.attributedUserId)})`);
  for (const row of users) {
    entities.users.set(String(row.id), { displayName: readOptionalString(row.display_name), email: String(row.email) });
  }
  return entities;
}

/** Python's `format(Decimal, "f")`. */
export function fixedDecimal(value: Decimal): string {
  if (value.exponent >= 0) return (value.coefficient * 10n ** BigInt(value.exponent)).toString();
  const negative = value.coefficient < 0n;
  const digits = (negative ? -value.coefficient : value.coefficient).toString().padStart(-value.exponent + 1, "0");
  const point = digits.length + value.exponent;
  return `${negative ? "-" : ""}${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function optionalFixed(value: string | number | null): string | null {
  return value === null ? null : fixedDecimal(parseDecimal(value));
}

/** The values without nulls or immediate repeats. */
export function consecutivePath(values: ReadonlyArray<string | null>): string[] {
  const path: string[] = [];
  for (const value of values) {
    if (value !== null && path.at(-1) !== value) path.push(value);
  }
  return path;
}

export function decisionDetails(record: ConversationRecord): Record<string, unknown> | null {
  const details = record.decisionDetails;
  return details !== null && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : null;
}

export function selectedEffort(record: ConversationRecord): ReasoningEffort | null {
  return thinkingLevelValue(decisionDetails(record)?.selected_reasoning_effort);
}

/** The conversation summary over its steps, oldest first. */
export function conversationSummary(
  records: readonly ConversationRecord[],
  entities: Entities,
  title: string | undefined,
  switches: number | null,
) {
  const first = records[0]!;
  const last = records.at(-1)!;
  const router = first.routerId === null ? undefined : entities.routers.get(first.routerId);
  const key = first.apiKeyId === null ? undefined : entities.keys.get(first.apiKeyId);
  const user = first.attributedUserId === null ? undefined : entities.users.get(first.attributedUserId);
  const runs = new Set<string>();
  let messagesSent = 0;
  let totalTokens = 0;
  let spend: Decimal | null = null;
  let priced = 0;
  let unpriced = 0;
  let hasError = false;
  let hasAborted = false;
  let allZdr = true;
  let anyZdr = false;
  for (const record of records) {
    runs.add(contextRun(record));
    if (record.requestKind === "user_message") messagesSent += 1;
    totalTokens += record.providerTotalTokens ?? 0;
    if (record.providerTotalCostUsd !== null) {
      spend = addDecimals(spend ?? { coefficient: 0n, exponent: 0 }, parseDecimal(record.providerTotalCostUsd));
    }
    if (record.providerPricingKnown !== null && record.selectedModel !== null && record.selectedProvider !== null) {
      if (record.providerPricingKnown) priced += 1;
      else unpriced += 1;
    }
    if (record.status === "provider_error" || record.status === "selector_error") hasError = true;
    if (record.status === "aborted") hasAborted = true;
    allZdr &&= record.zdr;
    anyZdr ||= record.zdr;
  }
  return {
    conversation_ref: first.id,
    conversation_id: first.conversationId || null,
    agent_session_id: first.agentSessionId || null,
    context_runs: runs.size,
    source_protocol: first.sourceProtocol,
    title: title || ([...records].reverse().find((record) => record.conversationTitle)?.conversationTitle ?? null),
    router_id: first.routerId,
    router_name: router?.name ?? null,
    api_key_id: first.apiKeyId,
    api_key_label: key?.label ?? null,
    api_key_prefix: key?.keyPrefix ?? null,
    attributed_user_id: first.attributedUserId,
    attributed_user_name: user === undefined ? null : user.displayName || user.email,
    attributed_user_email: user?.email ?? null,
    first_at: formatInstant(first.receivedAt),
    last_at: formatInstant(last.receivedAt),
    messages_sent: messagesSent,
    model_steps: records.length,
    model_switches: switches ?? contextRunSwitches(records),
    model_path: consecutivePath(records.map((record) => record.selectedModel)),
    provider_path: consecutivePath(records.map((record) => record.selectedProvider)),
    provider_total_tokens: totalTokens,
    provider_spend_usd: spend === null ? null : fixedDecimal(spend),
    priced_model_steps: priced,
    unpriced_model_steps: unpriced,
    has_error: hasError,
    has_aborted: hasAborted,
    terminal_status: last.status,
    retention: router?.zdr || allZdr ? "zdr" : anyZdr ? "mixed" : "retained",
  };
}

/** Model changes within each context run. */
function contextRunSwitches(records: readonly ConversationRecord[]): number {
  const paths = new Map<string, Array<string | null>>();
  for (const record of records) {
    const run = contextRun(record);
    paths.set(run, [...(paths.get(run) ?? []), record.selectedModel]);
  }
  let switches = 0;
  for (const models of paths.values()) switches += Math.max(0, consecutivePath(models).length - 1);
  return switches;
}

/** Python's `repr` of a string. */
export function pyRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (character === "\\" || character === quote) out += `\\${character}`;
    else if (character === "\n") out += "\\n";
    else if (character === "\r") out += "\\r";
    else if (character === "\t") out += "\\t";
    else if (code < 0x20 || (code >= 0x7f && code < 0xa0)) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += character;
  }
  return out + quote;
}

const REQUEST_BLOB_FORMATS = ["chat_projection_v1", "interaction_request_v1"];

/** The stored request format; a row with an unknown one is inconsistent. */
export function requestBlobFormat(record: ConversationRecord): string | null {
  if (record.requestBlobKey === null) return null;
  const format = record.requestBlobFormat;
  if (format === null || !REQUEST_BLOB_FORMATS.includes(format)) {
    throw new Error(`Routing request ${pyRepr(record.id)} has unsupported request blob format ${format === null ? "None" : pyRepr(format)}.`);
  }
  return format;
}
