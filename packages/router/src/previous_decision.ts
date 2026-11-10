import {
  isReasoningEffort,
  routingCandidateKey,
  type PreviousDecision,
  type RouterPrefixHit,
  type RoutingCandidate,
} from "./types.js";

// A previous decision only carries over when its exact model/thinking-level
// pair is still a candidate for this request.
export function compatiblePreviousDecision(
  previousDecision: PreviousDecision | undefined,
  candidates: RoutingCandidate[],
): PreviousDecision | undefined {
  if (previousDecision === undefined) return undefined;
  const previousKey = routingCandidateKey(previousDecision);
  return candidates.some((candidate) => routingCandidateKey(candidate) === previousKey)
    ? previousDecision
    : undefined;
}

export type ActiveLease = RoutingCandidate & { turnsRemaining: number };

// An unexpired lease from the deepest identity hit. The lease names the stored
// next-turn target exactly; if that pair is no longer a candidate for this
// request, the lease dissolves and routing decides fresh.
export function activeLeaseFromHit(
  entry: RouterPrefixHit,
  candidates: RoutingCandidate[],
): ActiveLease | undefined {
  const remaining = entry.lease_turns_remaining;
  if (typeof remaining !== "number" || !Number.isInteger(remaining) || remaining <= 0) {
    return undefined;
  }
  const nextEffort = entry.next_reasoning_effort;
  if (!entry.next_model || !isReasoningEffort(nextEffort)) return undefined;
  const target = { model: entry.next_model, reasoningEffort: nextEffort };
  const targetKey = routingCandidateKey(target);
  return candidates.some((candidate) => routingCandidateKey(candidate) === targetKey)
    ? { ...target, turnsRemaining: remaining }
    : undefined;
}

export type PendingLease = RoutingCandidate & {
  turns: number;
  reason: string | null;
  outputText: string | null;
};

// The next lease decided ahead of the active one's expiry. Like the active
// lease, it only survives while its exact pair is still a candidate.
export function pendingLeaseFromHit(
  entry: RouterPrefixHit,
  candidates: RoutingCandidate[],
): PendingLease | undefined {
  const turns = entry.pending_lease_turns;
  if (typeof turns !== "number" || !Number.isInteger(turns) || turns <= 0) {
    return undefined;
  }
  const effort = entry.pending_lease_reasoning_effort;
  if (!entry.pending_lease_model || !isReasoningEffort(effort)) return undefined;
  const target = { model: entry.pending_lease_model, reasoningEffort: effort };
  const targetKey = routingCandidateKey(target);
  return candidates.some((candidate) => routingCandidateKey(candidate) === targetKey)
    ? {
        ...target,
        turns,
        reason: entry.pending_lease_reason ?? null,
        outputText: entry.pending_lease_output_text ?? null,
      }
    : undefined;
}

// Reconstructs the previous decision from the deepest warm-prefix entry: the
// stored next-turn recommendation when it is still a candidate, otherwise the
// serving pair.
export function previousDecisionFromHit(
  entry: RouterPrefixHit,
  candidates: RoutingCandidate[],
): PreviousDecision | undefined {
  const candidateKeys = new Set(candidates.map(routingCandidateKey));
  const uniqueCandidateForModel = (model: string): RoutingCandidate | null => {
    const matching = candidates.filter((candidate) => candidate.model === model);
    return matching.length === 1 ? matching[0]! : null;
  };
  const nextEffort = entry.next_reasoning_effort;
  const storedNext = entry.next_model
    ? isReasoningEffort(nextEffort)
      ? { model: entry.next_model, reasoningEffort: nextEffort }
      : uniqueCandidateForModel(entry.next_model)
    : null;
  const serving = isReasoningEffort(entry.reasoning_bucket)
    ? { model: entry.model, reasoningEffort: entry.reasoning_bucket }
    : uniqueCandidateForModel(entry.model);
  const storedNextIsCandidate = Boolean(
    storedNext && candidateKeys.has(routingCandidateKey(storedNext)),
  );
  const selected = storedNext && storedNextIsCandidate
    ? storedNext
    : serving && candidateKeys.has(routingCandidateKey(serving))
      ? serving
      : null;
  if (!selected) return undefined;
  const storedNextWasRejected = Boolean(entry.next_model) && !storedNextIsCandidate;
  return {
    ...selected,
    reason: storedNextWasRejected ? "" : (entry.reason ?? ""),
  };
}
