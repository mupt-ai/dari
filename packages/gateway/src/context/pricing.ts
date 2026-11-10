import type { ModelPricing, PricingLookup } from "@mupt-ai/dari-router/policy-engine";
import { registeredModelPrice } from "../providers/pi.js";
import type { ResolvedRouter } from "../types.js";

export function pricingLookupForRouter(credentials: ResolvedRouter): PricingLookup {
  return (model: string): ModelPricing | null => modelPricingForRouter(credentials, model);
}

export function modelPricingForRouter(
  credentials: ResolvedRouter,
  model: string,
): ModelPricing | null {
  // A model the platform neither prices nor configures is served from Pi's
  // catalog (see buildModel), so its catalog price is the one it is billed at.
  const price = credentials.model_prices?.[model]
    ?? (credentials.model_configs?.[model] === undefined ? registeredModelPrice(model) : null);
  if (!price || typeof price.input !== "number" || typeof price.output !== "number") return null;
  // Null cached rates mean the provider publishes none: bill cached prompt
  // buckets at the input rate, never for free.
  return {
    input: price.input,
    output: price.output,
    cacheRead: price.cached_input ?? price.input,
    cacheWrite: price.cache_write ?? price.input,
    ...(price.tiers?.length ? { tiers: price.tiers.map((tier) => ({
      inputTokensAbove: tier.input_tokens_above,
      input: tier.input,
      output: tier.output,
      cacheRead: tier.cached_input ?? tier.input,
      cacheWrite: tier.cache_write ?? tier.input,
    })) } : {}),
  };
}
