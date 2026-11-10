import { expect, test } from "bun:test";
import { calculateCost } from "@mupt-ai/pi-ai";
import { buildModel, piFixture } from "./pi.fixtures.js";
import { modelPricingForRouter } from "../context/pricing.js";
import { estimateBenchmarkReplay } from "../telemetry/benchmark_replay.js";
import type { ResolvedRouterModelConfig } from "../types.js";

const config: ResolvedRouterModelConfig = {
  provider: "openai", native_model_id: "gpt-6-astra", api: "openai-responses",
  context_window: 1_050_000, standard_context_limit: 272_000,
  cost: { input: 10, output: 50, cached_input: 1, cache_write: 12.5,
    tiers: [{ input_tokens_above: 272_000, input: 20, output: 75, cached_input: 2, cache_write: 25 }] },
};

test("execution preserves tiers and opt-in restores the full window", () => {
  const model = buildModel(piFixture, "openai/gpt-6-astra", null, { ...config, allow_long_context: true });
  expect(model.contextWindow).toBe(1_050_000);
  expect(buildModel(piFixture, "openai/gpt-6-astra", null, config).contextWindow).toBe(272_000);
  const usage = { input: 1, cacheRead: 272_000, cacheWrite: 0, output: 1, totalTokens: 272_002,
    cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 } };
  calculateCost(model as unknown as Parameters<typeof calculateCost>[0], usage);
  expect(usage.cost.input).toBeCloseTo(20 / 1e6, 10);
  expect(usage.cost.cacheRead).toBeCloseTo(0.544, 10);
  expect(usage.cost.output).toBeCloseTo(75 / 1e6, 10);
});

test("routing and savings replay retain full-prompt tier prices", () => {
  const model = "openai/gpt-6-astra";
  const price = modelPricingForRouter({ router_id: "test", organization_id: "test", api_key_id: null,
    attributed_user_id: null, enabled_models: [model], provider_keys: {}, model_prices: { [model]: config.cost } }, model);
  expect(price?.tiers?.[0]?.cacheRead).toBe(2);
  const result = estimateBenchmarkReplay({
    enabledModels: [model], modelPrices: { [model]: config.cost }, executionProvider: () => "openai",
    receivedAtMs: 0, promptTokens: 300_000, outputTokens: 1_000,
  });
  expect(result.costUsd).toBeCloseTo(7.575, 10);
});
