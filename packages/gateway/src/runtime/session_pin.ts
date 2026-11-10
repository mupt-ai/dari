import type { RoutingDecision } from "@mupt-ai/dari-router/policy-engine";

import { gatewayPlatform } from "../platform/platform.js";
import type { RoutedDecision } from "../strategies/route_decision.js";
import type { ServedDecision } from "../types.js";
import type { PreparedRoutedCompletion } from "./prepare_routed_completion.js";
import { canServeCommittedPair } from "./routing_lease.js";

// The session's pinned pair, while this request may still serve it. A pin
// that can no longer serve (model disabled, credits exhausted, image input on
// a text-only model) falls through to selection, which moves the pin.
export function sessionPinHoldDecision(
  prepared: PreparedRoutedCompletion,
): ServedDecision | null {
  const pin = prepared.sessionPin?.pin;
  if (pin === null || pin === undefined) return null;
  if (!canServeCommittedPair(prepared, pin)) return null;
  return {
    selectedModel: pin.model,
    reasoningEffort: pin.reasoningEffort,
    reason: `Session pin: ${pin.model}/${pin.reasoningEffort} serves this whole session.`,
    sessionPinned: true,
  };
}

// A pinned session never holds leases: the pin outlives any countdown.
export function sessionPinnedSelection(routed: RoutedDecision): RoutedDecision {
  const pinned = (decision: RoutingDecision): ServedDecision => ({ ...unleased(decision), sessionPinned: true });
  return {
    ...routed,
    decision: pinned(routed.decision),
    ...(routed.run === undefined ? {} : { run: { ...routed.run, decision: pinned(routed.run.decision) } }),
  };
}

function unleased(decision: RoutingDecision): RoutingDecision {
  const { leaseTurnsRemaining: _, ...rest } = decision;
  return rest;
}

// A failed write only costs the pin: the next turn selects again.
export async function pinSession(
  prepared: PreparedRoutedCompletion,
  decision: RoutingDecision,
): Promise<void> {
  if (prepared.sessionPin === undefined) return;
  const pin = { model: decision.selectedModel, reasoningEffort: decision.reasoningEffort };
  try {
    await gatewayPlatform().writeSessionPin({
      routerId: prepared.routerId,
      pinKey: prepared.sessionPin.key,
      ...pin,
    });
  } catch (error) {
    gatewayPlatform().captureOperationalError(error, {
      code: "session_pin_write_failed",
      requestId: prepared.requestId,
      routerId: prepared.routerId,
    });
  }
}
