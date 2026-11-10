import {
  routingCandidateKey,
  type CandidateCostEstimate,
  type RoutingDecision,
} from "@mupt-ai/dari-router/policy-engine";

import type { RoutedDecision } from "../../strategies/route_decision.js";
import { isBackgroundRequest } from "../../interaction/types.js";
import { HttpError } from "../../http/errors.js";
import { assertCreditAvailableBeforeRouting } from "../../telemetry/usage.js";
import type { PreparedRoutedCompletion } from "../prepare_routed_completion.js";

// Explicit background classes bypass the selector and every lease path.
// Keep the existing deterministic cheapest-input-cost serving policy.
export function auxiliaryDecision(
  prepared: PreparedRoutedCompletion,
): RoutedDecision | null {
  if (!isBackgroundRequest(prepared.interaction)) return null;
  assertCreditAvailableBeforeRouting(prepared.billable, prepared.credentials);
  const requestClass = prepared.interaction.agentContext!.requestClass;
  const cheapest = cheapestCandidate(prepared);
  if (!cheapest) {
    throw new HttpError(503, "Background requests require a routable model with known pricing.",
      "background_model_unavailable");
  }

  const decision: RoutingDecision = {
    selectedModel: cheapest.model,
    reasoningEffort: cheapest.reasoning_effort,
    reason: `${requestClass} request served by the cheapest routable model without selection.`,
  };
  return { decision };
}

/* Ranked on estimated input cost: these requests carry a whole transcript in
   and a sentence out, so the prompt dominates. Estimates cover the configured
   roster, so they are narrowed to the candidates pruning actually left
   routable. Unpriced candidates are not comparable; fail explicitly if no
   priced candidate is available, never fall through to selection. */
function cheapestCandidate(
  prepared: PreparedRoutedCompletion,
): CandidateCostEstimate | null {
  const routable = new Set(
    prepared.routing.candidateResolution.candidates.map(routingCandidateKey),
  );
  let cheapest: CandidateCostEstimate | null = null;
  for (const estimate of prepared.routing.candidateResolution.costEstimates) {
    if (!estimate.pricing_known || estimate.est_input_cost_usd === null) continue;
    if (
      !routable.has(
        routingCandidateKey({
          model: estimate.model,
          reasoningEffort: estimate.reasoning_effort,
        }),
      )
    ) {
      continue;
    }
    if (cheapest === null || cheaperThan(estimate, cheapest)) cheapest = estimate;
  }
  return cheapest;
}

function cheaperThan(
  candidate: CandidateCostEstimate,
  incumbent: CandidateCostEstimate,
): boolean {
  const candidateInput = candidate.est_input_cost_usd ?? Infinity;
  const incumbentInput = incumbent.est_input_cost_usd ?? Infinity;
  if (candidateInput !== incumbentInput) return candidateInput < incumbentInput;
  return (candidate.output_cost_per_mtok ?? Infinity)
    < (incumbent.output_cost_per_mtok ?? Infinity);
}
