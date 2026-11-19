/* Savings against each router's benchmark: the persisted per-step benchmark
   replay cost minus the provider spend. Activity only sums what the routing
   runtime stored; it never replays a conversation. A step without a stored
   benchmark model has an unknown benchmark. */

import { sql, type ActivityDb, type Sql } from "./sql.js";
import { THINKING_LEVEL, thinkingLevelValue, type ReasoningEffort } from "./shared.js";
import { addDecimals, formatDecimal, parseDecimal, readInt, readOptionalString, subtractDecimals, type Decimal } from "./values.js";

const ZERO: Decimal = { coefficient: 0n, exponent: 0 };

/** What a group of steps cost and what its benchmark would have. Read with `groupSavings`. */
const TOTALS = sql`
  count(*) as priced_rows,
  count(r.benchmark_replay_cost_usd) as estimated_rows,
  cast(sum(r.benchmark_replay_cost_usd) as text) as benchmark_total,
  cast(sum(r.provider_total_cost_usd) as text) as provider_total,
  cast(sum(case when r.model_switched is true and r.benchmark_replay_cost_usd - r.provider_total_cost_usd < 0
                then r.benchmark_replay_cost_usd - r.provider_total_cost_usd else 0 end) as text) as nonpositive_total`;

/** The steps with a known price: the ones savings counts. */
const PRICED = sql`
  r.selected_model is not null
  and r.selected_provider is not null
  and r.provider_pricing_known is true
  and r.provider_total_cost_usd is not null`;

type SavingsRow = {
  model: unknown;
  benchmark_model: unknown;
  priced_rows: unknown;
  estimated_rows: unknown;
  benchmark_total: unknown;
  provider_total: unknown;
  nonpositive_total: unknown;
};

/** A group's savings, or null when some step has no benchmark cost. */
function groupSavings(row: SavingsRow): Decimal | null {
  if (readInt(row.estimated_rows) !== readInt(row.priced_rows) || row.benchmark_total === null) return null;
  // A benchmark-model step's counterfactual is the step itself: only the
  // overspend of switching back onto it counts.
  if (readOptionalString(row.benchmark_model) === String(row.model)) {
    return parseDecimal(String(row.nonpositive_total ?? 0));
  }
  return subtractDecimals(parseDecimal(String(row.benchmark_total)), parseDecimal(String(row.provider_total)));
}

export type ModelSavings = {
  /** Keyed by `routeKey`. */
  byModel: Map<string, string>;
  total: string | null;
};

export function routeKey(model: string, thinkingLevel: ReasoningEffort | null, provider: string): string {
  return JSON.stringify([model, thinkingLevel, provider]);
}

/** Savings per model, thinking level, and provider, and in total. */
export async function loadSavings(db: ActivityDb, criteria: Sql): Promise<ModelSavings> {
  const rows = await db.all<SavingsRow & { thinking_level: unknown; provider: unknown }>(sql`
    select
      r.router_id,
      r.selected_model as model,
      ${THINKING_LEVEL} as thinking_level,
      r.selected_provider as provider,
      r.benchmark_model_id as benchmark_model,
      ${TOTALS}
    from routing_requests r
    where ${criteria}
      and ${PRICED}
    group by 1, 2, 3, 4, 5`);
  const byModel = new Map<string, Decimal>();
  const incomplete = new Set<string>();
  let total = ZERO;
  let complete = rows.length > 0;
  for (const row of rows) {
    const key = routeKey(String(row.model), thinkingLevelValue(row.thinking_level), String(row.provider));
    const value = groupSavings(row);
    if (value === null) {
      complete = false;
      incomplete.add(key);
      continue;
    }
    byModel.set(key, addDecimals(byModel.get(key) ?? ZERO, value));
    total = addDecimals(total, value);
  }
  const result = new Map<string, string>();
  for (const [key, value] of byModel) if (!incomplete.has(key)) result.set(key, formatDecimal(value));
  return { byModel: result, total: complete ? formatDecimal(total) : null };
}

/** Savings per router; null for a router with a step lacking a benchmark cost. */
export async function loadRouterSavings(db: ActivityDb, criteria: Sql): Promise<Map<string, string | null>> {
  const rows = await db.all<SavingsRow & { router_id: unknown }>(sql`
    select
      r.router_id,
      r.selected_model as model,
      r.benchmark_model_id as benchmark_model,
      ${TOTALS}
    from routing_requests r
    where ${criteria}
      and ${PRICED}
      and r.router_id is not null
    group by 1, 2, 3`);
  const totals = new Map<string, Decimal>();
  const incomplete = new Set<string>();
  for (const row of rows) {
    const routerId = String(row.router_id);
    const value = groupSavings(row);
    if (value === null) {
      incomplete.add(routerId);
      continue;
    }
    totals.set(routerId, addDecimals(totals.get(routerId) ?? ZERO, value));
  }
  const result = new Map<string, string | null>();
  for (const [routerId, value] of totals) result.set(routerId, incomplete.has(routerId) ? null : formatDecimal(value));
  for (const routerId of incomplete) result.set(routerId, null);
  return result;
}
