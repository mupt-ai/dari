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

test("keeps exact rule/default pairs and drops unavailable levels", () => {
  const resolved = resolveCustom({
    config: CONFIG,
    candidates: [
      candidate("expensive", "medium"),
      candidate("expensive", "high"),
      candidate("cheap", "off"),
    ],
    costEstimates: [
      estimate("expensive", "medium", 2),
      estimate("expensive", "high", 3),
      estimate("cheap", "off", 1),
    ],
    modelPrices: {
      expensive: { input: 3, output: 10 },
      cheap: { input: 1, output: 2 },
    },
  });

  expect(resolved.candidates).toEqual([
    candidate("expensive", "high"),
    candidate("cheap", "off"),
  ]);
  expect(resolved.custom.rules).toEqual([
    { when: "plan", use: "expensive", thinking_level: "high" },
  ]);
  expect(resolved.custom.defaultTarget).toEqual({
    model: "cheap",
    thinkingLevel: "off",
  });
  expect(resolved.custom.audit.dropped_rules).toEqual([
    { when: "implement", use: "cheap", thinking_level: "medium" },
  ]);
});

test("omitted and null rule thinking levels include every enabled pair for the model", () => {
  const resolved = resolveCustom({
    config: {
      rules: [
        { when: "legacy auto", use: "model" },
        { when: "explicit auto", use: "other", thinking_level: null },
      ],
      default: null,
    },
    candidates: [
      candidate("model", "low"),
      candidate("model", "high"),
      candidate("other", "medium"),
      candidate("unrelated", "off"),
    ],
    costEstimates: [
      estimate("model", "low", 1),
      estimate("model", "high", 2),
      estimate("other", "medium", 1.5),
      estimate("unrelated", "off", 0.5),
    ],
    modelPrices: {
      model: { input: 2, output: 10 },
      other: { input: 1, output: 5 },
      unrelated: { input: 0.5, output: 1 },
    },
  });

  expect(resolved.candidates).toEqual([
    candidate("model", "low"),
    candidate("model", "high"),
    candidate("other", "medium"),
  ]);
  expect(resolved.custom.rules).toEqual([
    { when: "legacy auto", use: "model" },
    { when: "explicit auto", use: "other", thinking_level: null },
  ]);
  expect(resolved.custom.audit.dropped_rules).toEqual([]);
});

test("Auto fallback includes every enabled pair for its model", () => {
  const resolved = resolveCustom({
    config: {
      rules: [
        { when: "fast fallback requests", use: "fallback", thinking_level: "off" },
      ],
      default: "fallback",
      default_thinking_level: null,
    },
    candidates: [
      candidate("fallback", "off"),
      candidate("fallback", "high"),
      candidate("unrelated", "medium"),
    ],
    costEstimates: [
      estimate("fallback", "off", 1),
      estimate("fallback", "high", 2),
      estimate("unrelated", "medium", 0.5),
    ],
    modelPrices: {
      fallback: { input: 2, output: 10 },
      unrelated: { input: 1, output: 2 },
    },
  });

  expect(resolved.candidates).toEqual([
    candidate("fallback", "off"),
    candidate("fallback", "high"),
  ]);
  expect(resolved.custom.defaultTarget).toEqual({
    model: "fallback",
    thinkingLevel: null,
  });
});

test("same model at the wrong thinking level is not routable for a rule", () => {
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

  expect(resolved.candidates).toEqual([]);
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

test("an incumbent outside the custom rule scope cannot prune rule candidates", () => {
  const resolved = resolveCustom({
    config: {
      rules: [{ when: "allowed", use: "allowed", thinking_level: "medium" }],
    },
    candidates: [candidate("unreferenced", "medium"), candidate("allowed", "medium")],
    costEstimates: [
      estimate("unreferenced", "medium", 1, 1000, 20),
      estimate("allowed", "medium", 0.95, 0, 5),
    ],
    previousDecision: {
      model: "unreferenced",
      reasoningEffort: "medium",
      reason: "prior route",
    },
    modelPrices: {
      unreferenced: { input: 2, output: 20 },
      allowed: { input: 1, output: 5 },
    },
  });

  expect(resolved.candidates).toEqual([candidate("allowed", "medium")]);
  expect(resolved.pruning.skip_reason).toBe("no_previous_decision");
  expect(resolved.pruning.pruned_candidates).toEqual([]);
});

test("custom routing fails closed instead of adding unrelated candidates", () => {
  const resolved = resolveCustom({
    config: CONFIG,
    candidates: [candidate("unrelated", "medium")],
    costEstimates: [estimate("unrelated", "medium", 1)],
    modelPrices: { unrelated: { input: 1, output: 1 } },
  });

  expect(resolved.candidates).toEqual([]);
  expect(resolved.custom.audit.fallback_all_candidates).toBe(false);
  expect(resolved.custom.audit.no_routable_rule_models).toBe(true);
});
