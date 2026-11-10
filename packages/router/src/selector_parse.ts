import { RouterCoreError } from "./errors.js";
import { providerForModel } from "./model_ids.js";
import {
  isReasoningEffort,
  sameRoutingCandidate,
  type RoutingCandidate,
  type RoutingDecision,
} from "./types.js";

export type ParsedSelectorDecision = {
  decision: RoutingDecision;
  fallbackDecision?: RoutingDecision;
};

// Parses the selector's raw output text into a routing decision (plus an
// optional fallback). Tolerates a fenced ```json block; everything else must
// be strict JSON matching the routing_decision schema.
export function parseSelectorDecision(text: string): ParsedSelectorDecision {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new RouterCoreError("selector_output", "Selector returned invalid JSON.", "selector_invalid_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RouterCoreError("selector_output", "Selector returned invalid routing decision.", "selector_invalid_response");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.selected_model !== "string" || record.selected_model === "") {
    throw new RouterCoreError("selector_output", "Selector response missing selected_model.", "selector_invalid_response");
  }
  if (!isReasoningEffort(record.reasoning_effort)) {
    throw new RouterCoreError(
      "selector_output",
      "Selector response missing a valid reasoning_effort.",
      "selector_invalid_response",
    );
  }
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  const leaseTurnsRemaining =
    typeof record.lease_turns_remaining === "number" && Number.isFinite(record.lease_turns_remaining)
      ? Math.trunc(record.lease_turns_remaining)
      : undefined;
  const decision = {
    selectedModel: record.selected_model,
    reasoningEffort: record.reasoning_effort,
    reason:
      reason ||
      `Selector selected ${record.selected_model}/${record.reasoning_effort}; no reason was provided.`,
    ...(leaseTurnsRemaining === undefined ? {} : { leaseTurnsRemaining }),
  };
  const fallbackModel = record.fallback_model;
  const fallbackEffort = record.fallback_reasoning_effort;
  const fallbackReason = record.fallback_reason;
  // Selectors that decline a fallback often still explain why in
  // fallback_reason; a missing fallback_model alone means "no fallback".
  const noFallback = fallbackModel === null || fallbackModel === undefined;
  if (noFallback) return { decision };
  if (
    typeof fallbackModel !== "string" ||
    !fallbackModel ||
    !isReasoningEffort(fallbackEffort) ||
    (fallbackReason !== undefined &&
      fallbackReason !== null &&
      typeof fallbackReason !== "string")
  ) {
    throw new RouterCoreError(
      "selector_output",
      "Selector response contains an incomplete fallback decision.",
      "selector_invalid_response",
    );
  }
  const normalizedFallbackReason = fallbackReason?.trim() ?? "";
  return {
    decision,
    fallbackDecision: {
      selectedModel: fallbackModel,
      reasoningEffort: fallbackEffort,
      reason:
        normalizedFallbackReason ||
        `Selector ranked ${fallbackModel}/${fallbackEffort} as the fallback; no reason was provided.`,
    },
  };
}

// Validates a parsed selector decision against the candidate set and fallback
// policy: the selection must be a real candidate pair, and when fallback is
// enabled a fallback must be present whenever an eligible one exists and must
// itself be an eligible candidate on a distinct model (and provider, when
// required).
export function validateSelectorDecisions(args: {
  decision: RoutingDecision;
  fallbackDecision?: RoutingDecision;
  candidates: RoutingCandidate[];
  modelFallbackEnabled?: boolean;
  fallbackRequiresDifferentProvider?: boolean;
  providerForModel?: (model: string) => string;
}): void {
  const selected = {
    model: args.decision.selectedModel,
    reasoningEffort: args.decision.reasoningEffort,
  };
  if (!args.candidates.some((candidate) => sameRoutingCandidate(candidate, selected))) {
    throw new RouterCoreError(
      "selector_output",
      "Selector returned a model/thinking-level pair outside this router's candidates.",
      "selector_invalid_candidate",
    );
  }
  const resolveProvider = args.providerForModel ?? providerForModel;
  const eligibleFallbacks = args.candidates.filter(
    (candidate) =>
      candidate.model !== selected.model &&
      (!args.fallbackRequiresDifferentProvider ||
        resolveProvider(candidate.model) !== resolveProvider(selected.model)),
  );
  if (args.modelFallbackEnabled) {
    if (!args.fallbackDecision && eligibleFallbacks.length > 0) {
      throw new RouterCoreError(
        "selector_output",
        "Selector response missing an eligible fallback model.",
        "selector_invalid_response",
      );
    }
    if (args.fallbackDecision) {
      const fallback = {
        model: args.fallbackDecision.selectedModel,
        reasoningEffort: args.fallbackDecision.reasoningEffort,
      };
      if (!eligibleFallbacks.some((candidate) => sameRoutingCandidate(candidate, fallback))) {
        throw new RouterCoreError(
          "selector_output",
          "Selector returned an ineligible fallback model/thinking-level pair.",
          "selector_invalid_candidate",
        );
      }
    }
  }
}
