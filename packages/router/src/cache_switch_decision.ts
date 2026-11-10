export type WarmIncumbentCost = {
  fixedTurnCostUsd: number;
  outputCostPerMtok: number;
};

export type SwitchCandidateCost = {
  fixedTurnCostUsd: number | null;
  outputCostPerMtok: number | null;
};

export type CacheSwitchDecision =
  | {
      action: "keep";
      reason: "unknown_switch_cost" | "unknown_switch_output_price" | "not_cheaper_output_tier" | "saves_more_than_threshold";
      fixedTurnCostUsd?: number;
      savingsRatio?: number;
    }
  | {
      action: "prune";
      reason: "insufficient_savings";
      fixedTurnCostUsd: number;
      savingsRatio: number;
    };

export function decideCacheSwitch(args: {
  warmIncumbent: WarmIncumbentCost;
  switchCandidate: SwitchCandidateCost;
  minSwitchSavingsRatio: number;
}): CacheSwitchDecision {
  const fixedTurnCostUsd = args.switchCandidate.fixedTurnCostUsd;
  if (fixedTurnCostUsd === null) {
    return { action: "keep", reason: "unknown_switch_cost" };
  }

  const outputCostPerMtok = args.switchCandidate.outputCostPerMtok;
  if (outputCostPerMtok === null) {
    return { action: "keep", reason: "unknown_switch_output_price" };
  }

  // Higher output price is our capability-upgrade guard. The pruning rule is
  // only for cheaper-tier switches that look cheap before cache effects.
  if (outputCostPerMtok >= args.warmIncumbent.outputCostPerMtok) {
    return { action: "keep", reason: "not_cheaper_output_tier", fixedTurnCostUsd };
  }

  const savingsRatio =
    (args.warmIncumbent.fixedTurnCostUsd - fixedTurnCostUsd) / args.warmIncumbent.fixedTurnCostUsd;
  if (savingsRatio > args.minSwitchSavingsRatio) {
    return { action: "keep", reason: "saves_more_than_threshold", fixedTurnCostUsd, savingsRatio };
  }

  return { action: "prune", reason: "insufficient_savings", fixedTurnCostUsd, savingsRatio };
}
