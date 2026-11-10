import { expect, test } from "bun:test";
import { estimateCandidateCosts } from "../src/cost.js";
import { assignAnonymousActions, anonymizeSelectorInput, buildAnonymousPolicyPrompt } from "../src/anonymous_actions.js";
import { FIXED_TURN_COST_PROJECTED_TURNS } from "../src/fixed_turn_cost_config.js";
import { routingCandidateKey, type ReasoningEffort } from "../src/types.js";

for (const provider of [undefined, "xai", "openrouter", "azure", "custom-provider"]) {
  for (const outputTokens of [0, 465]) {
    test(`${provider ?? "model-owner inference"}: priced candidates retain projections and selector costs (${outputTokens} output tokens)`, () => {
      const candidates = ["xai/grok-4.6", "custom-owner/future-model"].map((model) => ({
        model, reasoningEffort: "high" as ReasoningEffort,
      }));
      const costs = estimateCandidateCosts({
        candidates,
        hits: { perModel: new Map(), perModelBuckets: new Map() },
        incomingProviderBlockCountFor: () => 1,
        promptEstimatesByCandidate: new Map(candidates.map((candidate) => [
          routingCandidateKey(candidate), { chars: 8000, reusesStoredPromptTokens: false },
        ])),
        toolChoiceFp: "", responseFormatFp: "",
        // Cache prices must not imply a cache policy we do not have.
        pricing: () => ({ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 3 }),
        averageOutputTokensByModel: Object.fromEntries(candidates.map(({ model }) => [model, { high: outputTokens }])),
        modelProvider: provider === undefined ? undefined : () => provider,
      });
      for (const cost of costs) {
        expect(cost.pricing_known).toBe(true);
        expect(cost.fixed_turn_cost_estimate?.output_tokens_per_turn).toBe(outputTokens);
        expect(cost.fixed_turn_cost_estimate?.projections.map(p => p.projected_turns)).toEqual([...FIXED_TURN_COST_PROJECTED_TURNS]);
        for (const turns of FIXED_TURN_COST_PROJECTED_TURNS) {
          const inputTokens = turns * 2000 + outputTokens * turns * (turns - 1) / 2;
          let expected = (inputTokens * 2 + turns * outputTokens * 6) / 1e6;
          const nativeXai = provider === "xai" || (provider === undefined && cost.model.startsWith("xai/"));
          if (nativeXai) {
            // Synthetic cache-write pricing in this fixture applies on misses.
            expected = (inputTokens * 3 + turns * outputTokens * 6) / 1e6;
            for (let turn = 2; turn <= turns; turn++) {
              const reusable = Math.floor((2000 + (turn - 2) * outputTokens) / 128) * 128;
              expected -= 0.9 * reusable * (3 - 0.5) / 1e6;
            }
          }
          expect(cost.fixed_turn_cost_estimate?.projections.find(p => p.projected_turns === turns)?.total_cost_usd)
            .toBeCloseTo(expected, 12);
        }
      }
      const slots = assignAnonymousActions(candidates, () => 0.5);
      const anonymous = anonymizeSelectorInput({
        candidate_pairs: candidates.map(c => ({ model: c.model, thinking_level: c.reasoningEffort })),
        cost_estimates: JSON.parse(JSON.stringify(costs)), imported_evals: [],
        previous_decision: null, task: null, lease_history: [], messages: [],
      }, slots);
      expect(anonymous.cost_estimates).toHaveLength(candidates.length);
      const prompt = buildAnonymousPolicyPrompt(anonymous, slots).messages[1].content;
      expect(prompt.match(/- Cold start cost:/g)).toHaveLength(candidates.length);
      expect(prompt.match(/- Per turn cost:/g)).toHaveLength(candidates.length);
    });
  }
}

test("native xAI cache assumptions stay scoped and honor small observed prefixes", async () => {
  const { promptCacheProviderForModel, providerCacheableTokens, providerMinCacheTokens } = await import("../src/cache_behavior.js");
  expect(promptCacheProviderForModel("xai/grok-4.6", "xai")).toBe("xai");
  expect(promptCacheProviderForModel("xai/grok-4.6", "azure")).toBeNull();
  expect(promptCacheProviderForModel("xai/grok-4.6", "openrouter")).toBeNull();
  expect(providerMinCacheTokens("xai/grok-4.6", "xai")).toBe(640);
  expect(providerCacheableTokens("xai/grok-4.6", "xai", 639)).toBe(0);
  expect(providerCacheableTokens("xai/grok-4.6", "xai", 705)).toBe(640);
  expect(providerCacheableTokens("xai/grok-4.6", "xai", 3278)).toBe(3200);
});
