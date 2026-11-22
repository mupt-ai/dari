/* Tool exchanges: emitted tool calls matched at read time with the results
   later requests submitted. A result matches the latest earlier completed,
   non-ZDR call with the same exchange context and call ID on the same router,
   key, and protocol. */

import {
  dimensionCriteria,
  readActivityQuery,
  readSourceScope,
  sourceProtocols,
  timeRange,
  validatedFilters,
  type ActivityFilters,
} from "./filters.js";
import type { ActivityRoute } from "./http.js";
import { badRequest } from "./params.js";
import { join, raw, sql, type ActivityDb, type Sql } from "./sql.js";
import { formatInstant, readInt, readOptionalInstant, readOptionalString } from "./values.js";

export const EXCHANGE_STATES = ["matched", "unmatched_call", "orphan_result"] as const;
export const EXCHANGE_MAX_LIMIT = 200;
const EXCHANGE_MAX_REQUEST_IDS = 100;

export type ExchangeQuery = {
  states: readonly string[];
  capabilityId: string | null;
  requestIds: readonly string[];
  includeTotal: boolean;
  limit: number;
  offset: number;
};

export type ExchangePage = { total_items: number | null; items: object[]; next_offset: number | null };

export const toolExchanges: ActivityRoute = async (request) => {
  const { params } = request;
  const scope = readSourceScope(params);
  const states = params.literals("exchange_state", EXCHANGE_STATES);
  const capabilityId = params.string("capability_id", { maxLength: 512 }) ?? null;
  const requestIds = params.strings("request_id");
  const includeTotal = params.bool("include_total", true);
  const limit = params.int("limit", { default: 50, ge: 1, le: EXCHANGE_MAX_LIMIT });
  const offset = params.int("offset", { default: 0, ge: 0 });
  const query = readActivityQuery(params);
  params.done();
  const protocols = sourceProtocols(scope);
  if (requestIds.length > EXCHANGE_MAX_REQUEST_IDS) {
    throw badRequest(`Select at most ${EXCHANGE_MAX_REQUEST_IDS} routing request IDs.`);
  }
  const organizationId = request.admitted();
  const filters = validatedFilters(query, protocols);
  return loadToolExchanges(request.db, organizationId, filters, {
    states: states ?? (capabilityId !== null ? ["matched", "unmatched_call"] : EXCHANGE_STATES),
    capabilityId,
    requestIds,
    includeTotal,
    limit,
    offset,
  });
};

function validatedQuery(query: ExchangeQuery): ExchangeQuery {
  const states = [...new Set(query.states)];
  const unsupported = states.filter((state) => !(EXCHANGE_STATES as readonly string[]).includes(state));
  if (unsupported.length > 0) throw badRequest(`Unsupported tool exchange state: ${unsupported.sort().join(", ")}.`);
  if (states.length === 0) throw badRequest("Select at least one tool exchange state.");
  if (query.limit < 1 || query.limit > EXCHANGE_MAX_LIMIT) {
    throw badRequest(`Tool exchange page limit must be between 1 and ${EXCHANGE_MAX_LIMIT}.`);
  }
  if (query.offset < 0) throw badRequest("Tool exchange page offset must be non-negative.");
  const capabilityId = query.capabilityId ? query.capabilityId.trim() : null;
  if (capabilityId !== null && [...capabilityId].length > 512) {
    throw badRequest("Tool exchange capability IDs cannot exceed 512 characters.");
  }
  if (capabilityId !== null && states.includes("orphan_result")) {
    throw badRequest("Capability-scoped tool exchanges cannot include orphan results.");
  }
  const requestIds = [...new Set(query.requestIds)];
  if (requestIds.length > EXCHANGE_MAX_REQUEST_IDS) {
    throw badRequest(`Select at most ${EXCHANGE_MAX_REQUEST_IDS} routing request IDs.`);
  }
  if (requestIds.some((id) => id === "" || [...id].length > 128)) {
    throw badRequest("Routing request IDs must contain 1 to 128 characters.");
  }
  return { ...query, states, capabilityId, requestIds };
}

export async function loadToolExchanges(
  db: ActivityDb,
  organizationId: string,
  filters: ActivityFilters,
  rawQuery: ExchangeQuery,
): Promise<ExchangePage> {
  const query = validatedQuery(rawQuery);
  // Named requests scope the read to themselves and the other side of their
  // exchanges, in any time range.
  const ids = query.requestIds;
  const named = ids.length > 0;
  const yes = sql`true`;
  const ofCapability = (alias: string) =>
    query.capabilityId === null ? yes : sql`${raw(alias)}.capability_id = ${query.capabilityId}`;
  /** The named requests, or the requests in the time range. */
  const inScope = (alias: string) => (named ? sql`${raw(alias)}.id in (${ids})` : timeRange(db, filters, alias));

  // The results the named requests observed, and the results of the calls they made.
  const requested = !named ? sql`` : sql`
    requested_tool_call_pairs as (
      select distinct
        ce.exchange_context_hash,
        ce.tool_call_id
      from routing_tool_skill_events ce
      join routing_requests cr on cr.id = ce.routing_request_id
      where cr.id in (${ids})
        and cr.organization_id = ${organizationId}
        and ce.event_type = 'tool_call'
        and ce.exchange_context_hash is not null
        and ce.tool_call_id is not null
    ),
    request_scoped_tool_result_ids as (
      select o.id as result_observation_id
      from routing_tool_result_observations o
      join routing_requests dr on dr.id = o.routing_request_id
      where dr.organization_id = ${organizationId}
        and dr.id in (${ids})
      union
      select o.id
      from requested_tool_call_pairs p
      join routing_tool_result_observations o
        on o.exchange_context_hash = p.exchange_context_hash and o.tool_call_id = p.tool_call_id
      join routing_requests xr on xr.id = o.routing_request_id
      where xr.organization_id = ${organizationId}
    ),`;

  // Each result with the call it answers: the latest earlier completed call
  // with its exchange context and call ID, on its router, key, and protocol.
  const matches = sql`
    select
      o.id as result_observation_id,
      (
        select ce.id
        from routing_tool_skill_events ce
        join routing_requests cr on cr.id = ce.routing_request_id
        where ce.event_type = 'tool_call'
          and ${ofCapability("ce")}
          and ce.exchange_context_hash is not null
          and ce.tool_call_id is not null
          and ce.exchange_context_hash = o.exchange_context_hash
          and ce.tool_call_id = o.tool_call_id
          and cr.organization_id = rr.organization_id
          and cr.router_id = rr.router_id
          and (cr.api_key_id = rr.api_key_id or (cr.api_key_id is null and rr.api_key_id is null))
          and cr.source_protocol = rr.source_protocol
          and cr.zdr is false
          and cr.completed_at is not null
          and cr.completed_at <= rr.received_at
        order by cr.completed_at desc, cr.id desc, ce.id desc
        limit 1
      ) as call_event_id
    from routing_tool_result_observations o
    join routing_requests rr on rr.id = o.routing_request_id
    ${named ? sql`join request_scoped_tool_result_ids scoped on scoped.result_observation_id = o.id` : sql``}
    where rr.organization_id = ${organizationId}
      and ${named ? yes : timeRange(db, filters, "rr")}
      and rr.source_protocol in (${filters.protocols})
      and rr.zdr is false`;

  // One select per state, with the same columns: `e` and `cr` are the call
  // and its request, `o` and `rr` the result and its request.
  const matched = sql`
    select
      cast('matched' as text) as state,
      e.tool_call_id,
      e.capability_id,
      e.observed_name,
      cr.source_protocol,
      cr.router_id,
      cr.api_key_id,
      e.id as call_event_id,
      cr.id as call_request_id,
      cr.received_at as call_received_at,
      cr.completed_at as call_completed_at,
      o.id as result_observation_id,
      rr.id as result_request_id,
      rr.received_at as result_observed_at,
      rr.received_at as activity_at
    from selected_tool_result_matches s
    join routing_tool_result_observations o on o.id = s.result_observation_id
    join routing_requests rr on rr.id = o.routing_request_id
    join routing_tool_skill_events e on e.id = s.call_event_id
    join routing_requests cr on cr.id = e.routing_request_id
    where ${dimensionCriteria(filters, "cr")}
      and ${ofCapability("e")}
      and ${named ? sql`(cr.id in (${ids}) or rr.id in (${ids}))` : yes}`;
  const unmatchedCalls = sql`
    select
      cast('unmatched_call' as text) as state,
      e.tool_call_id,
      e.capability_id,
      e.observed_name,
      cr.source_protocol,
      cr.router_id,
      cr.api_key_id,
      e.id as call_event_id,
      cr.id as call_request_id,
      cr.received_at as call_received_at,
      cr.completed_at as call_completed_at,
      cast(null as text) as result_observation_id,
      cast(null as text) as result_request_id,
      cast(null as timestamptz) as result_observed_at,
      cr.received_at as activity_at
    from routing_tool_skill_events e
    join routing_requests cr on cr.id = e.routing_request_id
    where e.event_type = 'tool_call'
      and cr.organization_id = ${organizationId}
      and ${inScope("cr")}
      and cr.source_protocol in (${filters.protocols})
      and cr.zdr is false
      and ${ofCapability("e")}
      and not exists (select 1 from selected_tool_result_matches s where s.call_event_id = e.id)
      and ${dimensionCriteria(filters, "cr")}`;
  const orphanResults = sql`
    select
      cast('orphan_result' as text) as state,
      o.tool_call_id,
      cast(null as text) as capability_id,
      cast(null as text) as observed_name,
      rr.source_protocol,
      rr.router_id,
      rr.api_key_id,
      cast(null as text) as call_event_id,
      cast(null as text) as call_request_id,
      cast(null as timestamptz) as call_received_at,
      cast(null as timestamptz) as call_completed_at,
      o.id as result_observation_id,
      rr.id as result_request_id,
      rr.received_at as result_observed_at,
      rr.received_at as activity_at
    from routing_tool_result_observations o
    join routing_requests rr on rr.id = o.routing_request_id
    where rr.organization_id = ${organizationId}
      and ${inScope("rr")}
      and rr.source_protocol in (${filters.protocols})
      and rr.zdr is false
      and not exists (
        select 1
        from selected_tool_result_matches s
        where s.result_observation_id = o.id and s.call_event_id is not null
      )
      and ${dimensionCriteria(filters, "rr")}`;
  const states: Sql[] = [];
  if (query.states.includes("matched")) states.push(matched);
  if (query.states.includes("unmatched_call")) states.push(unmatchedCalls);
  if (query.states.includes("orphan_result")) states.push(orphanResults);

  // The page, with the total on each of its rows; the total alone when the
  // page is empty.
  const order = sql`
    activity_at desc, state, tool_call_id nulls last, call_event_id nulls last, result_observation_id nulls last`;
  const rows = await db.all(sql`
    with ${requested}
    selected_tool_result_matches as (${matches}),
    tool_exchange_rows as (${join(states, " union all ")}),
    tool_exchange_page as (
      select *
      from tool_exchange_rows
      order by ${order}
      limit ${query.limit + 1} offset ${query.offset}
    ),
    tool_exchange_totals as (
      select count(*) as total_items
      from tool_exchange_rows
    )
    select
      p.state,
      p.tool_call_id,
      p.capability_id,
      p.observed_name,
      p.source_protocol,
      p.router_id,
      p.api_key_id,
      p.call_event_id,
      p.call_request_id,
      cast(p.call_received_at as text) as call_received_at,
      cast(p.call_completed_at as text) as call_completed_at,
      p.result_observation_id,
      p.result_request_id,
      cast(p.result_observed_at as text) as result_observed_at,
      ${query.includeTotal ? sql`t.total_items` : sql`null as total_items`}
    from ${query.includeTotal
      ? sql`tool_exchange_totals t left join tool_exchange_page p on true`
      : sql`tool_exchange_page p`}
    order by ${order}`);

  let page = rows.filter((row) => row.state !== null && row.state !== undefined);
  let nextOffset: number | null = null;
  if (page.length > query.limit) {
    page = page.slice(0, query.limit);
    nextOffset = query.offset + query.limit;
  }
  const text = readOptionalString;
  const time = (value: unknown) => {
    const instant = readOptionalInstant(value);
    return instant === null ? null : formatInstant(instant);
  };
  const items = page.map((row) => {
    const state = String(row.state);
    const item: Record<string, unknown> = { state, tool_call_id: text(row.tool_call_id) };
    if (state !== "orphan_result") {
      Object.assign(item, { capability_id: text(row.capability_id), observed_name: text(row.observed_name) });
    }
    Object.assign(item, { source_protocol: text(row.source_protocol), router_id: text(row.router_id), api_key_id: text(row.api_key_id) });
    if (state !== "orphan_result") {
      Object.assign(item, {
        call_event_id: text(row.call_event_id),
        call_request_id: text(row.call_request_id),
        call_received_at: time(row.call_received_at),
        call_completed_at: time(row.call_completed_at),
      });
    }
    if (state !== "unmatched_call") {
      Object.assign(item, {
        result_observation_id: text(row.result_observation_id),
        result_request_id: text(row.result_request_id),
        result_observed_at: time(row.result_observed_at),
      });
    }
    if (state === "matched") {
      // Python: int(timedelta.total_seconds() * 1000), floored at 0.
      const micros = readOptionalInstant(row.result_observed_at)! - readOptionalInstant(row.call_completed_at)!;
      item.result_turnaround_ms = Math.max(0, Math.trunc((micros / 1e6) * 1000));
    }
    return item;
  });
  return {
    total_items: query.includeTotal ? readInt(rows[0]!.total_items) : null,
    items,
    next_offset: nextOffset,
  };
}
