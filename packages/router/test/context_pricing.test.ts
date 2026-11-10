import { expect, test } from "bun:test";
import { pricingForPrompt, estimateCandidateCosts, type ModelPricing } from "../src/cost.js";
import { routingCandidateKey } from "../src/types.js";

const price: ModelPricing = {
  input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5,
  tiers: [{ inputTokensAbove: 272_000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }],
};

test("long-context rates apply to every bucket only above the threshold", () => {
  expect(pricingForPrompt(price, 272_000)).toBe(price);
  expect(pricingForPrompt(price, 272_001)).toBe(price.tiers![0]!);
  expect(pricingForPrompt({ ...price, tiers: undefined }, 900_000).input).toBe(4);
});

test("candidate estimates and projected turns cross pricing tiers", () => {
  const model = "openai/gpt-5.6-sol";
  const estimate = estimateCandidateCosts({
    candidates: [{ model, reasoningEffort: "off" }],
    hits: { perModel: new Map(), perModelBuckets: new Map() },
    incomingProviderBlockCountFor: () => 1,
    promptEstimatesByCandidate: new Map([[routingCandidateKey({ model, reasoningEffort: "off" }), { chars: 272_001 * 4, reusesStoredPromptTokens: false }]]),
    toolChoiceFp: "", responseFormatFp: "", pricing: () => price,
    averageOutputTokensByModel: { [model]: { off: 100 } },
  });
  expect(estimate[0]!.output_cost_per_mtok).toBe(30);
  expect(estimate[0]!.est_input_cost_usd).toBeGreaterThan(2);
});

test("future projections switch rates after a short first request", () => {
  const model = "custom/model";
  const estimates = (pricing: ModelPricing) => estimateCandidateCosts({
    candidates: [{ model, reasoningEffort: "off" }],
    hits: { perModel: new Map(), perModelBuckets: new Map() },
    incomingProviderBlockCountFor: () => 1,
    promptEstimatesByCandidate: new Map([[routingCandidateKey({ model, reasoningEffort: "off" }), { chars: 272_000 * 4, reusesStoredPromptTokens: false }]]),
    toolChoiceFp: "", responseFormatFp: "", pricing: () => pricing,
    averageOutputTokensByModel: { [model]: { off: 100 } },
  })[0]!;
  const tiered = estimates(price);
  const flat = estimates({ ...price, tiers: undefined });
  expect(tiered.est_input_cost_usd).toBe(flat.est_input_cost_usd);
  expect(tiered.fixed_turn_cost_estimate!.projections[0]!.total_cost_usd)
    .toBeGreaterThan(flat.fixed_turn_cost_estimate!.projections[0]!.total_cost_usd);
});
