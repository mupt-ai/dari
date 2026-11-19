/* The filters every Activity read takes, and the SQL conditions they become
   over `routing_requests`. */

import { badRequest, type Params } from "./params.js";
import { and, or, raw, sql, type ActivityDb, type Sql } from "./sql.js";
import { canonicalInstant, formatInstant, readInt, type Instant } from "./values.js";

/** The source protocols Activity reads, in display order. */
export const SUPPORTED_SOURCE_PROTOCOLS = ["openai_chat", "openai_responses", "anthropic_messages"] as const;
export type SourceProtocol = (typeof SUPPORTED_SOURCE_PROTOCOLS)[number];

/** Stands for the steps whose selector chose no model. */
export const SELECTOR_UNRESOLVED_MODEL = "selector-unresolved";

/** A step's model, under the alias `r`: `SELECTOR_UNRESOLVED_MODEL` when its selector chose none. */
export const MODEL = raw(`coalesce(r.selected_model, '${SELECTOR_UNRESOLVED_MODEL}')`);

export const REQUEST_STATUSES = ["completed", "provider_error", "selector_error", "aborted"] as const;
export const KEY_SOURCES = ["user", "managed", "subscription"] as const;

const MAX_RANGE_MICROS = 366 * 24 * 60 * 60 * 1_000_000;
const ALLOWED_BUCKET_SECONDS = new Set([
  60, 5 * 60, 15 * 60, 30 * 60, 60 * 60, 24 * 60 * 60, 7 * 24 * 60 * 60, 30 * 24 * 60 * 60,
]);

/** The filters as the query gave them, before validation. */
export type ActivityQuery = {
  from: { instant: Instant; naive: boolean };
  to: { instant: Instant; naive: boolean };
  routerId?: string;
  apiKeyIds: string[];
  userIds: string[];
  models: string[];
  provider?: string;
  status?: (typeof REQUEST_STATUSES)[number];
  keySource?: (typeof KEY_SOURCES)[number];
};

export function readActivityQuery(params: Params): ActivityQuery {
  return {
    from: params.instant("from"),
    to: params.instant("to"),
    routerId: params.string("router_id"),
    apiKeyIds: params.strings("api_key_id"),
    userIds: params.strings("user_id"),
    models: params.strings("model"),
    provider: params.string("provider"),
    status: params.literal("status", REQUEST_STATUSES),
    keySource: params.literal("key_source", KEY_SOURCES),
  };
}

/** `source_scope`: protocols, comma-separated, or `all` or `none`; absent is all. */
export function readSourceScope(params: Params): string | undefined {
  return params.string("source_scope", { maxLength: 128 });
}

export function sourceProtocols(scope: string | undefined): SourceProtocol[] {
  if (scope === undefined) return [...SUPPORTED_SOURCE_PROTOCOLS];
  const values = [...new Set(scope.split(",").map((part) => part.trim()).filter(Boolean))];
  if (values.length === 0) throw badRequest("Select at least one Activity source protocol.");
  if (values.includes("all")) {
    if (values.length !== 1) throw badRequest("Activity source scope 'all' cannot be combined with protocols.");
    return [...SUPPORTED_SOURCE_PROTOCOLS];
  }
  if (values.includes("none")) {
    if (values.length !== 1) throw badRequest("Activity source scope 'none' cannot be combined with protocols.");
    return [];
  }
  const unsupported = values.filter((value) => !(SUPPORTED_SOURCE_PROTOCOLS as readonly string[]).includes(value));
  if (unsupported.length > 0) {
    throw badRequest(`Unsupported Activity source protocol: ${unsupported.sort().join(", ")}.`);
  }
  return SUPPORTED_SOURCE_PROTOCOLS.filter((protocol) => values.includes(protocol));
}

/** Validated filters. `bucketSeconds` is 0 for reads without time buckets. */
export type ActivityFilters = {
  start: Instant;
  end: Instant;
  bucketSeconds: number;
  protocols: SourceProtocol[];
  routerId?: string;
  apiKeyIds: string[];
  userIds: string[];
  models: string[];
  provider?: string;
  status?: string;
  keySource?: string;
};

export function validatedRange(query: ActivityQuery): { start: Instant; end: Instant } {
  if (query.from.naive) throw badRequest("Activity 'from' must include a timezone offset.");
  if (query.to.naive) throw badRequest("Activity 'to' must include a timezone offset.");
  const start = query.from.instant;
  const end = query.to.instant;
  if (end <= start) throw badRequest("Activity 'to' must be later than 'from'.");
  if (end - start > MAX_RANGE_MICROS) throw badRequest("Activity ranges cannot exceed 366 days.");
  return { start, end };
}

/** The range and dimensions, for reads without time buckets. */
export function validatedFilters(query: ActivityQuery, protocols: SourceProtocol[]): ActivityFilters {
  const { start, end } = validatedRange(query);
  return {
    start,
    end,
    bucketSeconds: 0,
    protocols,
    routerId: query.routerId,
    apiKeyIds: [...new Set(query.apiKeyIds)],
    userIds: [...new Set(query.userIds)],
    models: [...new Set(query.models)],
    provider: query.provider,
    status: query.status,
    keySource: query.keySource,
  };
}

/** The range, dimensions, and a bucket size giving at most 1,000 buckets. */
export function validatedBucketFilters(
  query: ActivityQuery,
  protocols: SourceProtocol[],
  bucketSeconds: number,
): ActivityFilters {
  const filters = validatedFilters(query, protocols);
  if (!ALLOWED_BUCKET_SECONDS.has(bucketSeconds)) throw badRequest("Unsupported activity bucket size.");
  if ((filters.end - filters.start) / 1_000_000 / bucketSeconds > 1000) {
    throw badRequest("Activity range contains too many time buckets.");
  }
  return { ...filters, bucketSeconds };
}

/** A timestamp value to compare a timestamp column with. */
function timestamp(db: ActivityDb, instant: Instant): Sql {
  const text = canonicalInstant(instant);
  return db.dialect === "postgres" ? sql`${text}::timestamptz` : sql`${text}`;
}

/* The conditions below filter `routing_requests` under the alias `r`, or the
   alias a query gave the table. Each is safe to follow with `and`. */

/** Received in the filters' time range. */
export function timeRange(db: ActivityDb, filters: ActivityFilters, alias = "r"): Sql {
  const r = raw(alias);
  return sql`${r}.received_at >= ${timestamp(db, filters.start)} and ${r}.received_at < ${timestamp(db, filters.end)}`;
}

/** The organization, time range, and source protocols. */
export function baseCriteria(db: ActivityDb, organizationId: string, filters: ActivityFilters): Sql {
  return sql`r.organization_id = ${organizationId}
    and ${timeRange(db, filters)}
    and r.source_protocol in (${filters.protocols})`;
}

/** Router and identity: API keys or attributed people. Empty values filter nothing. */
export function identityCriteria(filters: ActivityFilters, alias = "r"): Sql {
  const r = raw(alias);
  const conditions: Sql[] = [];
  if (filters.routerId) conditions.push(sql`${r}.router_id = ${filters.routerId}`);
  const identity: Sql[] = [];
  if (filters.apiKeyIds.length > 0) identity.push(sql`${r}.api_key_id in (${filters.apiKeyIds})`);
  if (filters.userIds.length > 0) identity.push(sql`${r}.attributed_user_id in (${filters.userIds})`);
  if (identity.length > 0) conditions.push(or(identity));
  return and(conditions);
}

/** Model, provider, status, and key source. */
export function routeCriteria(filters: ActivityFilters, alias = "r"): Sql {
  const r = raw(alias);
  const conditions: Sql[] = [];
  if (filters.models.length > 0) {
    const ids = filters.models.filter((model) => model !== SELECTOR_UNRESOLVED_MODEL);
    const models: Sql[] = [];
    if (ids.length > 0) models.push(sql`${r}.selected_model in (${ids})`);
    if (filters.models.includes(SELECTOR_UNRESOLVED_MODEL)) models.push(sql`${r}.selected_model is null`);
    conditions.push(or(models));
  }
  if (filters.provider) conditions.push(sql`${r}.selected_provider = ${filters.provider}`);
  if (filters.status) conditions.push(sql`${r}.status = ${filters.status}`);
  if (filters.keySource) conditions.push(sql`${r}.provider_key_source = ${filters.keySource}`);
  return and(conditions);
}

export function dimensionCriteria(filters: ActivityFilters, alias = "r"): Sql {
  return sql`${identityCriteria(filters, alias)} and ${routeCriteria(filters, alias)}`;
}

/** Base and dimension criteria: what most reads filter by. */
export function criteria(db: ActivityDb, organizationId: string, filters: ActivityFilters): Sql {
  return sql`(${baseCriteria(db, organizationId, filters)} and ${dimensionCriteria(filters)})`;
}

/** The zero-based time bucket of a request row. */
export function bucketIndex(db: ActivityDb, filters: ActivityFilters): Sql {
  const start = timestamp(db, filters.start);
  const seconds = db.dialect === "postgres"
    ? sql`extract(epoch from (r.received_at - ${start}))`
    : sql`(unixepoch(r.received_at, 'subsec') - unixepoch(${start}, 'subsec'))`;
  return sql`floor(${seconds} / ${filters.bucketSeconds})`;
}

/** The start of a time bucket, as the API writes it. */
export function bucketStart(filters: ActivityFilters, index: unknown): string {
  return formatInstant(filters.start + readInt(index) * filters.bucketSeconds * 1_000_000);
}
