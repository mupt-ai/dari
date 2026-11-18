/* Tool and skill Activity: aggregates over `routing_tool_skill_events`, the
   named tool calls, skill uses, and skill file reads found in routed
   requests. Tools group by capability ID, skills by observed name. */

import { bucketIndex, bucketStart, criteria, type ActivityFilters } from "./filters.js";
import { likePattern, raw, sql, type ActivityDb, type Sql } from "./sql.js";
import { formatInstant, readInstant, readInt, type Instant } from "./values.js";
import {
  loadDetailIdentities,
  loadItemIdentities,
  topIdentity,
  type TopIdentity,
} from "./tool_skill_identities.js";

export type ToolSkillMode = "tools" | "skills";
export type SeriesMetric = "uses" | "file_reads" | "activity";

const MAX_ACTIVITY_ITEMS = 1000;
const DEFAULT_SERIES_COUNT = 5;
export const MAX_SELECTED_SERIES = 10;
const DEFAULT_SERIES_COVERAGE_PERCENT = 90;

/** The events, joined to their requests and filtered, for one mode. */
export type Scope = { db: ActivityDb; organizationId: string; filters: ActivityFilters; mode: ToolSkillMode };

/* Every query here reads `routing_tool_skill_events e` joined to its request
   `routing_requests r`, filtered by `scopeCriteria`. */

/** What an event counts toward: a tool's capability ID, a skill's observed name. */
export function itemColumn(mode: ToolSkillMode): Sql {
  return mode === "tools" ? sql`e.capability_id` : sql`e.observed_name`;
}

export function usesCount(mode: ToolSkillMode): Sql {
  return mode === "tools"
    ? sql`count(*) filter (where e.event_type = 'tool_call')`
    : sql`count(*) filter (where e.event_type = 'skill_use')`;
}

export const FILE_READS = sql`count(*) filter (where e.event_type = 'skill_load')`;

/** The scope's events: its mode's event types, on requests passing the filters. */
export function scopeCriteria(scope: Scope): Sql {
  const types = scope.mode === "tools"
    ? sql`e.event_type = 'tool_call'`
    : sql`e.event_type in ('skill_use', 'skill_load')`;
  return sql`${criteria(scope.db, scope.organizationId, scope.filters)} and ${types}`;
}

type ItemRow = { capability_id: string; observed_name: string; uses: number; file_reads: number; latest_at: Instant };

/** One row per item among the events matching `where`. */
function itemRows(mode: ToolSkillMode, where: Sql): Sql {
  return sql`
    select
      ${itemColumn(mode)} as capability_id,
      max(e.observed_name) as observed_name,
      ${usesCount(mode)} as uses,
      ${FILE_READS} as file_reads,
      cast(max(r.received_at) as text) as latest_at
    from routing_tool_skill_events e
    join routing_requests r on r.id = e.routing_request_id
    where ${where}
    group by ${itemColumn(mode)}`;
}

function readItemRow(row: Record<string, unknown>): ItemRow {
  return {
    capability_id: String(row.capability_id),
    observed_name: String(row.observed_name),
    uses: readInt(row.uses),
    file_reads: readInt(row.file_reads),
    latest_at: readInstant(row.latest_at),
  };
}

function itemBody(row: ItemRow, identities: readonly TopIdentity[]) {
  return {
    capability_id: row.capability_id,
    observed_name: row.observed_name,
    uses: row.uses,
    file_reads: row.file_reads,
    identity_count: identities.length,
    top_identity: identities[0] ?? null,
    latest_at: formatInstant(row.latest_at),
  };
}

async function items(scope: Scope, rows: ItemRow[]) {
  const identities = await loadItemIdentities(scope, rows.map((row) => row.capability_id));
  return rows.map((row) => itemBody(row, identities.get(row.capability_id) ?? []));
}

function metricValue(item: { uses: number; file_reads: number }, metric: SeriesMetric): number {
  if (metric === "uses") return item.uses;
  if (metric === "file_reads") return item.file_reads;
  return item.uses + item.file_reads;
}

export async function toolSkillActivity(scope: Scope, metric: SeriesMetric, seriesIds: string[]) {
  const { db, filters, mode } = scope;
  const where = scopeCriteria(scope);
  const item = itemColumn(mode);
  const uses = usesCount(mode);
  const [totals] = await db.all(sql`
    select
      ${uses} as total_uses,
      ${FILE_READS} as total_file_reads,
      count(distinct ${item}) as total_items
    from routing_tool_skill_events e
    join routing_requests r on r.id = e.routing_request_id
    where ${where}`);
  const totalUses = readInt(totals?.total_uses);
  const totalFileReads = readInt(totals?.total_file_reads);
  const totalItems = readInt(totals?.total_items);

  const [primary, secondary] = metric === "uses"
    ? [uses, FILE_READS]
    : metric === "file_reads" ? [FILE_READS, uses] : [sql`(${uses} + ${FILE_READS})`, uses];
  const rows = (await db.all(sql`
    ${itemRows(mode, where)}
    order by ${primary} desc, ${secondary} desc, max(e.observed_name), ${item}
    limit ${MAX_ACTIVITY_ITEMS}`)).map(readItemRow);
  const itemBodies = await items(scope, rows);

  let selected: string[];
  if (seriesIds.length > 0) {
    const known = new Set(rows.map((row) => row.capability_id));
    selected = seriesIds.filter((id) => known.has(id));
  } else {
    // The top items until they cover 90% of the metric: at least five, at most ten.
    const total = metric === "uses" ? totalUses : metric === "file_reads" ? totalFileReads : totalUses + totalFileReads;
    const minimum = Math.min(DEFAULT_SERIES_COUNT, rows.length);
    selected = [];
    let covered = 0;
    for (const row of rows.slice(0, MAX_SELECTED_SERIES)) {
      selected.push(row.capability_id);
      covered += metricValue(row, metric);
      if (selected.length < minimum) continue;
      if (covered * 100 >= total * DEFAULT_SERIES_COVERAGE_PERCENT) break;
    }
  }
  const names = new Map(rows.map((row) => [row.capability_id, row.observed_name]));
  // Positional grouping: the bucket expression binds a value, and Postgres
  // does not match two bound copies of it.
  const aggregate = await db.all(sql`
    select
      ${bucketIndex(db, filters)} as bucket_index,
      ${uses} as uses,
      ${FILE_READS} as file_reads
    from routing_tool_skill_events e
    join routing_requests r on r.id = e.routing_request_id
    where ${where}
    group by 1
    order by 1`);
  return {
    from_at: formatInstant(filters.start),
    to_at: formatInstant(filters.end),
    bucket_seconds: filters.bucketSeconds,
    mode,
    total_uses: totalUses,
    total_file_reads: totalFileReads,
    total_items: totalItems,
    items_truncated: totalItems > rows.length,
    items: itemBodies,
    series: await loadSeries(scope, selected, names),
    aggregate_series: aggregate.map((row) => ({
      bucket_start: bucketStart(filters, row.bucket_index),
      uses: readInt(row.uses),
      file_reads: readInt(row.file_reads),
    })),
    selected_series_ids: selected,
  };
}

async function loadSeries(scope: Scope, ids: string[], names: Map<string, string>) {
  if (ids.length === 0) return [];
  const item = itemColumn(scope.mode);
  const rows = await scope.db.all(sql`
    select
      ${bucketIndex(scope.db, scope.filters)} as bucket_index,
      ${item} as capability_id,
      ${usesCount(scope.mode)} as uses,
      ${FILE_READS} as file_reads
    from routing_tool_skill_events e
    join routing_requests r on r.id = e.routing_request_id
    where ${scopeCriteria(scope)}
      and ${item} in (${ids})
    group by 1, 2
    order by 1, 2`);
  return rows.map((row) => {
    const id = String(row.capability_id);
    return {
      bucket_start: bucketStart(scope.filters, row.bucket_index),
      capability_id: id,
      observed_name: names.get(id) ?? id,
      uses: readInt(row.uses),
      file_reads: readInt(row.file_reads),
    };
  });
}

/** One item's detail; null when it has no activity under the filters. */
export async function toolSkillDetail(scope: Scope, capabilityId: string) {
  const { db, filters, mode } = scope;
  const where = sql`${scopeCriteria(scope)} and ${itemColumn(mode)} = ${capabilityId}`;
  const [found] = await db.all(itemRows(mode, where));
  if (found === undefined) return null;
  const row = { ...readItemRow(found), capability_id: capabilityId };
  const identities = await loadDetailIdentities(scope, capabilityId);
  const uses = usesCount(mode);

  const versionRows = mode !== "skills" ? [] : await db.all(sql`
    select
      e.skill_version,
      ${uses} as uses,
      ${FILE_READS} as file_reads,
      cast(max(r.received_at) as text) as latest_at
    from routing_tool_skill_events e
    join routing_requests r on r.id = e.routing_request_id
    where ${where}
    group by e.skill_version
    order by max(r.received_at) desc`);
  const sourceRows = await db.all(sql`
    select
      e.evidence_source,
      ${uses} as uses,
      ${FILE_READS} as file_reads
    from routing_tool_skill_events e
    join routing_requests r on r.id = e.routing_request_id
    where ${where}
    group by e.evidence_source
    order by count(*) desc, e.evidence_source`);
  const originRows = mode !== "skills" ? [] : await db.all(sql`
    select
      e.capability_id,
      r.source_protocol,
      e.evidence_source,
      ${uses} as uses,
      ${FILE_READS} as file_reads
    from routing_tool_skill_events e
    join routing_requests r on r.id = e.routing_request_id
    where ${where}
    group by e.capability_id, r.source_protocol, e.evidence_source
    order by count(*) desc, e.capability_id, r.source_protocol, e.evidence_source`);
  const versions = versionRows.map((v) => ({
    version: v.skill_version ?? null,
    uses: readInt(v.uses),
    file_reads: readInt(v.file_reads),
    latest_at: formatInstant(readInstant(v.latest_at)),
  }));
  const sources = sourceRows.map((s) => ({
    source: String(s.evidence_source),
    uses: readInt(s.uses),
    file_reads: readInt(s.file_reads),
  }));
  const origins = originRows.map((o) => ({
    capability_id: String(o.capability_id),
    source_protocol: String(o.source_protocol),
    evidence_source: String(o.evidence_source),
    uses: readInt(o.uses),
    file_reads: readInt(o.file_reads),
  }));
  return {
    from_at: formatInstant(filters.start),
    to_at: formatInstant(filters.end),
    bucket_seconds: filters.bucketSeconds,
    mode,
    item: itemBody(row, identities.map(topIdentity)),
    series: await loadSeries(scope, [capabilityId], new Map([[capabilityId, row.observed_name]])),
    identities: identities.map((identity) => ({ ...identity, latest_at: formatInstant(identity.latest_at) })),
    versions,
    sources,
    origins,
  };
}

export type InventoryQuery = {
  search: string;
  sortBy: "name" | "uses" | "file_reads" | "latest";
  sortDirection: "asc" | "desc";
  limit: number;
  offset: number;
};

const INVENTORY_SORTS = {
  name: sql`lower(observed_name)`,
  uses: sql`uses`,
  file_reads: sql`file_reads`,
  latest: sql`latest_at`,
};

export async function toolSkillInventory(scope: Scope, query: InventoryQuery) {
  const pattern = likePattern(query.search);
  const matches = query.search
    ? sql`lower(capability_id) like ${pattern} escape '/' or lower(observed_name) like ${pattern} escape '/'`
    : sql`true`;
  const filtered = sql`
    select *
    from (${itemRows(scope.mode, scopeCriteria(scope))}) aggregate_rows
    where ${matches}`;
  const [count] = await scope.db.all(sql`select count(*) as total from (${filtered}) filtered_rows`);
  const rows = (await scope.db.all(sql`
    select *
    from (${filtered}) filtered_rows
    order by ${INVENTORY_SORTS[query.sortBy]} ${raw(query.sortDirection)}, capability_id
    limit ${query.limit + 1} offset ${query.offset}`)).map(readItemRow);
  const page = rows.slice(0, query.limit);
  return {
    total_items: readInt(count?.total),
    items: await items(scope, page),
    next_offset: rows.length > query.limit ? query.offset + query.limit : null,
  };
}
