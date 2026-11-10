import type { RoutingCandidate, RoutingDecision } from "@mupt-ai/dari-router/policy-engine";

import { HttpError } from "../http/errors.js";
import { explicitModelId } from "../protocol/input/router_model.js";
import type { RoutedDecision } from "../strategies/route_decision.js";
import type { PreparedRoutedCompletion } from "./prepare_routed_completion.js";

/* A request for `dari/model/<id>` is served by exactly that enabled model,
   with no selector or lease: the user chose it, like picking a
   model in their agent's /model menu. The client's thinking level is kept
   when the model supports it; otherwise the model's default level is used. */
export function explicitModelDecision(
  prepared: PreparedRoutedCompletion,
): RoutedDecision | null {
  const modelId = explicitModelId(prepared.interaction.model);
  if (modelId === null) return null;
  if (!prepared.credentials.enabled_models.includes(modelId)) throw modelNotEnabled(modelId);
  const candidates = prepared.routing.candidateResolution.candidates.filter(
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
  const decision: RoutingDecision = {
    selectedModel: candidate.model,
    reasoningEffort: candidate.reasoningEffort,
    reason: `Requested model ${modelId} served without selection.`,
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
    throw new HttpError(
      400,
      `Model '${modelId}' cannot serve thinking level '${requested}' on this router.`,
      "thinking_level_unavailable",
      "reasoning_effort",
    );
  }
  return { decision };
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
