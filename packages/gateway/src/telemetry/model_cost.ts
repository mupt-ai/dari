import type { RoutingBillingProviderAttemptFacts } from "./billing_finalization.js";

/** Model reference cost only, including retries; unknown/estimated usage is never free. */
export function modelCost(attempts: readonly RoutingBillingProviderAttemptFacts[]): number | null {
  if (attempts.length === 0) return null;
  let total = 0;
  for (const attempt of attempts) {
    if (!attempt.provider_pricing_known || attempt.usage_estimated || attempt.provider_cost_usd === null) return null;
    const cost = Number(attempt.provider_cost_usd);
    if (!Number.isFinite(cost) || cost < 0) return null;
    total += cost;
  }
  return Number.isFinite(total) ? total : null;
}
