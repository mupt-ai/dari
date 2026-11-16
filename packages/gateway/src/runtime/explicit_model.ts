import type { RoutingCandidate, RoutingDecision } from "@mupt-ai/dari-router/policy-engine";

import { HttpError } from "../http/errors.js";
import { modelNotServed } from "../link/errors.js";
import { explicitModelId } from "../protocol/input/router_model.js";
import type { RoutedDecision } from "../strategies/route_decision.js";
import type { PreparedRoutedCompletion } from "./prepare_routed_completion.js";

/* A request for `dari/model/<id>` is served by exactly that enabled model,
   with no selector or lease: the user chose it, like picking a
   model in their agent's /model menu, or the router fixed it for the
   request's agent role. Routing rules and switch-cost pruning narrow only
   what the selector may pick, so they never remove it. The client's thinking
   level is kept when the model supports it; otherwise the model's default
   level is used. A Dari Link token's level is never replaced: it is served
   exactly or the request is refused. */
export function explicitModelDecision(
  prepared: PreparedRoutedCompletion,
): RoutedDecision | null {
  const modelId = explicitModelId(prepared.interaction.model);
  if (modelId === null) return null;
  if (!prepared.credentials.enabled_models.includes(modelId)) {
    throw prepared.credentials.link_grant_id
      ? modelNotServed(prepared.credentials, modelId)
      : modelNotEnabled(modelId);
  }
  const candidates = prepared.routing.candidateResolution.allCandidates.filter(
    (candidate) => candidate.model === modelId,
  );
  if (candidates.length === 0) {
    throw new HttpError(
      400,
      `Model '${modelId}' cannot serve this request.`,
      "model_unavailable",
      "model",
    );
  }
  const candidate = pickCandidate(prepared, modelId, candidates);
  // A Dari Link token's named level is served exactly or refused.
  const named = prepared.interaction.reasoning?.clientOnly === true ? prepared.interaction.reasoning.effort : undefined;
  if (named !== undefined && candidate.reasoningEffort !== named) throw thinkingLevelUnavailable(modelId, named);
  const decision: RoutingDecision = {
    selectedModel: candidate.model,
    reasoningEffort: candidate.reasoningEffort,
    reason: prepared.role === undefined
      ? `Requested model ${modelId} served without selection.`
      : `The router's ${prepared.role} model ${modelId} served without selection.`,
  };
  return { decision };
}

function pickCandidate(
  prepared: PreparedRoutedCompletion,
  modelId: string,
  candidates: RoutingCandidate[],
): RoutingCandidate {
  const preferred = [
    prepared.interaction.reasoning?.effort,
    prepared.credentials.model_configs?.[modelId]?.default_thinking_level,
  ];
  for (const effort of preferred) {
    const match = candidates.find((candidate) => candidate.reasoningEffort === effort);
    if (match) return match;
  }
  return candidates[0]!;
}

/* A strict router serves only the pinned `dari/model/<id>` at exactly the
   requested thinking level (the model's default when none is sent), and
   refuses everything else instead of substituting. */
export function strictModelDecision(prepared: PreparedRoutedCompletion): RoutedDecision {
  const modelId = explicitModelId(prepared.interaction.model);
  if (modelId === null) throw strictModelRequired();
  const { decision } = explicitModelDecision(prepared)!;
  const requested = prepared.interaction.reasoning?.effort
    ?? prepared.credentials.model_configs?.[modelId]?.default_thinking_level;
  if (requested !== undefined && requested !== null && decision.reasoningEffort !== requested) {
    throw thinkingLevelUnavailable(modelId, requested);
  }
  return { decision };
}

function thinkingLevelUnavailable(modelId: string, requested: string): HttpError {
  return new HttpError(
    400,
    `Model '${modelId}' cannot serve thinking level '${requested}' on this router.`,
    "thinking_level_unavailable",
    "reasoning_effort",
  );
}

export function modelNotEnabled(modelId: string): HttpError {
  return new HttpError(400, `Model '${modelId}' is not enabled on this router.`, "model_not_enabled", "model");
}

export function strictModelRequired(): HttpError {
  return new HttpError(
    400,
    "This router is strict: request a pinned model as 'dari/model/<id>'.",
    "strict_model_required",
    "model",
  );
}
