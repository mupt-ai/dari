import {
  buildThinkingLevelGraphs,
  thinkingLevelRatio,
  type ThinkingLevelObservation,
  type ThinkingLevelRatios,
} from "./thinking_level_graph.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "./types.js";

export type { ThinkingLevelRatios } from "./thinking_level_graph.js";

export type EvalScoreForImputation = {
  model_id: string;
  score: number;
  thinking_level?: ReasoningEffort | null;
  cost_per_task_usd?: number | null;
};

export type EvalForImputation = {
  min_score: number;
  max_score: number;
  scores: readonly EvalScoreForImputation[];
};

// Only named, same-family predecessors may stand in for a new model while
// benchmark sources catch up. Never infer a predecessor from a slug.
const PREVIOUS_GENERATION: Readonly<Record<string, string>> = {
  "openai/gpt-6.1-sol": "openai/gpt-6-sol",
  "openai/gpt-6.1-terra": "openai/gpt-5.6-terra",
  "openai/gpt-6-sol": "openai/gpt-5.6-sol",
  "openai/gpt-6-luna": "openai/gpt-5.6-luna",
  "anthropic/claude-opus-5-5": "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5-5": "anthropic/claude-sonnet-5",
  "anthropic/claude-fable-5-1": "anthropic/claude-fable-5",
  "anthropic/claude-fable-5-2": "anthropic/claude-fable-5-1",
  "meta/muse-spark-1.3": "meta/muse-spark-1.2",
  "zai-org/GLM-5.3": "zai-org/GLM-5.2",
  "xai/grok-4.7": "xai/grok-4.6",
};

export type ResolvedRouterEvalScore = {
  score: number;
  imputed: boolean;
  sourceModelId?: string;
};

export function createThinkingLevelRatios(
  evals: readonly EvalForImputation[],
): ThinkingLevelRatios {
  const observations: ThinkingLevelObservation[] = [];
  for (const evalCard of evals) {
    const range = evalCard.max_score - evalCard.min_score;
    if (!Number.isFinite(range) || range <= 0) continue;
    const byModel = explicitScoresByModel(evalCard.scores, evalCard.min_score, range);
    for (const [modelId, levels] of byModel) {
      const provider = modelOwner(modelId);
      if (provider) observations.push({ provider, levels });
    }
  }
  return buildThinkingLevelGraphs(observations);
}

type ResolveScoreArgs = {
  scores: readonly EvalScoreForImputation[];
  modelId: string;
  thinkingLevel: ReasoningEffort;
  minScore: number;
  maxScore: number;
  impute?: boolean;
  ratios?: ThinkingLevelRatios;
};

export function resolveRouterEvalScore(args: ResolveScoreArgs): ResolvedRouterEvalScore | null {
  const resolved = resolveRawScore(args);
  if (!resolved?.imputed) return resolved;

  // Include every effort, not just enabled candidates, so previews and runtime
  // agree. Cap each estimate by future measured data, then take prefix maxima.
  const levels = REASONING_EFFORTS.map((thinkingLevel) => resolveRawScore({ ...args, thinkingLevel }));
  const target = REASONING_EFFORTS.indexOf(args.thinkingLevel);
  let floor = -Infinity;
  for (let index = 0; index <= target; index++) {
    const row = levels[index];
    if (!row) continue;
    if (!row.imputed) {
      floor = Math.max(floor, row.score);
      continue;
    }
    const ceiling = Math.min(Infinity, ...levels.slice(index + 1).flatMap(
      (next) => next && !next.imputed ? [next.score] : [],
    ));
    // Measured regressions can make a missing interval impossible to fill.
    if (floor > ceiling) {
      if (index === target) return null;
      continue;
    }
    floor = Math.max(floor, Math.min(row.score, ceiling));
  }
  return { ...resolved, score: floor };
}

function resolveRawScore(args: ResolveScoreArgs): ResolvedRouterEvalScore | null {
  const modelScores = args.scores.filter(
    (score) => score.model_id === args.modelId,
  );
  const exact = modelScores.find(
    (score) => score.thinking_level === args.thinkingLevel,
  );
  const generic = modelScores.find((score) => score.thinking_level == null);
  const match = exact ?? generic;
  if (match) return { score: match.score, imputed: false };
  if (!(args.impute ?? false)) return null;

  const ratios = args.ratios ?? new Map();
  const score = pairwiseRatioScore(
    modelScores,
    modelOwner(args.modelId),
    args.thinkingLevel,
    args.minScore,
    args.maxScore,
    ratios,
  );
  if (score !== null) return { score, imputed: true };

  // A measured current-generation score or a valid same-model level
  // estimate always wins. Borrow only for a still-missing candidate level.
  const previous = PREVIOUS_GENERATION[args.modelId];
  if (!previous) return null;
  const previousScores = args.scores.filter((row) => row.model_id === previous);
  const predecessor = previousScores.find((row) => row.thinking_level === args.thinkingLevel)
    ?? previousScores.find((row) => row.thinking_level == null);
  const borrowed = predecessor?.score ?? pairwiseRatioScore(
    previousScores,
    modelOwner(previous),
    args.thinkingLevel,
    args.minScore,
    args.maxScore,
    ratios,
  );
  return borrowed === null || borrowed === undefined
    ? null
    : { score: borrowed, imputed: true, sourceModelId: previous };
}

// Cost-per-task ratios between thinking levels, learned like score ratios. A
// zero floor makes the shared normalization cancel, leaving raw cost ratios.
export function createTaskCostRatios(
  evals: readonly Pick<EvalForImputation, "scores">[],
): ThinkingLevelRatios {
  return createThinkingLevelRatios(
    evals.flatMap((evalCard) => {
      const priced = evalCard.scores.flatMap((row) => {
        const cost = row.cost_per_task_usd;
        return typeof cost === "number" && Number.isFinite(cost) && cost > 0
          ? [{ ...row, score: cost }]
          : [];
      });
      if (priced.length === 0) return [];
      return [{ min_score: 0, max_score: Math.max(...priced.map((row) => row.score)), scores: priced }];
    }),
  );
}

// A measured cost wins; otherwise the same model's priced levels are scaled by
// cost ratios. Predecessors never lend costs: prices change between
// generations even when scores carry over.
export function resolveRouterEvalTaskCost(args: {
  scores: readonly EvalScoreForImputation[];
  modelId: string;
  thinkingLevel: ReasoningEffort;
  impute?: boolean;
  ratios?: ThinkingLevelRatios;
}): number | null {
  const priced = args.scores.filter(
    (row) =>
      row.model_id === args.modelId &&
      typeof row.cost_per_task_usd === "number" &&
      Number.isFinite(row.cost_per_task_usd) &&
      row.cost_per_task_usd > 0,
  );
  const match = priced.find((row) => row.thinking_level === args.thinkingLevel)
    ?? priced.find((row) => row.thinking_level == null);
  if (match) return match.cost_per_task_usd!;
  if (!(args.impute ?? false)) return null;
  const estimates = priced.flatMap((anchor) => {
    if (anchor.thinking_level == null) return [];
    const ratio = thinkingLevelRatio(
      args.ratios ?? new Map(),
      modelOwner(args.modelId),
      anchor.thinking_level,
      args.thinkingLevel,
    );
    return ratio === undefined ? [] : [anchor.cost_per_task_usd! * ratio];
  });
  return estimates.length === 0 ? null : mean(estimates);
}

function pairwiseRatioScore(
  modelScores: readonly EvalScoreForImputation[],
  provider: string,
  targetLevel: ReasoningEffort,
  minScore: number,
  maxScore: number,
  ratios: ThinkingLevelRatios,
): number | null {
  const range = maxScore - minScore;
  if (!Number.isFinite(range) || range <= 0) return null;

  const estimates: number[] = [];
  for (const anchor of modelScores) {
    if (anchor.thinking_level == null || !Number.isFinite(anchor.score)) continue;
    const ratio = thinkingLevelRatio(ratios, provider, anchor.thinking_level, targetLevel);
    if (ratio === undefined) continue;
    const normalizedAnchor = (anchor.score - minScore) / range;
    if (normalizedAnchor <= 0) continue;
    const estimate = normalizedAnchor * ratio;
    if (Number.isFinite(estimate) && estimate >= 0 && estimate <= 1) {
      estimates.push(estimate);
    }
  }
  if (estimates.length === 0) return null;
  return round2(minScore + mean(estimates) * range);
}

function explicitScoresByModel(
  rows: readonly EvalScoreForImputation[],
  minScore: number,
  range: number,
): Map<string, Map<ReasoningEffort, number>> {
  const result = new Map<string, Map<ReasoningEffort, number>>();
  for (const row of rows) {
    if (row.thinking_level == null || !Number.isFinite(row.score)) continue;
    const levels = result.get(row.model_id) ?? new Map();
    if (!levels.has(row.thinking_level)) {
      levels.set(row.thinking_level, (row.score - minScore) / range);
    }
    result.set(row.model_id, levels);
  }
  return result;
}

// Eval model IDs use the canonical owner's namespace, not the serving provider.
// Unqualified IDs have no owner evidence and cannot calibrate or use a graph.
function modelOwner(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash).toLowerCase() : "";
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
