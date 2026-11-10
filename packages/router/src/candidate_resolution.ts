import {
  MIN_SWITCH_SAVINGS_RATIO,
  pruneSwitchCandidates,
  type CandidatePruningAudit,
} from "./candidate_pruning.js";
import {
  routingCandidateKey,
  type CandidateCostEstimate,
  type CustomRouterConfig,
  type CustomRouterRule,
  type PreviousDecision,
  type ReasoningEffort,
  type RouterModelPrice,
  type RoutingCandidate,
  type RoutingStrategy,
} from "./types.js";

export type CustomDefaultTarget = {
  model: string;
  thinkingLevel: ReasoningEffort | null;
};

type CandidateSet = {
  candidates: RoutingCandidate[];
  // The configured roster before pruning. Anonymous-action letters are
  // assigned over it so each candidate keeps one letter for the whole
  // conversation even when pruning shrinks the routable set.
  allCandidates: RoutingCandidate[];
  costEstimates: CandidateCostEstimate[];
};

type CustomDetails = {
  rules: CustomRouterRule[];
  defaultTarget: CustomDefaultTarget | null;
  audit: {
    dropped_rules: CustomRouterRule[];
    fallback_all_candidates: boolean;
    no_routable_rule_models: boolean;
  };
};

export type StrategyCandidateResolution = CandidateSet & (
  | { strategy: "dari"; pruning: CandidatePruningAudit }
  | { strategy: "custom"; pruning: null; custom: null }
  | {
      strategy: "custom";
      pruning: CandidatePruningAudit;
      custom: CustomDetails;
    }
);

type CustomCandidateResolution = Extract<
  StrategyCandidateResolution,
  { strategy: "custom"; custom: CustomDetails }
>;

type CandidateResolutionArgs = {
  strategy: RoutingStrategy;
  candidates: RoutingCandidate[];
  costEstimates: CandidateCostEstimate[];
  previousDecision?: PreviousDecision;
  customConfig?: CustomRouterConfig | null;
  modelPrices: Record<string, RouterModelPrice>;
};

export function resolveStrategyCandidates(
  args: CandidateResolutionArgs,
): StrategyCandidateResolution {
  if (args.strategy === "dari") {
    const pruned = pruneSwitchCandidates({
      candidates: args.candidates,
      costEstimates: args.costEstimates,
      previousDecision: args.previousDecision,
      minSwitchSavingsRatio: MIN_SWITCH_SAVINGS_RATIO,
    });
    return {
      strategy: "dari",
      candidates: pruned.candidates,
      allCandidates: [...args.candidates],
      costEstimates: pruned.costEstimates,
      pruning: pruned.audit,
    };
  }

  const config = args.customConfig;
  if (!config || !Array.isArray(config.rules) || config.rules.length === 0) {
    return {
      strategy: "custom",
      candidates: [],
      allCandidates: [...args.candidates],
      costEstimates: [],
      pruning: null,
      custom: null,
    };
  }

  return resolveCustomCandidates(args, config);
}

function resolveCustomCandidates(
  args: CandidateResolutionArgs,
  config: CustomRouterConfig,
): CustomCandidateResolution {
  const usableRules = config.rules.filter((rule) =>
    args.candidates.some((candidate) => matchesRule(candidate, rule)),
  );
  const defaultModel = typeof config.default === "string" ? config.default : null;
  const defaultTarget =
    defaultModel !== null &&
    args.candidates.some((candidate) =>
      matchesTarget(candidate, defaultModel, config.default_thinking_level),
    )
      ? {
          model: defaultModel,
          thinkingLevel: config.default_thinking_level ?? null,
        }
      : null;
  const matchesDefault = (candidate: RoutingCandidate) =>
    defaultTarget !== null &&
    matchesTarget(candidate, defaultTarget.model, defaultTarget.thinkingLevel);
  const configuredCandidates = orderCandidatesByCostDesc(
    args.candidates.filter(
      (candidate) =>
        usableRules.some((rule) => matchesRule(candidate, rule)) ||
        matchesDefault(candidate),
    ),
    args.modelPrices,
  );
  const pruned = pruneSwitchCandidates({
    candidates: configuredCandidates,
    costEstimates: reorderEstimates(args.costEstimates, configuredCandidates),
    previousDecision: args.previousDecision,
    minSwitchSavingsRatio: MIN_SWITCH_SAVINGS_RATIO,
  });
  const ruleOrder = (rule: CustomRouterRule) =>
    pruned.candidates.findIndex((candidate) => matchesRule(candidate, rule));

  return {
    strategy: "custom",
    candidates: pruned.candidates,
    allCandidates: configuredCandidates,
    costEstimates: pruned.costEstimates,
    pruning: pruned.audit,
    custom: {
      rules: usableRules
        .filter((rule) => ruleOrder(rule) >= 0)
        .sort((a, b) => ruleOrder(a) - ruleOrder(b)),
      defaultTarget: pruned.candidates.some(matchesDefault)
        ? defaultTarget
        : null,
      audit: {
        dropped_rules: config.rules.filter((rule) => !usableRules.includes(rule)),
        fallback_all_candidates: false,
        no_routable_rule_models: configuredCandidates.length === 0,
      },
    },
  };
}

function matchesRule(
  candidate: RoutingCandidate,
  rule: CustomRouterRule,
): boolean {
  return matchesTarget(candidate, rule.use, rule.thinking_level);
}

function matchesTarget(
  candidate: RoutingCandidate,
  model: string,
  thinkingLevel: ReasoningEffort | null | undefined,
): boolean {
  return candidate.model === model &&
    (thinkingLevel == null || candidate.reasoningEffort === thinkingLevel);
}

// Catalog rates are model-scoped, so sorting remains stable across a model's
// thinking-level variants.
function orderCandidatesByCostDesc(
  candidates: RoutingCandidate[],
  modelPrices: Record<string, RouterModelPrice>,
): RoutingCandidate[] {
  return [...candidates].sort((a, b) => {
    const priceA = usablePrice(modelPrices[a.model]);
    const priceB = usablePrice(modelPrices[b.model]);
    if (priceA === null && priceB === null) return 0;
    if (priceA === null) return 1;
    if (priceB === null) return -1;
    return priceB.output - priceA.output || priceB.input - priceA.input;
  });
}

function usablePrice(price: RouterModelPrice | undefined): RouterModelPrice | null {
  return price && Number.isFinite(price.input) && Number.isFinite(price.output)
    ? price
    : null;
}

function reorderEstimates(
  estimates: CandidateCostEstimate[],
  candidates: RoutingCandidate[],
): CandidateCostEstimate[] {
  const byCandidate = new Map(
    estimates.map((estimate) => [
      routingCandidateKey({
        model: estimate.model,
        reasoningEffort: estimate.reasoning_effort,
      }),
      estimate,
    ]),
  );
  return candidates.flatMap((candidate) => {
    const estimate = byCandidate.get(routingCandidateKey(candidate));
    return estimate ? [estimate] : [];
  });
}
