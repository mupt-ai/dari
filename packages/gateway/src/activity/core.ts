/* The Activity overview, series, routers, models, and filter options. */

import type { ActivityRequest, ActivityRoute } from "./http.js";
import {
  baseCriteria,
  bucketIndex,
  bucketStart,
  criteria,
  identityCriteria,
  MODEL,
  readActivityQuery,
  readSourceScope,
  SELECTOR_UNRESOLVED_MODEL,
  sourceProtocols,
  validatedBucketFilters,
  validatedFilters,
  type ActivityFilters,
} from "./filters.js";
import { loadRouterSavings, loadSavings, routeKey } from "./savings.js";
import { and, sql, type ActivityDb, type Sql } from "./sql.js";
import { CONVERSATION_ID, REASONING_EFFORTS, THINKING_LEVEL, thinkingLevelValue, type ReasoningEffort } from "./shared.js";
import {
  decimalText,
  formatInstant,
  parseDecimal,
  readInstant,
  readInt,
  readOptionalString,
  sumDecimalText,
  type Decimal,
} from "./values.js";

type Row = Record<string, unknown>;
const MAX_MODEL_TRANSITIONS = 200;

/** Read the filters, then admit the caller, then validate, as the API orders its checks. */
function readFilters(request: ActivityRequest, bucketed: boolean): { organizationId: string; filters: ActivityFilters } {
  const bucketSeconds = bucketed ? request.params.int("bucket_seconds", { ge: 60 }) : 0;
  const scope = readSourceScope(request.params);
  const query = readActivityQuery(request.params);
  request.params.done();
  const protocols = sourceProtocols(scope);
  const organizationId = request.admitted();
  const filters = bucketed
    ? validatedBucketFilters(query, protocols, bucketSeconds)
    : validatedFilters(query, protocols);
  return { organizationId, filters };
}

/** Steps, tokens, and spend: the totals the grouped reads select. Read with `usage`. */
const USAGE = sql`
  count(*) as model_steps,
  coalesce(sum(r.provider_input_tokens), 0) as input_tokens,
  coalesce(sum(r.provider_cache_read_tokens), 0) as cache_read_tokens,
  coalesce(sum(r.provider_cache_write_tokens), 0) as cache_write_tokens,
  coalesce(sum(r.provider_output_tokens), 0) as output_tokens,
  coalesce(sum(r.provider_total_tokens), 0) as total_tokens,
  cast(sum(r.provider_total_cost_usd) as text) as provider_spend,
  count(*) filter (
    where r.provider_pricing_known is true and r.selected_model is not null and r.selected_provider is not null
  ) as priced_steps,
  count(*) filter (
    where r.provider_pricing_known is false and r.selected_model is not null and r.selected_provider is not null
  ) as unpriced_steps`;

function usage(row: Row) {
  return {
    model_steps: readInt(row.model_steps),
    provider_input_tokens: readInt(row.input_tokens),
    provider_cache_read_tokens: readInt(row.cache_read_tokens),
    provider_cache_write_tokens: readInt(row.cache_write_tokens),
    provider_output_tokens: readInt(row.output_tokens),
    provider_total_tokens: readInt(row.total_tokens),
    provider_spend_usd: decimalText(row.provider_spend),
    priced_model_steps: readInt(row.priced_steps),
    unpriced_model_steps: readInt(row.unpriced_steps),
  };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/* Series and overview. */

type SeriesPoint = {
  bucket_start: string;
  model: string;
  thinking_level: ReasoningEffort | null;
  provider: string | null;
  messages_sent: number;
  model_steps: number;
  provider_input_tokens: number;
  provider_cache_read_tokens: number;
  provider_cache_write_tokens: number;
  provider_output_tokens: number;
  provider_total_tokens: number;
  provider_spend_usd: string | null;
  priced_model_steps: number;
  unpriced_model_steps: number;
  predicted_warm_requests: number;
  predicted_warm_without_cache_read: number;
};

async function loadSeries(db: ActivityDb, filters: ActivityFilters, where: Sql): Promise<SeriesPoint[]> {
  const rows = await db.all<Row>(sql`
    select
      ${bucketIndex(db, filters)} as bucket_index,
      ${MODEL} as model,
      ${THINKING_LEVEL} as thinking_level,
      r.selected_provider as provider,
      count(*) filter (where r.request_kind = 'user_message') as messages_sent,
      ${USAGE},
      count(*) filter (where r.prefix_warm_tokens > 0) as predicted_warm,
      count(*) filter (
        where r.prefix_warm_tokens > 0 and coalesce(r.provider_cache_read_tokens, 0) = 0
      ) as predicted_warm_without_read
    from routing_requests r
    where ${where}
    group by 1, 2, 3, 4
    order by 1, 2, 3 nulls last, 4 nulls last`);
  return rows.map((row) => ({
    bucket_start: bucketStart(filters, row.bucket_index),
    model: String(row.model),
    thinking_level: thinkingLevelValue(row.thinking_level),
    provider: readOptionalString(row.provider),
    messages_sent: readInt(row.messages_sent),
    ...usage(row),
    predicted_warm_requests: readInt(row.predicted_warm),
    predicted_warm_without_cache_read: readInt(row.predicted_warm_without_read),
  }));
}

function summary(series: SeriesPoint[], savings: string | null) {
  const total = (pick: (point: SeriesPoint) => number) => series.reduce((sum, point) => sum + pick(point), 0);
  return {
    messages_sent: total((p) => p.messages_sent),
    model_steps: total((p) => p.model_steps),
    provider_input_tokens: total((p) => p.provider_input_tokens),
    provider_cache_read_tokens: total((p) => p.provider_cache_read_tokens),
    provider_cache_write_tokens: total((p) => p.provider_cache_write_tokens),
    provider_output_tokens: total((p) => p.provider_output_tokens),
    provider_total_tokens: total((p) => p.provider_total_tokens),
    provider_spend_usd: sumDecimalText(series.map((p) => p.provider_spend_usd)),
    priced_model_steps: total((p) => p.priced_model_steps),
    unpriced_model_steps: total((p) => p.unpriced_model_steps),
    predicted_warm_requests: total((p) => p.predicted_warm_requests),
    predicted_warm_without_cache_read: total((p) => p.predicted_warm_without_cache_read),
    savings_vs_most_expensive_usd: savings,
  };
}

/** A series point as the API writes one: without the warm-prefix counts. */
function seriesPointBody(point: SeriesPoint) {
  const { predicted_warm_requests: _warm, predicted_warm_without_cache_read: _cold, ...body } = point;
  return body;
}

function modelMix(series: SeriesPoint[]) {
  const totals = new Map<string, { model: string; thinking_level: ReasoningEffort | null; provider: string | null; model_steps: number }>();
  for (const point of series) {
    const key = JSON.stringify([point.model, point.thinking_level, point.provider]);
    const entry = totals.get(key);
    if (entry) entry.model_steps += point.model_steps;
    else totals.set(key, { model: point.model, thinking_level: point.thinking_level, provider: point.provider, model_steps: point.model_steps });
  }
  // Stable, as Python's `sorted`: steps descending, then model.
  return [...totals.values()].sort((a, b) => b.model_steps - a.model_steps || compareText(a.model, b.model));
}

async function loadApiKeys(db: ActivityDb, where: Sql) {
  // A key's person is named only when all its traffic is one person's.
  const rows = await db.all(sql`
    select
      r.api_key_id,
      k.label,
      k.key_prefix,
      case when count(distinct coalesce(r.attributed_user_id, '__unassigned__')) = 1
           then max(r.attributed_user_id) end as assigned_user_id,
      case when count(distinct coalesce(r.attributed_user_id, '__unassigned__')) = 1
           then max(coalesce(u.display_name, u.email)) else 'Multiple People' end as assigned_user_name,
      count(*) filter (where r.request_kind = 'user_message') as messages_sent,
      count(*) as model_steps,
      coalesce(sum(r.provider_total_tokens), 0) as total_tokens,
      cast(sum(r.provider_total_cost_usd) as text) as provider_spend,
      count(*) filter (
        where r.provider_pricing_known is true and r.selected_model is not null and r.selected_provider is not null
      ) as priced_steps,
      count(*) filter (
        where r.provider_pricing_known is false and r.selected_model is not null and r.selected_provider is not null
      ) as unpriced_steps,
      cast(max(r.received_at) as text) as latest_at
    from routing_requests r
    left join organization_api_keys k on k.id = r.api_key_id
    left join users u on u.id = r.attributed_user_id
    where ${where}
    group by r.api_key_id, k.label, k.key_prefix
    order by messages_sent desc, sum(r.provider_total_cost_usd) desc nulls last, r.api_key_id nulls last`);
  return rows.map((row) => ({
    api_key_id: readOptionalString(row.api_key_id),
    label: readOptionalString(row.label) || "Unattributed",
    key_prefix: readOptionalString(row.key_prefix),
    assigned_user_id: readOptionalString(row.assigned_user_id),
    assigned_user_name: readOptionalString(row.assigned_user_name),
    messages_sent: readInt(row.messages_sent),
    model_steps: readInt(row.model_steps),
    provider_total_tokens: readInt(row.total_tokens),
    provider_spend_usd: decimalText(row.provider_spend),
    priced_model_steps: readInt(row.priced_steps),
    unpriced_model_steps: readInt(row.unpriced_steps),
    latest_at: formatInstant(readInstant(row.latest_at)),
  }));
}

async function loadKeySources(db: ActivityDb, where: Sql) {
  const rows = await db.all<Row>(sql`
    select
      r.provider_key_source as key_source,
      ${USAGE}
    from routing_requests r
    where ${where}
    group by r.provider_key_source
    order by sum(r.provider_total_cost_usd) desc nulls last, r.provider_key_source nulls last`);
  return rows.map((row) => ({ key_source: readOptionalString(row.key_source), ...usage(row) }));
}

export const series: ActivityRoute = async (request) => {
  const { organizationId, filters } = readFilters(request, true);
  const points = await loadSeries(request.db, filters, criteria(request.db, organizationId, filters));
  return {
    from_at: formatInstant(filters.start),
    to_at: formatInstant(filters.end),
    bucket_seconds: filters.bucketSeconds,
    summary: summary(points, null),
    series: points.map(seriesPointBody),
  };
};

export const overview: ActivityRoute = async (request) => {
  const { organizationId, filters } = readFilters(request, true);
  const db = request.db;
  const where = criteria(db, organizationId, filters);
  const [points, savings, apiKeys, keySources] = await Promise.all([
    loadSeries(db, filters, where),
    loadSavings(db, where),
    loadApiKeys(db, where),
    loadKeySources(db, where),
  ]);
  return {
    from_at: formatInstant(filters.start),
    to_at: formatInstant(filters.end),
    bucket_seconds: filters.bucketSeconds,
    summary: summary(points, savings.total),
    series: points.map(seriesPointBody),
    model_mix: modelMix(points),
    api_keys: apiKeys,
    key_sources: keySources,
  };
};

/* Routers. */

export const routers: ActivityRoute = async (request) => {
  const { organizationId, filters } = readFilters(request, true);
  const db = request.db;
  const where = criteria(db, organizationId, filters);
  const [summaries, savings, seriesRows] = await Promise.all([
    db.all(sql`
    select
      r.router_id,
      count(*) filter (where r.status = 'completed') as completed,
      count(*) filter (where r.status = 'provider_error') as provider_error,
      count(*) filter (where r.status = 'selector_error') as selector_error,
      count(*) filter (where r.status = 'aborted') as aborted,
      cast(sum(r.provider_total_cost_usd) as text) as provider_spend
    from routing_requests r
    where ${where}
      and r.router_id is not null
    group by r.router_id
    order by r.router_id`),
    loadRouterSavings(db, where),
    db.all(sql`
    select
      r.router_id,
      ${bucketIndex(db, filters)} as bucket_index,
      count(*) filter (where r.request_kind = 'user_message') as messages_sent
    from routing_requests r
    where ${where}
      and r.router_id is not null
    group by 1, 2
    order by 1, 2`),
  ]);
  const seriesByRouter = new Map<string, Array<{ bucket_start: string; messages_sent: number }>>();
  for (const row of seriesRows) {
    const routerId = String(row.router_id);
    const points = seriesByRouter.get(routerId) ?? [];
    points.push({ bucket_start: bucketStart(filters, row.bucket_index), messages_sent: readInt(row.messages_sent) });
    seriesByRouter.set(routerId, points);
  }
  return {
    from_at: formatInstant(filters.start),
    to_at: formatInstant(filters.end),
    bucket_seconds: filters.bucketSeconds,
    routers: summaries.map((row) => {
      const routerId = String(row.router_id);
      const points = seriesByRouter.get(routerId) ?? [];
      return {
        router_id: routerId,
        messages_sent: points.reduce((sum, point) => sum + point.messages_sent, 0),
        completed_requests: readInt(row.completed),
        provider_error_requests: readInt(row.provider_error),
        selector_error_requests: readInt(row.selector_error),
        aborted_requests: readInt(row.aborted),
        provider_spend_usd: decimalText(row.provider_spend),
        savings_vs_most_expensive_usd: savings.get(routerId) ?? null,
        series: points,
      };
    }),
  };
};

/* Models. */

/** The p95 provider latency per model, thinking level, and provider (`percentile_disc(0.95)`). */
async function loadLatencyP95(db: ActivityDb, where: Sql): Promise<Map<string, number>> {
  const key = (row: Row) => JSON.stringify([String(row.model), thinkingLevelValue(row.thinking_level), readOptionalString(row.provider)]);
  if (db.dialect === "postgres") {
    // Group by the thinking level as the key reads it: an unknown one is none.
    const rows = await db.all(sql`
      select
        ${MODEL} as model,
        case when ${THINKING_LEVEL} in (${REASONING_EFFORTS}) then ${THINKING_LEVEL} end as thinking_level,
        r.selected_provider as provider,
        percentile_disc(0.95) within group (order by r.provider_latency_ms) as latency
      from routing_requests r
      where ${where}
        and r.provider_latency_ms > 0
      group by 1, 2, 3`);
    return new Map(rows.map((row) => [key(row), readInt(row.latency)]));
  }
  // SQLite has no percentile_disc: read every latency and pick the same value.
  const rows = await db.all(sql`
    select
      ${MODEL} as model,
      ${THINKING_LEVEL} as thinking_level,
      r.selected_provider as provider,
      r.provider_latency_ms as latency
    from routing_requests r
    where ${where}
      and r.provider_latency_ms > 0`);
  const grouped = new Map<string, number[]>();
  for (const row of rows) {
    const values = grouped.get(key(row)) ?? [];
    values.push(readInt(row.latency));
    grouped.set(key(row), values);
  }
  const p95 = new Map<string, number>();
  for (const [key, values] of grouped) {
    values.sort((a, b) => a - b);
    p95.set(key, values[Math.max(0, Math.ceil(values.length * 0.95) - 1)]!);
  }
  return p95;
}

async function loadModelRows(db: ActivityDb, where: Sql) {
  const [rows, latency] = await Promise.all([db.all<Row>(sql`
    select
      ${MODEL} as model,
      ${THINKING_LEVEL} as thinking_level,
      r.selected_provider as provider,
      ${USAGE},
      count(*) filter (where r.status != 'completed') as non_completed_steps
    from routing_requests r
    where ${where}
    group by 1, 2, 3
    order by model_steps desc, 1, 2 nulls last, 3 nulls last`), loadLatencyP95(db, where)]);
  return rows.map((row) => {
    const model = String(row.model);
    const thinkingLevel = thinkingLevelValue(row.thinking_level);
    const provider = readOptionalString(row.provider);
    const totals = usage(row);
    const nonCompleted = readInt(row.non_completed_steps);
    return {
      model,
      thinking_level: thinkingLevel,
      provider,
      ...totals,
      provider_latency_p95_ms: latency.get(JSON.stringify([model, thinkingLevel, provider])) ?? null,
      non_completed_steps: nonCompleted,
      savings_vs_most_expensive_usd: null as string | null,
      provider_cost_per_step_usd: totals.provider_spend_usd === null || totals.model_steps === 0
        ? null
        : divideFormat(parseDecimal(totals.provider_spend_usd), totals.model_steps),
      non_completion_rate: ratio(nonCompleted, totals.model_steps),
    };
  });
}

/** The conversations with a step that reached a model. */
async function loadObservedConversations(db: ActivityDb, where: Sql): Promise<number> {
  const [row] = await db.all(sql`
    select count(*) as count
    from (
      select distinct
        r.router_id,
        r.api_key_id,
        r.attributed_user_id,
        r.source_protocol,
        ${CONVERSATION_ID}
      from routing_requests r
      where ${where}
        and ${CONVERSATION_ID} is not null
        and r.selected_model is not null
        and r.selected_provider is not null
    ) observed`);
  return readInt(row?.count);
}

/**
 * Adjacent model, provider, or thinking-level changes within each
 * conversation. Steps are ordered under the identity filters only; the
 * model, provider, and status filters apply to the step switched to, and
 * the key-source filter not at all.
 */
async function loadTransitions(db: ActivityDb, organizationId: string, filters: ActivityFilters) {
  const switchedTo: Sql[] = [];
  if (filters.models.length > 0) {
    const ids = filters.models.filter((model) => model !== SELECTOR_UNRESOLVED_MODEL);
    switchedTo.push(ids.length > 0 ? sql`o.to_model in (${ids})` : sql`o.to_model is null`);
  }
  if (filters.provider) switchedTo.push(sql`o.to_provider = ${filters.provider}`);
  if (filters.status) switchedTo.push(sql`o.to_status = ${filters.status}`);
  const rows = await db.all(sql`
    with ordered as (
      select
        r.router_id,
        r.api_key_id,
        r.attributed_user_id,
        r.source_protocol,
        ${CONVERSATION_ID} as conversation_id,
        r.selected_model as to_model,
        ${THINKING_LEVEL} as to_thinking_level,
        r.selected_provider as to_provider,
        r.request_kind as to_kind,
        r.status as to_status,
        lag(r.selected_model) over w as from_model,
        lag(${THINKING_LEVEL}) over w as from_thinking_level,
        lag(r.selected_provider) over w as from_provider
      from routing_requests r
      where ${baseCriteria(db, organizationId, filters)}
        and ${identityCriteria(filters)}
        and ${CONVERSATION_ID} is not null
        and r.selected_model is not null
        and r.selected_provider is not null
      window w as (
        partition by r.router_id, r.api_key_id, r.attributed_user_id, r.source_protocol, ${CONVERSATION_ID}
        order by r.received_at, r.id
      )
    ),
    per_conversation as materialized (
      select
        o.from_model, o.from_thinking_level, o.from_provider,
        o.to_model, o.to_thinking_level, o.to_provider,
        o.router_id, o.api_key_id, o.attributed_user_id, o.source_protocol, o.conversation_id,
        count(*) as occurrences,
        count(*) filter (where o.to_kind = 'tool_continuation') as tool_continuations
      from ordered o
      where o.from_model is not null
        and o.from_provider is not null
        and (
          o.from_model != o.to_model
          or o.from_provider != o.to_provider
          or o.from_thinking_level is distinct from o.to_thinking_level
        )
        and ${and(switchedTo)}
      group by
        o.from_model, o.from_thinking_level, o.from_provider,
        o.to_model, o.to_thinking_level, o.to_provider,
        o.router_id, o.api_key_id, o.attributed_user_id, o.source_protocol, o.conversation_id
    ),
    grouped as (
      select
        t.from_model, t.from_thinking_level, t.from_provider,
        t.to_model, t.to_thinking_level, t.to_provider,
        sum(t.occurrences) as occurrences,
        count(*) as conversations,
        sum(t.tool_continuations) as tool_continuations
      from per_conversation t
      group by
        t.from_model, t.from_thinking_level, t.from_provider,
        t.to_model, t.to_thinking_level, t.to_provider
    )
    select
      g.*,
      sum(case when g.from_model = g.to_model and g.from_provider = g.to_provider
               then 0 else g.occurrences end) over () as model_switches,
      sum(case when g.from_model = g.to_model and g.from_provider = g.to_provider
               then g.occurrences else 0 end) over () as thinking_level_switches,
      sum(case when g.from_provider != g.to_provider then g.occurrences else 0 end) over () as cross_provider_switches,
      (
        select count(*)
        from (
          select distinct t.router_id, t.api_key_id, t.attributed_user_id, t.source_protocol, t.conversation_id
          from per_conversation t
        ) switched
      ) as switched_conversations
    from grouped g
    order by g.occurrences desc, g.from_model, g.from_thinking_level nulls last, g.to_model, g.to_thinking_level nulls last
    limit ${MAX_MODEL_TRANSITIONS}`);
  const first = rows[0];
  return {
    modelSwitches: readInt(first?.model_switches),
    thinkingLevelSwitches: readInt(first?.thinking_level_switches),
    crossProviderSwitches: readInt(first?.cross_provider_switches),
    switchedConversations: readInt(first?.switched_conversations),
    transitions: rows.map((row) => ({
      from_model: String(row.from_model),
      from_thinking_level: thinkingLevelValue(row.from_thinking_level),
      from_provider: String(row.from_provider),
      to_model: String(row.to_model),
      to_thinking_level: thinkingLevelValue(row.to_thinking_level),
      to_provider: String(row.to_provider),
      occurrences: readInt(row.occurrences),
      conversations: readInt(row.conversations),
      tool_continuations: readInt(row.tool_continuations),
    })),
  };
}

export const models: ActivityRoute = async (request) => {
  const { organizationId, filters } = readFilters(request, false);
  const db = request.db;
  const where = criteria(db, organizationId, filters);
  const [modelRows, switches, savings, observed] = await Promise.all([
    loadModelRows(db, where),
    loadTransitions(db, organizationId, filters),
    loadSavings(db, where),
    loadObservedConversations(db, where),
  ]);
  for (const model of modelRows) {
    if (model.provider !== null) {
      model.savings_vs_most_expensive_usd = savings.byModel.get(routeKey(model.model, model.thinking_level, model.provider)) ?? null;
    }
  }
  const totalSwitches = switches.modelSwitches + switches.thinkingLevelSwitches;
  const transitions = switches.transitions.map((item) => ({ ...item, switch_share: ratio(item.occurrences, totalSwitches) }));
  return {
    from_at: formatInstant(filters.start),
    to_at: formatInstant(filters.end),
    summary: {
      model_steps: modelRows.reduce((sum, model) => sum + model.model_steps, 0),
      observed_conversations: observed,
      switched_conversations: switches.switchedConversations,
      model_switches: switches.modelSwitches,
      thinking_level_switches: switches.thinkingLevelSwitches,
      cross_provider_switches: switches.crossProviderSwitches,
      savings_vs_most_expensive_usd: savings.total,
      switched_conversation_rate: ratio(switches.switchedConversations, observed),
      cross_provider_switch_rate: ratio(switches.crossProviderSwitches, switches.modelSwitches),
    },
    models: modelRows,
    transitions,
    transitions_truncated: transitions.reduce((sum, item) => sum + item.occurrences, 0) < totalSwitches,
  };
};

const PRECISION = 28;

/**
 * Python's `format(Decimal(value) / divisor, "f")` under the default context:
 * 28 significant digits, rounded half-even, and an exact quotient kept as
 * close to the dividend's exponent as it allows.
 */
export function divideFormat(value: Decimal, divisor: number): string {
  const negative = (value.coefficient < 0n) !== (divisor < 0);
  const a = value.coefficient < 0n ? -value.coefficient : value.coefficient;
  const b = BigInt(Math.abs(divisor));
  let exponent = value.exponent;
  let coefficient = 0n;
  if (a !== 0n) {
    const shift = b.toString().length - a.toString().length + PRECISION + 1;
    exponent -= shift;
    const [numerator, denominator] = shift >= 0 ? [a * 10n ** BigInt(shift), b] : [a, b * 10n ** BigInt(-shift)];
    coefficient = numerator / denominator;
    if (numerator % denominator !== 0n) {
      // Inexact: make sure a dropped half is never a tie.
      if (coefficient % 5n === 0n) coefficient += 1n;
    } else {
      while (exponent < value.exponent && coefficient % 10n === 0n) {
        coefficient /= 10n;
        exponent += 1;
      }
    }
    const excess = coefficient.toString().length - PRECISION;
    if (excess > 0) {
      coefficient = roundHalfEven(coefficient, excess);
      exponent += excess;
      if (coefficient.toString().length > PRECISION) {
        coefficient /= 10n;
        exponent += 1;
      }
    }
  }
  const digits = coefficient.toString();
  let text: string;
  if (exponent >= 0) text = digits + "0".repeat(exponent);
  else if (digits.length > -exponent) text = `${digits.slice(0, digits.length + exponent)}.${digits.slice(digits.length + exponent)}`;
  else text = `0.${"0".repeat(-exponent - digits.length)}${digits}`;
  return negative && coefficient !== 0n ? `-${text}` : text;
}

function roundHalfEven(value: bigint, drop: number): bigint {
  const divisor = 10n ** BigInt(drop);
  let quotient = value / divisor;
  const remainder = value % divisor;
  const half = divisor / 2n;
  if (remainder > half || (remainder === half && quotient % 2n === 1n)) quotient += 1n;
  return quotient;
}

/* Filter options. */

export const filterOptions: ActivityRoute = async (request) => {
  const { organizationId, filters } = readFilters(request, false);
  const db = request.db;
  const where = baseCriteria(db, organizationId, filters);
  const [routerRows, keyRows, userRows, modelRows] = await Promise.all([
    db.all(sql`
    select distinct
      r.router_id,
      m.name
    from routing_requests r
    left join model_routers m on m.id = r.router_id
    where ${where}
      and r.router_id is not null
    order by m.name nulls last, r.router_id`),
    db.all(sql`
    select distinct
      k.id,
      k.label,
      k.key_prefix,
      coalesce(k.created_for_user_id, k.attributed_to_user_id) as assigned_user_id,
      u.display_name,
      u.email
    from organization_api_keys k
    join routing_requests r on r.api_key_id = k.id
    left join users u on u.id = coalesce(k.created_for_user_id, k.attributed_to_user_id)
    where ${where}
      and k.organization_id = ${organizationId}
    order by k.label, k.id`),
    db.all(sql`
    select distinct
      r.attributed_user_id,
      u.display_name,
      u.email
    from routing_requests r
    join users u on u.id = r.attributed_user_id
    where ${where}
      and r.attributed_user_id is not null
    order by u.display_name nulls last, u.email, r.attributed_user_id`),
    db.all(sql`
    select distinct
      ${MODEL} as model,
      r.selected_provider
    from routing_requests r
    where ${where}`),
  ]);

  const providersByModel = new Map<string, Set<string>>();
  const providers = new Set<string>();
  for (const row of modelRows) {
    const model = String(row.model);
    const modelProviders = providersByModel.get(model) ?? new Set<string>();
    providersByModel.set(model, modelProviders);
    if (row.selected_provider !== null && row.selected_provider !== undefined) {
      modelProviders.add(String(row.selected_provider));
      providers.add(String(row.selected_provider));
    }
  }
  const sorted = (values: Iterable<string>) => [...values].sort(compareText);
  return {
    routers: routerRows.map((row) => ({ id: String(row.router_id), name: readOptionalString(row.name) || String(row.router_id) })),
    api_keys: keyRows.map((row) => ({
      id: String(row.id),
      label: String(row.label),
      key_prefix: String(row.key_prefix),
      assigned_user_id: readOptionalString(row.assigned_user_id),
      assigned_user_name: readOptionalString(row.display_name) || readOptionalString(row.email),
    })),
    users: userRows.map((row) => ({
      id: String(row.attributed_user_id),
      name: readOptionalString(row.display_name) || String(row.email),
      email: String(row.email),
    })),
    models: sorted(providersByModel.keys()).map((model) => ({ id: model, providers: sorted(providersByModel.get(model)!) })),
    providers: sorted(providers),
  };
};
