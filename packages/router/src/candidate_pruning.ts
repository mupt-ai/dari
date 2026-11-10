// Cache-aware pruning for selector-based routing strategies. When the previous
// model/thinking-level pair is still warm, a nominally cheaper pair can be a
// fake-cheap switch: the cold start erases most of the sticker-price saving.

import {
  decideCacheSwitch,
  type CacheSwitchDecision,
} from "./cache_switch_decision.js";
import { turnCostUsdAt } from "./cost.js";
import { FIXED_TURN_COST_COMPARISON_TURNS } from "./fixed_turn_cost_config.js";
import {
  REASONING_EFFORTS,
  routingCandidateKey,
  type CandidateCostEstimate,
  type PreviousDecision,
  type ReasoningEffort,
  type RoutingCandidate,
} from "./types.js";

export const MIN_SWITCH_SAVINGS_RATIO = 0.1;

type PrunedCandidate = {
  model: string;
  reasoning_effort: ReasoningEffort;
  fixed_turn_cost_usd: number;
  savings_ratio: number;
};

type CandidateSwitchKeepDecision = {
  action: "keep";
  reason:
    | Extract<CacheSwitchDecision, { action: "keep" }>["reason"]
    | "same_model_upgrade";
  fixedTurnCostUsd?: number;
  savingsRatio?: number;
};

type CandidateSwitchDecision =
  | CandidateSwitchKeepDecision
  | Extract<CacheSwitchDecision, { action: "prune" }>;

type KeptReason = "incumbent" | CandidateSwitchKeepDecision["reason"];

type KeptCandidate = {
  model: string;
  reasoning_effort: ReasoningEffort;
  reason: KeptReason;
  savings_ratio?: number;
};

export type CandidatePruningAudit = {
  min_switch_savings_ratio: number;
  incumbent_model: string | null;
  incumbent_reasoning_effort: ReasoningEffort | null;
  incumbent_fixed_turn_cost_usd: number | null;
  skip_reason:
    | "no_previous_decision"
    | "incumbent_not_warm"
    | "incumbent_unpriced"
    | null;
  pruned_candidates: PrunedCandidate[];
  kept_candidates: KeptCandidate[];
};

export type CandidatePruning = {
  candidates: RoutingCandidate[];
  costEstimates: CandidateCostEstimate[];
  audit: CandidatePruningAudit;
};

export function pruneSwitchCandidates(args: {
  candidates: RoutingCandidate[];
  costEstimates: CandidateCostEstimate[];
  previousDecision?: PreviousDecision;
  minSwitchSavingsRatio: number;
}): CandidatePruning {
  const incumbentCandidate = args.previousDecision
    ? {
        model: args.previousDecision.model,
        reasoningEffort: args.previousDecision.reasoningEffort,
      }
    : null;
  const candidateKeys = new Set(args.candidates.map(routingCandidateKey));
  const incumbentKey = incumbentCandidate
    ? routingCandidateKey(incumbentCandidate)
    : null;
  const estimateByKey = new Map(
    args.costEstimates.map((estimate) => [
      routingCandidateKey({
        model: estimate.model,
        reasoningEffort: estimate.reasoning_effort,
      }),
      estimate,
    ]),
  );
  const incumbent = incumbentKey && candidateKeys.has(incumbentKey)
    ? estimateByKey.get(incumbentKey)
    : undefined;
  if (!incumbent || !incumbentCandidate) {
    return keepAll(args, incumbentCandidate, "no_previous_decision");
  }
  if (incumbent.warm_tokens <= 0) {
    return keepAll(args, incumbentCandidate, "incumbent_not_warm");
  }
  const incumbentCost = turnCostUsdAt(
    incumbent.fixed_turn_cost_estimate,
    FIXED_TURN_COST_COMPARISON_TURNS,
  );
  const incumbentOutputPrice = incumbent.output_cost_per_mtok;
  if (
    incumbentCost === null ||
    incumbentCost <= 0 ||
    incumbentOutputPrice === null
  ) {
    return keepAll(args, incumbentCandidate, "incumbent_unpriced");
  }

  const prunedCandidates: PrunedCandidate[] = [];
  const keptCandidates: KeptCandidate[] = [];
  const survivors = args.candidates.filter((candidate) => {
    const key = routingCandidateKey(candidate);
    if (key === incumbentKey) {
      keptCandidates.push({
        model: candidate.model,
        reasoning_effort: candidate.reasoningEffort,
        reason: "incumbent",
      });
      return true;
    }
    const decision = candidateSwitchDecision({
      candidate,
      estimate: estimateByKey.get(key),
      incumbent: incumbentCandidate,
      incumbentCost,
      incumbentOutputPrice,
      minSwitchSavingsRatio: args.minSwitchSavingsRatio,
    });
    if (decision.action === "keep") {
      keptCandidates.push({
        model: candidate.model,
        reasoning_effort: candidate.reasoningEffort,
        reason: decision.reason,
        ...(decision.savingsRatio === undefined
          ? {}
          : { savings_ratio: decision.savingsRatio }),
      });
      return true;
    }
    prunedCandidates.push({
      model: candidate.model,
      reasoning_effort: candidate.reasoningEffort,
      fixed_turn_cost_usd: decision.fixedTurnCostUsd,
      savings_ratio: decision.savingsRatio,
    });
    return false;
  });
  const survivorKeys = new Set(survivors.map(routingCandidateKey));

  return {
    candidates: survivors,
    costEstimates: args.costEstimates.filter((estimate) =>
      survivorKeys.has(
        routingCandidateKey({
          model: estimate.model,
          reasoningEffort: estimate.reasoning_effort,
        }),
      )
    ),
    audit: {
      min_switch_savings_ratio: args.minSwitchSavingsRatio,
      incumbent_model: incumbentCandidate.model,
      incumbent_reasoning_effort: incumbentCandidate.reasoningEffort,
      incumbent_fixed_turn_cost_usd: incumbentCost,
      skip_reason: null,
      pruned_candidates: prunedCandidates,
      kept_candidates: keptCandidates,
    },
  };
}

function candidateSwitchDecision(args: {
  candidate: RoutingCandidate;
  estimate?: CandidateCostEstimate;
  incumbent: RoutingCandidate;
  incumbentCost: number;
  incumbentOutputPrice: number;
  minSwitchSavingsRatio: number;
}): CandidateSwitchDecision {
  const candidateCost = turnCostUsdAt(
    args.estimate?.fixed_turn_cost_estimate,
    FIXED_TURN_COST_COMPARISON_TURNS,
  );
  if (args.candidate.model !== args.incumbent.model) {
    return decideCacheSwitch({
      warmIncumbent: {
        fixedTurnCostUsd: args.incumbentCost,
        outputCostPerMtok: args.incumbentOutputPrice,
      },
      switchCandidate: {
        fixedTurnCostUsd: candidateCost,
        outputCostPerMtok: args.estimate?.output_cost_per_mtok ?? null,
      },
      minSwitchSavingsRatio: args.minSwitchSavingsRatio,
    });
  }

  // Output price cannot distinguish thinking levels on one model, so preserve
  // capability upgrades and judge lower-effort switches by projected cost.
  if (
    REASONING_EFFORTS.indexOf(args.candidate.reasoningEffort) >=
    REASONING_EFFORTS.indexOf(args.incumbent.reasoningEffort)
  ) {
    return { action: "keep", reason: "same_model_upgrade" };
  }
  if (candidateCost === null) {
    return { action: "keep", reason: "unknown_switch_cost" };
  }
  const savingsRatio =
    (args.incumbentCost - candidateCost) / args.incumbentCost;
  return savingsRatio > args.minSwitchSavingsRatio
    ? {
        action: "keep",
        reason: "saves_more_than_threshold",
        fixedTurnCostUsd: candidateCost,
        savingsRatio,
      }
    : {
        action: "prune",
        reason: "insufficient_savings",
        fixedTurnCostUsd: candidateCost,
        savingsRatio,
      };
}

function keepAll(
  args: {
    candidates: RoutingCandidate[];
    costEstimates: CandidateCostEstimate[];
    minSwitchSavingsRatio: number;
  },
  incumbent: RoutingCandidate | null,
  skipReason: NonNullable<CandidatePruningAudit["skip_reason"]>,
): CandidatePruning {
  return {
    candidates: args.candidates,
    costEstimates: args.costEstimates,
    audit: {
      min_switch_savings_ratio: args.minSwitchSavingsRatio,
      incumbent_model: incumbent?.model ?? null,
      incumbent_reasoning_effort: incumbent?.reasoningEffort ?? null,
      incumbent_fixed_turn_cost_usd: null,
      skip_reason: skipReason,
      pruned_candidates: [],
      kept_candidates: [],
    },
  };
}
