import type {
  ChatMessage,
  PreviousDecision,
  RoutingDecision,
  StrategyCandidateResolution,
  SelectorLeaseHistoryEntry,
} from "@mupt-ai/dari-router/policy-engine";
import { publicCatalogSelectorEvals } from "../context/eval_catalog.js";
import { HttpError } from "../http/errors.js";
import { relevantEvals } from "./eval_relevance.js";
import { executionProviderForModel } from "../models/execution_provider.js";
import { selectModel, type SelectorBackend, type SelectorRun } from "./routing.js";
import type { SelectorImage } from "./selector_projection.js";
import type { ResolvedRouter } from "../types.js";

export type RoutedDecision = {
  decision: RoutingDecision;
  run?: SelectorRun;
  details?: Record<string, unknown>;
};

type RouteDecisionArgs = {
  selectorMessages: ChatMessage[];
  selectorImages?: SelectorImage[];
  resolution: StrategyCandidateResolution;
  credentials: ResolvedRouter;
  previousDecision?: PreviousDecision;
  conversationId: string;
  selectorBackend: SelectorBackend;
  leaseHistory?: SelectorLeaseHistoryEntry[];
};

export async function routeDecision(
  args: RouteDecisionArgs,
): Promise<RoutedDecision> {
  const { credentials, resolution } = args;
  const custom = resolution.strategy === "custom"
    ? resolution.custom
    : undefined;
  if (custom === null) {
    throw new HttpError(
      502,
      "Router custom rule configuration is missing.",
      "custom_config_missing",
    );
  }
  if (custom && resolution.candidates.length === 0) {
    const error = new HttpError(
      502,
      "No custom routing rule or default model/thinking-level pair is routable for this request.",
      "custom_no_routable_candidates",
    ) as HttpError & { decisionDetails?: Record<string, unknown> };
    error.decisionDetails = { custom_rules: custom.audit };
    throw error;
  }

  const relevance = args.selectorBackend.evalRelevance !== undefined
    && resolution.candidates.length > 1
    ? await relevantEvals({
        credentials,
        selectorMessages: args.selectorMessages,
        config: args.selectorBackend.evalRelevance,
      })
    : undefined;
  const run = await selectModel({
    messages: args.selectorMessages,
    ...(args.selectorImages !== undefined && args.selectorImages.length > 0
      ? { images: args.selectorImages }
      : {}),
    candidates: resolution.candidates,
    allCandidates: resolution.allCandidates,
    evals: relevance?.evals ?? credentials.evals ?? [],
    imputationReferenceEvals: credentials.eval_score_imputation === true
      ? publicCatalogSelectorEvals(credentials.public_eval_catalog)
      : undefined,
    previousDecision: args.previousDecision,
    costEstimates: resolution.costEstimates,
    sessionId: args.conversationId,
    ...(custom
      ? { customRules: custom.rules, defaultTarget: custom.defaultTarget }
      : {}),
    selectorBackend: args.selectorBackend,
    executionProviderForModel: (model) =>
      executionProviderForModel(credentials, model),
    imputeEvalScores: credentials.eval_score_imputation === true,
    leaseHistory: args.leaseHistory,
    leaseContextEnabled: credentials.lease_context_enabled !== false,
  });
  const details = {
    ...(custom ? { custom_rules: custom.audit } : {}),
    ...(run.usage?.policy_bypassed === "single_candidate"
      ? { selector_policy_bypass: "single_candidate" }
      : {}),
    ...(relevance ? { eval_relevance: relevance.details } : {}),
  };
  return {
    decision: run.decision,
    run,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}
