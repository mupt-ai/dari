import { expect, test } from "bun:test";

import { FIXED_TURN_COST_COMPARISON_TURNS } from "../src/fixed_turn_cost_config.js";

import {
  MIN_SWITCH_SAVINGS_RATIO,
  pruneSwitchCandidates,
} from "../src/candidate_pruning.js";
import type {
  CandidateCostEstimate,
  ReasoningEffort,
  RoutingCandidate,
} from "../src/types.js";

function candidate(
  model: string,
  reasoningEffort: ReasoningEffort = "medium",
): RoutingCandidate {
  return { model, reasoningEffort };
}

function estimate(
  model: string,
  cost: number | null,
  options: {
    effort?: ReasoningEffort;
    warmTokens?: number;
    outputPrice?: number | null;
  } = {},
): CandidateCostEstimate {
  const effort = options.effort ?? "medium";
  return {
    model,
    reasoning_effort: effort,
    warm_tokens: options.warmTokens ?? 0,
    est_prompt_tokens: 1000,
    est_input_cost_usd: 0.01,
    output_cost_per_mtok: options.outputPrice ?? 10,
    pricing_known: true,
    fixed_turn_cost_estimate:
      cost === null
        ? null
        : {
            output_tokens_per_turn: 1000,
            assumed_reasoning_effort: effort,
            cold_start_usd: 0,
            projections: [
              {
                projected_turns: FIXED_TURN_COST_COMPARISON_TURNS,
                total_cost_usd: cost,
              },
            ],
          },
  };
}

test("prunes a fake-cheap cold pair against the exact warm incumbent", () => {
  const candidates = [candidate("warm", "high"), candidate("cold", "low")];
  const result = pruneSwitchCandidates({
    candidates,
    costEstimates: [
      estimate("warm", 1, {
        effort: "high",
        warmTokens: 1000,
        outputPrice: 20,
      }),
      estimate("cold", 0.95, { effort: "low", outputPrice: 5 }),
    ],
    previousDecision: {
      model: "warm",
      reasoningEffort: "high",
      reason: "stay",
    },
    minSwitchSavingsRatio: MIN_SWITCH_SAVINGS_RATIO,
  });

  expect(result.candidates).toEqual([candidate("warm", "high")]);
  expect(result.audit).toMatchObject({
    incumbent_model: "warm",
    incumbent_reasoning_effort: "high",
    skip_reason: null,
    pruned_candidates: [
      {
        model: "cold",
        reasoning_effort: "low",
        fixed_turn_cost_usd: 0.95,
      },
    ],
  });
});

test("keeps a cold pair whose projected savings clear the threshold", () => {
  const candidates = [candidate("warm"), candidate("cold", "off")];
  const result = pruneSwitchCandidates({
    candidates,
    costEstimates: [
      estimate("warm", 1, { warmTokens: 1000, outputPrice: 20 }),
      estimate("cold", 0.5, { effort: "off", outputPrice: 5 }),
    ],
    previousDecision: {
      model: "warm",
      reasoningEffort: "medium",
      reason: "stay",
    },
    minSwitchSavingsRatio: MIN_SWITCH_SAVINGS_RATIO,
  });

  expect(result.candidates).toEqual(candidates);
  expect(result.audit.pruned_candidates).toEqual([]);
  expect(result.audit.kept_candidates).toContainEqual({
    model: "cold",
    reasoning_effort: "off",
    reason: "saves_more_than_threshold",
    savings_ratio: 0.5,
  });
});

test("prunes a same-model lower-effort switch when its cold start erases the savings", () => {
  const candidates = [candidate("sol", "high"), candidate("sol", "xhigh")];
  const result = pruneSwitchCandidates({
    candidates,
    costEstimates: [
      estimate("sol", 1.79, { effort: "high", outputPrice: 30 }),
      estimate("sol", 1.07, {
        effort: "xhigh",
        warmTokens: 120_000,
        outputPrice: 30,
      }),
    ],
    previousDecision: {
      model: "sol",
      reasoningEffort: "xhigh",
      reason: "stay warm",
    },
    minSwitchSavingsRatio: MIN_SWITCH_SAVINGS_RATIO,
  });

  expect(result.candidates).toEqual([candidate("sol", "xhigh")]);
  expect(result.costEstimates.map((item) => item.reasoning_effort)).toEqual([
    "xhigh",
  ]);
  expect(result.audit.pruned_candidates).toEqual([
    {
      model: "sol",
      reasoning_effort: "high",
      fixed_turn_cost_usd: 1.79,
      savings_ratio: expect.closeTo((1.07 - 1.79) / 1.07),
    },
  ]);
});

test("keeps a same-model higher-effort capability upgrade", () => {
  const candidates = [candidate("sol", "high"), candidate("sol", "xhigh")];
  const result = pruneSwitchCandidates({
    candidates,
    costEstimates: [
      estimate("sol", 1, {
        effort: "high",
        warmTokens: 10_000,
        outputPrice: 30,
      }),
      estimate("sol", 1.5, { effort: "xhigh", outputPrice: 30 }),
    ],
    previousDecision: {
      model: "sol",
      reasoningEffort: "high",
      reason: "stay warm",
    },
    minSwitchSavingsRatio: MIN_SWITCH_SAVINGS_RATIO,
  });

  expect(result.candidates).toEqual(candidates);
  expect(result.audit.kept_candidates).toContainEqual({
    model: "sol",
    reasoning_effort: "xhigh",
    reason: "same_model_upgrade",
  });
});

test("keeps a same-model lower-effort switch with material projected savings", () => {
  const candidates = [candidate("sol", "high"), candidate("sol", "xhigh")];
  const result = pruneSwitchCandidates({
    candidates,
    costEstimates: [
      estimate("sol", 0.7, { effort: "high", outputPrice: 30 }),
      estimate("sol", 1, {
        effort: "xhigh",
        warmTokens: 10_000,
        outputPrice: 30,
      }),
    ],
    previousDecision: {
      model: "sol",
      reasoningEffort: "xhigh",
      reason: "stay warm",
    },
    minSwitchSavingsRatio: MIN_SWITCH_SAVINGS_RATIO,
  });

  expect(result.candidates).toEqual(candidates);
  expect(result.audit.kept_candidates).toContainEqual({
    model: "sol",
    reasoning_effort: "high",
    reason: "saves_more_than_threshold",
    savings_ratio: expect.closeTo(0.3),
  });
});

test("does not mistake another effort on the same model for the incumbent", () => {
  const candidates = [candidate("same", "medium"), candidate("same", "high")];
  const result = pruneSwitchCandidates({
    candidates,
    costEstimates: [
      estimate("same", 1, { effort: "medium", warmTokens: 1000 }),
      estimate("same", 2, { effort: "high", warmTokens: 0 }),
    ],
    previousDecision: {
      model: "same",
      reasoningEffort: "high",
      reason: "high",
    },
    minSwitchSavingsRatio: MIN_SWITCH_SAVINGS_RATIO,
  });

  expect(result.candidates).toEqual(candidates);
  expect(result.audit.skip_reason).toBe("incumbent_not_warm");
});

test("skips pruning without a previous pair", () => {
  const candidates = [candidate("a"), candidate("b")];
  const result = pruneSwitchCandidates({
    candidates,
    costEstimates: [estimate("a", 1), estimate("b", 0.95)],
    minSwitchSavingsRatio: MIN_SWITCH_SAVINGS_RATIO,
  });

  expect(result.candidates).toEqual(candidates);
  expect(result.audit.skip_reason).toBe("no_previous_decision");
});

test("skips pruning when incumbent cost is unknown", () => {
  const candidates = [candidate("a"), candidate("b")];
  const result = pruneSwitchCandidates({
    candidates,
    costEstimates: [
      estimate("a", null, { warmTokens: 1000 }),
      estimate("b", 0.5),
    ],
    previousDecision: {
      model: "a",
      reasoningEffort: "medium",
      reason: "a",
    },
    minSwitchSavingsRatio: MIN_SWITCH_SAVINGS_RATIO,
  });

  expect(result.candidates).toEqual(candidates);
  expect(result.audit.skip_reason).toBe("incumbent_unpriced");
});

test("keeps higher output-price capability upgrades", () => {
  const candidates = [candidate("warm"), candidate("upgrade", "high")];
  const result = pruneSwitchCandidates({
    candidates,
    costEstimates: [
      estimate("warm", 1, { warmTokens: 1000, outputPrice: 5 }),
      estimate("upgrade", 0.95, { effort: "high", outputPrice: 20 }),
    ],
    previousDecision: {
      model: "warm",
      reasoningEffort: "medium",
      reason: "warm",
    },
    minSwitchSavingsRatio: MIN_SWITCH_SAVINGS_RATIO,
  });

  expect(result.candidates).toEqual(candidates);
});
