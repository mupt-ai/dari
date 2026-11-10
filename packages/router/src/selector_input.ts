// Builds the selector input: candidate pairs, matched eval scores, cost
// estimates, the previous decision, and the (image-scrubbed) conversation.
// The system prompts live in prompts.ts.

import {
  createThinkingLevelRatios,
  resolveRouterEvalScore,
  resolveRouterEvalTaskCost,
  createTaskCostRatios,
  type ThinkingLevelRatios,
} from "./eval_score_imputation.js";
import {
  isRecord,
  REASONING_EFFORTS,
  routingCandidateKey,
  type CandidateCostEstimate,
  type ChatMessage,
  type CustomRouterRule,
  type PreviousDecision,
  type ReasoningEffort,
  type RouterEval,
  type RouterEvalScore,
  type RoutingCandidate,
} from "./types.js";
import type { JsonValue } from "./json.js";

const IMAGE_OMITTED_PLACEHOLDER = "<image omitted>";
// Numbered placeholders name images that travel to the selector out of band
// (the routing backend attaches them as ordered image parts), so scrubbing
// must leave them alone while still dropping any real image bytes or URLs.
const SELECTOR_IMAGE_PLACEHOLDER = /^<image \d+>$/;

export type SelectorCandidate = {
  model: string;
  thinking_level: RoutingCandidate["reasoningEffort"];
};

export type SelectorLeaseTestObservation = {
  command: string;
  status: "passed" | "failed" | "unknown";
  result: JsonValue | null;
};

export type SelectorLeaseHistoryEntry = {
  candidate: SelectorCandidate;
  requested_turns: number;
  completed_turns: number;
  rationale: string;
  last_agent_thought: string | null;
  last_tool_call: {
    name: string;
    arguments: JsonValue;
  } | null;
  last_tool_result: JsonValue | null;
  tool_errors: number | null;
  files_changed: number | null;
  tests: SelectorLeaseTestObservation | null;
};

type SelectorPreviousDecision = SelectorCandidate & { reason: string };

type ResolvedEvalScore = {
  model_id: string;
  thinking_level: ReasoningEffort;
  score: number;
  notes: string | null;
  imputed?: true;
  source_model_id?: string;
  cost_per_task_usd?: number;
};

export type SelectorInput = {
  candidate_pairs: SelectorCandidate[];
  imported_evals: Array<Record<string, unknown>>;
  previous_decision: SelectorPreviousDecision | null;
  cost_estimates: CandidateCostEstimate[] | null;
  // Named candidates remain internal here. The anonymous policy boundary
  // rewrites every entry to the current action permutation.
  lease_history?: SelectorLeaseHistoryEntry[];
  messages: ChatMessage[];
};

type SelectorCustomRule = Omit<CustomRouterRule, "thinking_level"> & {
  thinking_level: ReasoningEffort | null;
};

export type CustomSelectorInput = SelectorInput & {
  custom_rules: SelectorCustomRule[];
  default_target: {
    model: string;
    thinking_level: ReasoningEffort | null;
  } | null;
};

// Selector serialization must not include image bytes. The provider-facing
// request and prefix fingerprint still use the original content, while this
// stable placeholder preserves the selector's own prompt cache behavior.
export function selectorSafeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) =>
        isRecord(part) && part.type === "image_url" && !isSelectorImagePlaceholder(part)
          ? { type: "image_url", image_url: { url: IMAGE_OMITTED_PLACEHOLDER } }
          : part
      ),
    };
  });
}

function isSelectorImagePlaceholder(part: Record<string, unknown>): boolean {
  const imageUrl = part["image_url"];
  return isRecord(imageUrl)
    && typeof imageUrl["url"] === "string"
    && SELECTOR_IMAGE_PLACEHOLDER.test(imageUrl["url"]);
}

export function buildSelectorInput(args: {
  candidates: RoutingCandidate[];
  evals: RouterEval[];
  previousDecision: PreviousDecision | null;
  costEstimates: CandidateCostEstimate[] | null;
  messages: ChatMessage[];
  leaseHistory?: SelectorLeaseHistoryEntry[];
  customRules?: CustomRouterRule[];
  defaultTarget?: {
    model: string;
    thinkingLevel: ReasoningEffort | null;
  } | null;
  modelFallbackEnabled?: boolean;
  fallbackRequiresDifferentProvider?: boolean;
  // When true, fill missing levels using calibrated thinking-level ratios or
  // a named predecessor from the same model family. Off by default.
  imputeEvalScores?: boolean;
  // Calibrates cross-level ratios without adding these cards to imported_evals.
  imputationReferenceEvals?: RouterEval[];
}): SelectorInput | CustomSelectorInput {
  const imputeEvalScores = args.imputeEvalScores ?? false;
  const input: SelectorInput = {
    candidate_pairs: args.candidates.map(({ model, reasoningEffort }) => ({
      model,
      thinking_level: reasoningEffort,
    })),
    imported_evals: formatImportedEvals(
      args.evals,
      args.candidates,
      imputeEvalScores,
      args.imputationReferenceEvals ?? [],
    ),
    previous_decision: args.previousDecision
      ? {
          model: args.previousDecision.model,
          thinking_level: args.previousDecision.reasoningEffort,
          reason: args.previousDecision.reason,
        }
      : null,
    cost_estimates: args.costEstimates,
    // Only callers that computed lease context provide it; omitting the key
    // entirely keeps the input byte-identical to the shape before lease
    // history existed, for routers with lease context disabled.
    ...(args.leaseHistory !== undefined ? { lease_history: args.leaseHistory } : {}),
    messages: args.messages,
  };
  if (args.customRules !== undefined) {
    (input as CustomSelectorInput).custom_rules = args.customRules.map(
      (rule) => ({
        ...rule,
        thinking_level: rule.thinking_level ?? null,
      }),
    );
    (input as CustomSelectorInput).default_target = args.defaultTarget
      ? {
          model: args.defaultTarget.model,
          thinking_level: args.defaultTarget.thinkingLevel,
        }
      : null;
  }
  return input;
}

function formatImportedEvals(
  evals: RouterEval[],
  candidates: RoutingCandidate[],
  imputeEvalScores: boolean,
  imputationReferenceEvals: RouterEval[],
): Array<Record<string, unknown>> {
  const selectedEvalIds = new Set(evals.map((evalCard) => evalCard.id));
  const ratioEvals = imputeEvalScores
    ? [
        ...evals,
        ...imputationReferenceEvals.filter(
          (evalCard) => !selectedEvalIds.has(evalCard.id),
        ),
      ]
    : [];
  const thinkingLevelRatios = createThinkingLevelRatios(ratioEvals);
  const taskCostRatios = createTaskCostRatios(ratioEvals);
  return evals.flatMap((evalCard) => {
    const scores = matchingEvalScores(
      evalCard.scores,
      candidates,
      imputeEvalScores,
      evalCard.min_score,
      evalCard.max_score,
      thinkingLevelRatios,
      taskCostRatios,
    );
    if (scores.length === 0) return [];
    return [
      {
        id: evalCard.id,
        name: evalCard.name,
        description: evalCard.description ?? null,
        min_score: evalCard.min_score,
        max_score: evalCard.max_score,
        scores,
      },
    ];
  });
}

function matchingEvalScores(
  scores: RouterEvalScore[],
  candidates: RoutingCandidate[],
  imputeEvalScores: boolean,
  minScore: number,
  maxScore: number,
  thinkingLevelRatios: ThinkingLevelRatios,
  taskCostRatios: ThinkingLevelRatios,
): Array<Record<string, unknown>> {
  const uniqueCandidates = new Map(
    candidates.map((candidate) => [routingCandidateKey(candidate), candidate]),
  );
  const resolvedScores = [...uniqueCandidates.values()]
    .map((candidate): ResolvedEvalScore | null => {
      const resolved = resolveRouterEvalScore({
        scores,
        modelId: candidate.model,
        thinkingLevel: candidate.reasoningEffort,
        minScore,
        maxScore,
        impute: imputeEvalScores,
        ratios: thinkingLevelRatios,
      });
      if (resolved === null) return null;
      const modelScores = scores.filter(
        (score) => score.model_id === candidate.model,
      );
      const measured = resolved.imputed
        ? null
        : (modelScores.find(
            (score) => score.thinking_level === candidate.reasoningEffort,
          ) ?? modelScores.find((score) => score.thinking_level == null));
      const costPerTask = resolveRouterEvalTaskCost({
        scores,
        modelId: candidate.model,
        thinkingLevel: candidate.reasoningEffort,
        impute: imputeEvalScores,
        ratios: taskCostRatios,
      });
      return {
        model_id: candidate.model,
        thinking_level: candidate.reasoningEffort,
        score: resolved.score,
        notes: measured?.notes ?? null,
        ...(resolved.imputed ? { imputed: true as const } : {}),
        ...(resolved.sourceModelId ? { source_model_id: resolved.sourceModelId } : {}),
        ...(costPerTask === null ? {} : { cost_per_task_usd: costPerTask }),
      };
    })
    .filter((score): score is ResolvedEvalScore => score !== null);
  return normalizeResolvedScores(resolvedScores);
}

// The selector compares current actions, so exact, generic, and imputed rows
// share one candidate-only population. Unresolved actions never enter the
// denominator or the distribution.
function normalizeResolvedScores(
  scores: ResolvedEvalScore[],
): Array<Record<string, unknown>> {
  if (scores.length === 0) return [];

  const values = scores.map((entry) => entry.score);
  const populationMean = mean(values);
  const variance =
    values.reduce((total, value) => total + (value - populationMean) ** 2, 0) /
    values.length;
  const stdDev = Math.sqrt(variance);
  const ranks = new Map<number, number>();
  [...values]
    .sort((left, right) => right - left)
    .forEach((score, index) => {
      // Competition ranking, best score first; tied scores share the low rank.
      if (!ranks.has(score)) ranks.set(score, index + 1);
    });

  return scores.map((score) => ({
    ...score,
    rank: ranks.get(score.score)!,
    rank_total: scores.length,
    z_score: stdDev === 0 ? 0 : round2((score.score - populationMean) / stdDev),
  }));
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
