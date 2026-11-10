import {
  FIXED_TURN_COST_COMPARISON_TURNS,
  LEASE_DECISION_TURN_LAG,
  type ChatMessage,
  type PreviousDecision,
  type RoutingDecision,
} from "@mupt-ai/dari-router/policy-engine";

import type { SelectorBackend } from "../strategies/routing.js";
import {
  routeDecision,
  type RoutedDecision,
} from "../strategies/route_decision.js";
import { reportPendingLease } from "../telemetry/prefix_state.js";
import { scrubSecrets } from "../telemetry/scrub.js";
import type { PreparedRoutedCompletion } from "./prepare_routed_completion.js";

export type RoutingLeaseDecision = {
  decision: RoutingDecision;
  completedTurns: number;
  turnInLease: number;
};

export function leasedRoutingDecision(args: {
  messages: ChatMessage[];
  previousDecision?: PreviousDecision;
}): RoutingLeaseDecision | null {
  if (!args.previousDecision) return null;
  const completedTurns = args.messages.filter(
    (message) => message.role === "assistant",
  ).length;
  const completedInLease = completedTurns % FIXED_TURN_COST_COMPARISON_TURNS;
  if (completedInLease === 0) return null;

  return {
    decision: {
      selectedModel: args.previousDecision.model,
      reasoningEffort: args.previousDecision.reasoningEffort,
      reason:
        args.previousDecision.reason ||
        `Continuing the current ${FIXED_TURN_COST_COMPARISON_TURNS}-turn routing lease.`,
    },
    completedTurns,
    turnInLease: completedInLease + 1,
  };
}

// The selector's ten-turn projection is only valid when its action owns ten
// turns. Deriving lease position from the request keeps production behavior
// stateless across gateway instances and process restarts.
export function leasedDecision(
  prepared: PreparedRoutedCompletion,
): RoutedDecision | null {
  const lease = leasedRoutingDecision({
    messages: prepared.routing.selectorMessages,
    previousDecision: prepared.routing.previousDecision,
  });
  if (!lease) return null;
  // Hold only a pair this request may still serve: a custom router whose
  // rules no longer allow it (or no longer resolve) must reselect.
  const held = prepared.routing.candidateResolution.candidates.some(
    (candidate) =>
      candidate.model === lease.decision.selectedModel &&
      candidate.reasoningEffort === lease.decision.reasoningEffort,
  );
  if (!held) return null;

  // Billable traffic must reselect when credits are exhausted so a managed
  // incumbent cannot hide an available user-owned key behind the lease.
  if (prepared.billable && prepared.credentials.credit_exhausted) return null;

  prepared.reporter.attachServingDecision(lease.decision);
  prepared.reporter.attachDecisionDetails({
    decision_source: "lease_hold",
    routing_lease: {
      lease_turns: FIXED_TURN_COST_COMPARISON_TURNS,
      completed_turns: lease.completedTurns,
      turn_in_lease: lease.turnInLease,
    },
  });
  return { decision: lease.decision };
}

export async function selectorNegotiatesLeases(
  backend: SelectorBackend,
): Promise<boolean> {
  if (backend.negotiatedLeaseTurns === undefined) return false;
  return (await backend.negotiatedLeaseTurns()).length > 0;
}

// Upper bound on how long the adoption turn waits for its consume-clear.
const PENDING_LEASE_CLEAR_WAIT_MS = 1500;

function withTimeout(task: Promise<void>, capMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, capMs);
    const settle = () => {
      clearTimeout(timer);
      resolve();
    };
    void task.then(settle, settle);
  });
}

// Runs the routing decision for the next lease against this turn's state and
// stamps the result onto the conversation's prefix rows. Failures only cost
// the prefetch: expiry falls back to a synchronous decision.
export async function prefetchNextLease(
  prepared: PreparedRoutedCompletion,
  selectorBackend: SelectorBackend,
): Promise<void> {
  try {
    const routed = await routeDecision({
      selectorMessages: prepared.routing.selectorMessages,
      selectorImages: prepared.routing.selectorImages,
      resolution: prepared.routing.candidateResolution,
      credentials: prepared.credentials,
      previousDecision: prepared.routing.previousDecision,
      conversationId: prepared.routing.conversationId,
      selectorBackend,
      leaseHistory: prepared.routing.leaseHistory,
    });
    const remaining = routed.decision.leaseTurnsRemaining;
    if (remaining === undefined) {
      console.error("lease prefetch returned a per-turn decision; skipping");
      return;
    }
    await reportPendingLease({
      routerId: prepared.routerId,
      conversationId: prepared.routing.conversationId,
      decidedAtDepth: prepared.routing.leaseDepth,
      lease: {
        model: routed.decision.selectedModel,
        reasoningEffort: routed.decision.reasoningEffort,
        // The strategy assumes its granting turn serves the pair; a
        // prefetched grant starts serving at adoption, so the full grant is
        // stored and adoption stamps remaining = turns - 1.
        turns: remaining + 1,
        reason: routed.decision.reason,
        outputText: routed.run?.outputText ?? null,
      },
    });
  } catch (error) {
    console.error(
      "lease prefetch failed",
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
  }
}

export function leasePrefetchDue(prepared: PreparedRoutedCompletion): boolean {
  return prepared.routing.activeLease?.turnsRemaining === LEASE_DECISION_TURN_LAG;
}

export async function clearPendingLease(
  prepared: PreparedRoutedCompletion,
): Promise<void> {
  await withTimeout(
    reportPendingLease({
      routerId: prepared.routerId,
      conversationId: prepared.routing.conversationId,
      decidedAtDepth: prepared.routing.leaseDepth,
      lease: null,
    }),
    PENDING_LEASE_CLEAR_WAIT_MS,
  );
}

export function canServeCommittedPair(
  prepared: PreparedRoutedCompletion,
  pair: { model: string; reasoningEffort: string },
): boolean {
  if (prepared.billable && prepared.credentials.credit_exhausted) return false;
  return prepared.routing.candidateResolution.candidates.some(
    (candidate) =>
      candidate.model === pair.model &&
      candidate.reasoningEffort === pair.reasoningEffort,
  );
}

// Adopts the lease prefetched before the previous one expired. The pair was
// re-validated against this request's candidates during preparation.
export function pendingLeaseDecision(
  prepared: PreparedRoutedCompletion,
): RoutingDecision | null {
  const pending = prepared.routing.pendingLease;
  if (pending === undefined) return null;
  if (!canServeCommittedPair(prepared, pending)) return null;
  return {
    selectedModel: pending.model,
    reasoningEffort: pending.reasoningEffort,
    // Distinguishable from a synchronous grant in activity and responses:
    // this decision was made turns ago and adopted here without a policy call.
    reason: pending.reason === null
      ? `Prefetched: policy leased ${pending.model}/${pending.reasoningEffort} ` +
        `for ${pending.turns} turns.`
      : `Prefetched: ${pending.reason}`,
    leaseTurnsRemaining: pending.turns - 1,
  };
}

// A leased conversation serves its committed pair without consulting the
// selector: the policy already paid the decision cost when it granted the
// lease, and holding is what keeps the provider cache warm. The lease
// dissolves when its target stops being a candidate (core drops it during
// preparation) or when the countdown reaches zero.
export function leaseHoldDecision(
  prepared: PreparedRoutedCompletion,
): RoutingDecision | null {
  const lease = prepared.routing.activeLease;
  if (lease === undefined) return null;
  if (!canServeCommittedPair(prepared, lease)) return null;
  return {
    selectedModel: lease.model,
    reasoningEffort: lease.reasoningEffort,
    reason: `Lease hold: ${lease.turnsRemaining} committed turns remaining.`,
    leaseTurnsRemaining: lease.turnsRemaining - 1,
  };
}
