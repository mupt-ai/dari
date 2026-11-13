import { expect, test } from "bun:test";

import { FIXED_TURN_COST_COMPARISON_TURNS } from "../src/fixed_turn_cost_config.js";

import { resolveStrategyCandidates } from "../src/candidate_resolution.js";
import type {
  CandidateCostEstimate,
  CustomRouterConfig,
  PreviousDecision,
  ReasoningEffort,
  RouterModelPrice,
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
  effort: ReasoningEffort,
  cost: number,
  warmTokens = 0,
  outputPrice = 10,
): CandidateCostEstimate {
  return {
    model,
    reasoning_effort: effort,
    warm_tokens: warmTokens,
    est_prompt_tokens: 1000,
    est_input_cost_usd: 0.01,
    output_cost_per_mtok: outputPrice,
    pricing_known: true,
    fixed_turn_cost_estimate: {
      output_tokens_per_turn: 1000,
      assumed_reasoning_effort: effort,
      cold_start_usd: 0,
      projections: [
        { projected_turns: FIXED_TURN_COST_COMPARISON_TURNS, total_cost_usd: cost },
      ],
    },
  };
}

function resolveCustom(args: {
  config: CustomRouterConfig;
  candidates: RoutingCandidate[];
  costEstimates: CandidateCostEstimate[];
  previousDecision?: PreviousDecision;
  modelPrices: Record<string, RouterModelPrice>;
}) {
  const resolution = resolveStrategyCandidates({
    strategy: "custom",
    candidates: args.candidates,
    costEstimates: args.costEstimates,
    previousDecision: args.previousDecision,
    customConfig: args.config,
    modelPrices: args.modelPrices,
  });
  if (resolution.strategy !== "custom" || !resolution.custom) {
    throw new Error("Expected configured custom candidate resolution");
  }
  return { ...resolution, custom: resolution.custom };
}

const CONFIG: CustomRouterConfig = {
  rules: [
    { when: "plan", use: "expensive", thinking_level: "high" },
    { when: "implement", use: "cheap", thinking_level: "medium" },
  ],
  default: "cheap",
  default_thinking_level: "off",
};

test("applies cache switch pruning to Dari candidates", () => {
  const candidates = [candidate("warm", "high"), candidate("cold", "low")];
  const resolution = resolveStrategyCandidates({
    strategy: "dari",
    candidates,
    costEstimates: [
      estimate("warm", "high", 1, 1000, 20),
      estimate("cold", "low", 0.95, 0, 5),
    ],
    previousDecision: {
      model: "warm",
      reasoningEffort: "high",
      reason: "stay",
    },
    modelPrices: {},
  });

  expect(resolution.candidates).toEqual([candidate("warm", "high")]);
});

test("rules steer without narrowing the candidates", () => {
  const resolved = resolveCustom({
    config: CONFIG,
    candidates: [
      candidate("cheap", "off"),
      candidate("expensive", "medium"),
      candidate("expensive", "high"),
      candidate("unrelated", "medium"),
    ],
    costEstimates: [
      estimate("cheap", "off", 1),
      estimate("expensive", "medium", 2),
      estimate("expensive", "high", 3),
      estimate("unrelated", "medium", 0.5),
    ],
    modelPrices: {
      expensive: { input: 3, output: 10 },
      cheap: { input: 1, output: 2 },
      unrelated: { input: 0.5, output: 1 },
    },
  });

  // Every candidate stays routable, most expensive first.
  expect(resolved.candidates).toEqual([
    candidate("expensive", "medium"),
    candidate("expensive", "high"),
    candidate("cheap", "off"),
    candidate("unrelated", "medium"),
  ]);
  expect(resolved.custom.rules).toEqual([
    { when: "plan", use: "expensive", thinking_level: "high" },
  ]);
  expect(resolved.custom.defaultTarget).toEqual({
    model: "cheap",
    thinkingLevel: "off",
  });
  // No candidate serves cheap at medium.
  expect(resolved.custom.audit.dropped_rules).toEqual([
    { when: "implement", use: "cheap", thinking_level: "medium" },
  ]);
});

test("omitted and null rule thinking levels match every enabled pair for the model", () => {
  const resolved = resolveCustom({
    config: {
      rules: [
        { when: "legacy auto", use: "model" },
        { when: "explicit auto", use: "other", thinking_level: null },
      ],
      default: null,
    },
    candidates: [candidate("model", "low"), candidate("model", "high"), candidate("other", "medium")],
    costEstimates: [
      estimate("model", "low", 1),
      estimate("model", "high", 2),
      estimate("other", "medium", 1.5),
    ],
    modelPrices: {
      model: { input: 2, output: 10 },
      other: { input: 1, output: 5 },
    },
  });

  expect(resolved.custom.rules).toEqual([
    { when: "legacy auto", use: "model" },
    { when: "explicit auto", use: "other", thinking_level: null },
  ]);
  expect(resolved.custom.audit.dropped_rules).toEqual([]);
});

test("a rule whose pair no candidate serves is dropped", () => {
  const resolved = resolveCustom({
    config: {
      rules: [{ when: "deep", use: "model", thinking_level: "high" }],
      default: null,
      default_thinking_level: null,
    },
    candidates: [candidate("model", "medium")],
    costEstimates: [estimate("model", "medium", 1)],
    modelPrices: { model: { input: 1, output: 2 } },
  });

  expect(resolved.candidates).toEqual([candidate("model", "medium")]);
  expect(resolved.custom.rules).toEqual([]);
  expect(resolved.custom.audit.no_routable_rule_models).toBe(true);
});

test("cache pruning uses exact previous pair and removes rules for pruned pairs", () => {
  const resolved = resolveCustom({
    config: {
      rules: [
        { when: "stay", use: "warm", thinking_level: "high" },
        { when: "switch", use: "cold", thinking_level: "low" },
      ],
      default: "cold",
      default_thinking_level: "low",
    },
    candidates: [candidate("warm", "high"), candidate("cold", "low")],
    costEstimates: [
      estimate("warm", "high", 1, 1000, 20),
      estimate("cold", "low", 0.95, 0, 5),
    ],
    previousDecision: {
      model: "warm",
      reasoningEffort: "high",
      reason: "stay",
    },
    modelPrices: {
      warm: { input: 2, output: 20 },
      cold: { input: 1, output: 5 },
    },
  });

  expect(resolved.candidates).toEqual([candidate("warm", "high")]);
  expect(resolved.custom.rules).toEqual([
    { when: "stay", use: "warm", thinking_level: "high" },
  ]);
  expect(resolved.custom.defaultTarget).toBeNull();
  expect(resolved.pruning.pruned_candidates).toMatchObject([
    { model: "cold", reasoning_effort: "low" },
  ]);
});
