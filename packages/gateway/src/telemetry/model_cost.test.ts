import { expect, test } from "bun:test";
import { modelCost } from "./model_cost.js";
import { routingBillingProviderAttemptFacts } from "./billing_finalization.js";

function attempt(cost: number, outcome: "completed" | "provider_failed" = "completed") {
  return routingBillingProviderAttemptFacts({ provider: "openai", model: "openai/gpt-6.1-sol",
    providerKeySource: "user", attempt: 1, outcome,
    providerMessage: null, providerPricingKnown: true,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
  });
}

test("response cost includes charged failed attempts and the successful retry", () => {
  expect(modelCost([attempt(0.02, "provider_failed"), attempt(0.03)])).toBe(0.05);
  expect(modelCost([attempt(0)])).toBe(0);
});

test("unknown, estimated and absent usage is never returned as zero", () => {
  expect(modelCost([])).toBeNull();
  expect(modelCost([{ ...attempt(0.01), usage_estimated: true }])).toBeNull();
  expect(modelCost([{ ...attempt(0.01), provider_pricing_known: false }])).toBeNull();
  expect(modelCost([{ ...attempt(0.01, "provider_failed"), provider_cost_usd: null,
    provider_input_tokens: null, provider_output_tokens: null,
    provider_cache_read_tokens: null, provider_cache_write_tokens: null }])).toBeNull();
  expect(modelCost([{ ...attempt(0, "provider_failed"), provider_cost_usd: null,
    provider_input_tokens: 0, provider_output_tokens: 0, provider_cache_read_tokens: 0, provider_cache_write_tokens: 0 }])).toBeNull();
});
