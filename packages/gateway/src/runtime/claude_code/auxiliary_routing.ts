import {
  previousDecisionFromHit,
  routingCandidateKey,
  type CandidateCostEstimate,
  type RoutingCandidate,
  type RoutingDecision,
} from "@mupt-ai/dari-router/policy-engine";

import type { RoutedDecision } from "../../strategies/route_decision.js";
import { isBackgroundRequest } from "../../interaction/types.js";
import { HttpError } from "../../http/errors.js";
import { assertCreditAvailableBeforeRouting } from "../../telemetry/usage.js";
import type { PreparedRoutedCompletion } from "../prepare_routed_completion.js";

// Explicit background classes bypass the selector and every lease path. As
// Claude Code does against Anthropic, work for an agent (compaction, side
// questions, prompt suggestions) runs on the model that agent is on. Claude
// Code names its small model itself, so the rest that reaches routing (a
// safety check, a web search) runs on the cheapest model.
export function auxiliaryDecision(
  prepared: PreparedRoutedCompletion,
): RoutedDecision | null {
  if (!isBackgroundRequest(prepared.interaction)) return null;
  assertCreditAvailableBeforeRouting(prepared.billable, prepared.credentials);
  const requestClass = prepared.interaction.agentContext!.requestClass;
  const agent = agentCandidate(prepared);
  if (agent) {
    return {
      decision: {
        selectedModel: agent.model,
        reasoningEffort: agent.reasoningEffort,
        reason: `${requestClass} request served on its agent's model without selection.`,
      },
    };
  }
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

/* The pair the agent is on (its lease target, else what it was last served)
   or, when this request cannot take that pair (a forced tool rules out
   thinking), one of those models at a level it can. */
function agentCandidate(prepared: PreparedRoutedCompletion): RoutingCandidate | null {
  const row = prepared.agentRow;
  if (row === undefined) return null;
  const candidates = prepared.routing.candidateResolution.candidates;
  const pair = previousDecisionFromHit(row, candidates);
  if (pair) return { model: pair.model, reasoningEffort: pair.reasoningEffort };
  for (const model of [row.next_model, row.model]) {
    const candidate = candidates.find((candidate) => candidate.model === model);
    if (candidate) return candidate;
  }
  return null;
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
