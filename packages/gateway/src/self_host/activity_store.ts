/**
 * The self-hosted gateway's Activity: each served request's log row in the
 * gateway's SQLite database, in the same tables and columns hosted Dari keeps
 * in Postgres, so the gateway's Activity reads (`../activity/`) serve both.
 *
 * Routers come from the config file and API keys are the gateway keys; both
 * are mirrored into the tables Activity joins for their names. There are no
 * people. Retained request and response bodies live in their own table, and
 * nothing is retained for a ZDR router.
 */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { SessionGitEvents } from "../activity/http.js";
import { sqliteActivityDb, type ActivityDb } from "../activity/sql.js";
import { canonicalInstant, instantFromDate } from "../activity/values.js";

const MODEL_NAME_MAX_CHARS = 240;
const CONVERSATION_ID_MAX_CHARS = 64;
const ERROR_MESSAGE_MAX_CHARS = 2000;
const ERROR_CODE_MAX_CHARS = 120;
const REASON_MAX_CHARS = 2000;
const JSON_COLUMN_MAX_BYTES = 64 * 1024;
// The blob "bucket" every retained body is filed under.
export const SELF_HOSTED_BLOB_BUCKET = "gateway";

const SCHEMA = `
create table if not exists routing_requests (
  id text primary key,
  organization_id text,
  router_id text,
  api_key_id text,
  attributed_user_id text,
  request_id text not null unique,
  billing_terminal_outcome text,
  billing_provider_attempts text,
  client_request_id text,
  source_protocol text,
  request_kind text,
  conversation_id text,
  agent_session_id text,
  conversation_title text,
  prefix_match_depth integer,
  prefix_warm_tokens integer,
  prefix_hash text,
  stream integer not null,
  zdr integer not null default 0,
  status text not null,
  error_code text,
  error_message text,
  message_count integer not null,
  has_tools integer not null,
  instructions_present integer not null default 0,
  request_metadata text,
  selected_model text,
  model_switched integer not null default 0,
  selected_provider text,
  provider_key_source text,
  blob_bucket text,
  request_blob_key text,
  request_blob_format text,
  response_blob_key text,
  selector_prompt_blob_key text,
  selector_output_blob_key text,
  selector_model text,
  selector_candidate_models text,
  selector_evals text,
  selector_cost_estimates text,
  selector_previous_model text,
  selector_reason text,
  selector_input_tokens integer,
  selector_cache_read_tokens integer,
  selector_cache_write_tokens integer,
  selector_output_tokens integer,
  selector_input_cost_usd numeric,
  selector_cache_read_cost_usd numeric,
  selector_cache_write_cost_usd numeric,
  selector_output_cost_usd numeric,
  selector_total_cost_usd numeric,
  selector_pricing_known integer,
  decision_details text,
  provider_stop_reason text,
  provider_input_tokens integer,
  provider_cache_read_tokens integer,
  provider_cache_write_tokens integer,
  provider_output_tokens integer,
  provider_total_tokens integer,
  provider_input_cost_usd numeric,
  provider_cache_read_cost_usd numeric,
  provider_cache_write_cost_usd numeric,
  provider_output_cost_usd numeric,
  provider_total_cost_usd numeric,
  provider_pricing_known integer,
  benchmark_replay_cost_usd numeric,
  benchmark_replay_raw_cost_usd numeric,
  benchmark_model_id text,
  benchmark_estimator_version text,
  benchmark_input_rate_usd_per_mtok numeric,
  benchmark_cached_input_rate_usd_per_mtok numeric,
  benchmark_cache_write_rate_usd_per_mtok numeric,
  benchmark_output_rate_usd_per_mtok numeric,
  selector_latency_ms integer,
  provider_latency_ms integer,
  total_latency_ms integer,
  received_at text not null,
  completed_at text,
  created_at text not null,
  metadata_json text
);
create index if not exists ix_routing_requests_organization_protocol_received_at
  on routing_requests (organization_id, source_protocol, received_at);
create index if not exists ix_routing_requests_conversation_id on routing_requests (conversation_id);
create index if not exists ix_routing_requests_agent_session_id on routing_requests (agent_session_id);
create table if not exists routing_tool_skill_events (
  id text primary key,
  routing_request_id text not null references routing_requests (id) on delete cascade,
  event_type text not null,
  tool_call_id text,
  exchange_context_hash text,
  capability_id text not null,
  observed_name text not null,
  skill_version text,
  evidence_source text not null,
  ordinal integer not null,
  unique (routing_request_id, ordinal)
);
create index if not exists ix_routing_tool_skill_events_routing_request_id
  on routing_tool_skill_events (routing_request_id);
create index if not exists ix_routing_tool_skill_events_exchange_context_call
  on routing_tool_skill_events (exchange_context_hash, tool_call_id);
create table if not exists routing_tool_result_observations (
  id text primary key,
  routing_request_id text not null references routing_requests (id) on delete cascade,
  tool_call_id text not null,
  exchange_context_hash text,
  ordinal integer not null,
  unique (routing_request_id, ordinal)
);
create index if not exists ix_routing_tool_result_observations_routing_request_id
  on routing_tool_result_observations (routing_request_id);
create index if not exists ix_routing_tool_result_observations_exchange_context_call
  on routing_tool_result_observations (exchange_context_hash, tool_call_id);
create table if not exists routing_request_blobs (
  object_key text primary key,
  body text not null
);
create table if not exists model_routers (
  id text primary key,
  organization_id text not null,
  name text not null,
  zdr integer not null default 0,
  deleted_at text
);
create table if not exists model_router_enabled_models (
  router_id text not null,
  model_id text not null,
  provider text not null,
  row_index integer not null,
  fast_mode integer not null default 0,
  primary key (router_id, model_id)
);
create table if not exists organization_api_keys (
  id text primary key,
  organization_id text not null,
  label text not null,
  key_prefix text not null,
  created_for_user_id text,
  attributed_to_user_id text,
  expires_at text,
  revoked_at text
);
create table if not exists users (
  id text primary key,
  email text not null,
  display_name text
);
create table if not exists routing_git_events (
  id text primary key,
  organization_id text not null,
  routing_request_id text references routing_requests (id) on delete cascade,
  source_protocol text not null,
  agent_session_id text not null,
  occurred_at text not null,
  ordinal integer not null,
  kind text not null,
  repository text not null,
  number integer,
  title text,
  branch text,
  commit_sha text
);
create index if not exists ix_routing_git_events_organization_session on routing_git_events (organization_id, agent_session_id);
create index if not exists ix_routing_git_events_organization_repository on routing_git_events (organization_id, repository);
create index if not exists ix_routing_git_events_routing_request_id on routing_git_events (routing_request_id);
`;

type Row = Record<string, unknown>;

export class ActivityStore {
  /** The database the gateway's Activity reads query. */
  readonly reads: ActivityDb;

  constructor(private readonly db: Database) {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
    this.reads = sqliteActivityDb(db);
  }

  /**
   * Mirror the configured routers and the gateway keys into the tables
   * Activity reads names from. Routers removed from the config keep their
   * name, marked deleted, so their past traffic still reads well.
   */
  syncDirectory(
    organizationId: string,
    routers: ReadonlyArray<{ id: string; zdr: boolean }>,
    gatewayKeyCount: number,
  ): void {
    this.db.transaction(() => {
      const now = canonicalInstant(instantFromDate(new Date()));
      this.db.query("update model_routers set deleted_at = coalesce(deleted_at, ?) where organization_id = ?")
        .run(now, organizationId);
      for (const router of routers) {
        this.db.query(
          `insert into model_routers (id, organization_id, name, zdr, deleted_at) values (?, ?, ?, ?, null)
           on conflict (id) do update set name = excluded.name, zdr = excluded.zdr, deleted_at = null`,
        ).run(router.id, organizationId, router.id, router.zdr ? 1 : 0);
      }
      for (let index = 1; index <= gatewayKeyCount; index += 1) {
        this.db.query(
          `insert into organization_api_keys (id, organization_id, label, key_prefix) values (?, ?, ?, ?)
           on conflict (id) do update set label = excluded.label, key_prefix = excluded.key_prefix`,
        ).run(`gateway_key_${index}`, organizationId, `Gateway key ${index}`, `key ${index}`);
      }
    })();
  }

  /** Store one served request's report: its row, tool events, and bodies. */
  record(report: Row): void {
    const requestId = text(report.request_id);
    if (requestId === null) return;
    const zdr = report.zdr === true;
    const id = `rreq_${randomUUID().replaceAll("-", "")}`;
    const organizationId = text(report.organization_id) ?? "";
    const selector = record(report.selector);
    const call = record(report.provider_call);
    const selectorUsage = record(selector?.usage);
    const callUsage = record(call?.usage);
    const bodies: Record<string, string | null> = zdr
      ? { client_request: null, client_response: null, selector_prompt: null, selector_output: null }
      : {
          client_request: text(report.client_request_json),
          client_response: text(report.client_response_json),
          selector_prompt: text(selector?.prompt_json),
          selector_output: text(selector?.output_text),
        };
    const keys = Object.fromEntries(
      Object.entries(bodies).map(([kind, body]) => [kind, body === null ? null : `routing/${organizationId}/${id}/${kind}.json`]),
    );
    const wroteBodies = Object.values(keys).some((key) => key !== null);
    const model = clip(report.selected_model, MODEL_NAME_MAX_CHARS);
    const conversationId = clip(report.conversation_id, CONVERSATION_ID_MAX_CHARS);
    const receivedAt = instant(report.received_at) ?? canonicalInstant(instantFromDate(new Date()));
    const row: Row = {
      id,
      organization_id: organizationId,
      router_id: text(report.router_id),
      api_key_id: text(report.api_key_id),
      attributed_user_id: text(report.attributed_user_id),
      request_id: requestId,
      billing_terminal_outcome: text(report.billing_terminal_outcome),
      billing_provider_attempts: json(report.billing_provider_attempts),
      client_request_id: text(report.client_request_id),
      source_protocol: text(report.source_protocol),
      request_kind: text(report.request_kind),
      conversation_id: conversationId,
      agent_session_id: clip(report.agent_session_id, CONVERSATION_ID_MAX_CHARS),
      prefix_match_depth: int(report.prefix_match_depth),
      prefix_warm_tokens: int(report.prefix_warm_tokens),
      prefix_hash: text(record(report.prefix_entry)?.prefix_hash),
      stream: report.stream === true ? 1 : 0,
      zdr: zdr ? 1 : 0,
      status: text(report.status) ?? "completed",
      error_code: clip(report.error_code, ERROR_CODE_MAX_CHARS),
      error_message: zdr ? null : clip(report.error_message, ERROR_MESSAGE_MAX_CHARS),
      message_count: int(report.message_count) ?? 0,
      has_tools: report.has_tools === true ? 1 : 0,
      request_metadata: json(report.request_metadata),
      selected_model: model,
      model_switched: this.modelSwitched(report, model, conversationId, receivedAt) ? 1 : 0,
      selected_provider: text(report.selected_provider),
      provider_key_source: text(report.provider_key_source),
      blob_bucket: wroteBodies ? SELF_HOSTED_BLOB_BUCKET : null,
      request_blob_key: keys.client_request,
      request_blob_format: keys.client_request === null ? null : text(report.client_request_format),
      response_blob_key: keys.client_response,
      selector_prompt_blob_key: keys.selector_prompt,
      selector_output_blob_key: keys.selector_output,
      selector_model: selector === null ? null : clip(selector.selector_model, MODEL_NAME_MAX_CHARS),
      selector_candidate_models: selector === null ? null : json(selector.candidate_models),
      selector_evals: selector === null
        ? null
        : json((Array.isArray(selector.evals) ? selector.evals : []).map((entry) => ({
            id: record(entry)?.id ?? null,
            name: record(entry)?.name ?? null,
          }))),
      selector_cost_estimates: selector === null ? null : json(selector.cost_estimates),
      selector_previous_model: selector === null ? null : clip(selector.previous_model, MODEL_NAME_MAX_CHARS),
      selector_reason: selector === null || zdr ? null : clip(selector.reason, REASON_MAX_CHARS),
      ...usageColumns("selector", selectorUsage),
      decision_details: json(report.decision_details),
      provider_stop_reason: text(call?.stop_reason),
      ...usageColumns("provider", callUsage),
      provider_total_tokens: int(callUsage?.total_tokens),
      benchmark_replay_cost_usd: decimal(report.benchmark_replay_cost_usd),
      benchmark_replay_raw_cost_usd: decimal(report.benchmark_replay_raw_cost_usd),
      benchmark_model_id: text(report.benchmark_model_id),
      benchmark_estimator_version: text(report.benchmark_estimator_version),
      benchmark_input_rate_usd_per_mtok: decimal(report.benchmark_input_rate_usd_per_mtok),
      benchmark_cached_input_rate_usd_per_mtok: decimal(report.benchmark_cached_input_rate_usd_per_mtok),
      benchmark_cache_write_rate_usd_per_mtok: decimal(report.benchmark_cache_write_rate_usd_per_mtok),
      benchmark_output_rate_usd_per_mtok: decimal(report.benchmark_output_rate_usd_per_mtok),
      selector_latency_ms: int(report.selector_latency_ms),
      provider_latency_ms: int(report.provider_latency_ms),
      total_latency_ms: int(report.total_latency_ms),
      received_at: receivedAt,
      completed_at: instant(report.completed_at),
      created_at: canonicalInstant(instantFromDate(new Date())),
      metadata_json: json({ organization_id: organizationId, router_id: text(report.router_id), cost_source: "pi_registry" }),
    };
    const columns = Object.keys(row);
    this.db.transaction(() => {
      // A repeated report of the same request keeps the first.
      const inserted = this.db.query(
        `insert into routing_requests (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})
         on conflict (request_id) do nothing`,
      ).run(...(Object.values(row) as Array<string | number | null>));
      if (inserted.changes === 0) return;
      for (const [kind, body] of Object.entries(bodies)) {
        if (body !== null) this.db.query("insert into routing_request_blobs (object_key, body) values (?, ?)").run(keys[kind]!, body);
      }
      if (zdr) return;
      for (const event of list(report.tool_skill_events)) {
        this.db.query(
          `insert into routing_tool_skill_events
             (id, routing_request_id, event_type, tool_call_id, exchange_context_hash, capability_id, observed_name, skill_version, evidence_source, ordinal)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `rtse_${randomUUID().replaceAll("-", "")}`, id, text(event.event_type), text(event.tool_call_id),
          text(event.exchange_context_hash), text(event.capability_id), text(event.observed_name),
          text(event.skill_version), text(event.evidence_source), int(event.ordinal),
        );
      }
      for (const observation of list(report.tool_result_observations)) {
        this.db.query(
          `insert into routing_tool_result_observations (id, routing_request_id, tool_call_id, exchange_context_hash, ordinal)
           values (?, ?, ?, ?, ?)`,
        ).run(
          `rtro_${randomUUID().replaceAll("-", "")}`, id, text(observation.tool_call_id),
          text(observation.exchange_context_hash), int(observation.ordinal),
        );
      }
      const sessionId = text(row.agent_session_id);
      if (sessionId) this.insertGitEvents(organizationId, text(row.source_protocol), sessionId, id, receivedAt, list(report.git_events));
    })();
  }

  async saveSessionGitEvents(write: SessionGitEvents): Promise<void> {
    const known = new Set((this.db.query(
      `select commit_sha from routing_git_events
       where organization_id = ? and agent_session_id = ? and kind = 'commit'`,
    ).all(write.organizationId, write.agentSessionId) as Array<{ commit_sha: string }>).map((row) => row.commit_sha));
    this.insertGitEvents(
      write.organizationId, write.sourceProtocol, write.agentSessionId, null, canonicalInstant(instantFromDate(new Date())),
      write.events.filter((event) => !known.has(event.commit_sha)),
    );
  }

  /** Store a session's git events: what a step's tool output showed, or commits its git hook reported. */
  private insertGitEvents(
    organizationId: string, sourceProtocol: string | null, agentSessionId: string, routingRequestId: string | null,
    occurredAt: string, events: readonly unknown[],
  ): void {
    for (const event of events.map(record)) {
      if (event === null) continue;
      this.db.query(
        `insert into routing_git_events
           (id, organization_id, routing_request_id, source_protocol, agent_session_id, occurred_at, ordinal, kind, repository, number, title, branch, commit_sha)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `rge_${randomUUID().replaceAll("-", "")}`, organizationId, routingRequestId, sourceProtocol ?? "", agentSessionId, occurredAt,
        int(event.ordinal), text(event.kind), text(event.repository), int(event.number), text(event.title), text(event.branch),
        text(event.commit_sha),
      );
    }
  }

  /** A retained body, or null. */
  readBlob(key: string): string | null {
    const row = this.db.query("select body from routing_request_blobs where object_key = ?").get(key) as { body: string } | null;
    return row?.body ?? null;
  }

  // Whether this step's model differs from the latest earlier step's with a
  // model in the same context run: conversation, protocol, router, key, and
  // attributed user.
  private modelSwitched(report: Row, model: string | null, conversationId: string | null, receivedAt: string): boolean {
    if (model === null || !conversationId) return false;
    const previous = this.db.query(
      `select selected_model from routing_requests
       where organization_id = ? and conversation_id = ?
         and source_protocol is ? and router_id is ? and api_key_id is ? and attributed_user_id is ?
         and selected_model is not null and received_at <= ?
       order by received_at desc, id desc limit 1`,
    ).get(
      text(report.organization_id), conversationId, text(report.source_protocol), text(report.router_id),
      text(report.api_key_id), text(report.attributed_user_id), receivedAt,
    ) as { selected_model: string } | null;
    return previous !== null && previous.selected_model !== model;
  }
}

function usageColumns(prefix: "selector" | "provider", usage: Row | null): Row {
  return {
    [`${prefix}_input_tokens`]: int(usage?.input_tokens),
    [`${prefix}_cache_read_tokens`]: int(usage?.cache_read_tokens),
    [`${prefix}_cache_write_tokens`]: int(usage?.cache_write_tokens),
    [`${prefix}_output_tokens`]: int(usage?.output_tokens),
    [`${prefix}_input_cost_usd`]: decimal(usage?.input_cost_usd),
    [`${prefix}_cache_read_cost_usd`]: decimal(usage?.cache_read_cost_usd),
    [`${prefix}_cache_write_cost_usd`]: decimal(usage?.cache_write_cost_usd),
    [`${prefix}_output_cost_usd`]: decimal(usage?.output_cost_usd),
    [`${prefix}_total_cost_usd`]: decimal(usage?.total_cost_usd),
    [`${prefix}_pricing_known`]: usage === null || typeof usage.pricing_known !== "boolean" ? null : Number(usage.pricing_known),
  };
}

function record(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : null;
}

function list(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(record).filter((entry): entry is Row => entry !== null) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function clip(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function decimal(value: unknown): string | number | null {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : null;
}

function instant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : canonicalInstant(instantFromDate(date));
}

// A JSON column's text; over its size cap it holds a truncation marker.
function json(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const encoded = JSON.stringify(value);
  const size = Buffer.byteLength(encoded, "utf8");
  return size > JSON_COLUMN_MAX_BYTES ? JSON.stringify({ _truncated: true, size_bytes: size }) : encoded;
}
