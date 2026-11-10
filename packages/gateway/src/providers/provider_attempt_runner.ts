import type { NextSubscription } from "../platform/platform.js";
import { subscriptionUsageLimitFromFailure } from "./subscription_limits.js";

export type ProviderAttemptFailure =
  | {
      kind: "provider_failed";
      message: Record<string, unknown>;
      latencyMs: number;
      retryable: boolean;
      // The plan that replaced an exhausted one; the same request is retried
      // on it at once.
      nextSubscription?: NextSubscription;
    }
  | {
      kind: "customer_canceled";
      message: Record<string, unknown>;
      latencyMs: number;
      retryable: false;
    };

export type ProviderAttemptResult<T> =
  | { kind: "succeeded"; value: T; latencyMs: number }
  | ProviderAttemptFailure;

export type ProviderAttemptPlanResult<TChoice, TValue> = {
  choice: TChoice;
  attempt: number;
  latencyMs: number;
} & (
  | { kind: "succeeded"; value: TValue }
  | { kind: "provider_failed"; failure: Record<string, unknown> }
  | { kind: "customer_canceled"; failure: Record<string, unknown> }
);

type RunProviderAttemptPlanArgs<TChoice, TValue, TInitial> = {
  primary: TChoice;
  retries: number;
  primaryInitial?: TInitial;
  isCustomerCanceled: (choice: TChoice) => boolean;
  canceledFailure: () => Record<string, unknown>;
  runAttempt: (args: {
    choice: TChoice;
    attempt: number;
    initial: TInitial | undefined;
  }) => Promise<ProviderAttemptResult<TValue>>;
  recordFailedAttempt: (args: {
    choice: TChoice;
    attempt: number;
    result: ProviderAttemptFailure;
  }) => void;
  // The choice served by another of the user's plans; without it a failure
  // naming one is not retried on it.
  onSubscription?: (choice: TChoice, next: NextSubscription) => TChoice;
};

type ChoiceResult<TChoice, TValue> = ProviderAttemptPlanResult<TChoice, TValue>;

/**
 * Owns the order-sensitive provider plan shared by completion and stream setup:
 * retries within the choice, cancellation fences between attempts, and one
 * contiguous attempt record for every failed dispatch.
 */
export async function runProviderAttemptPlan<TChoice, TValue, TInitial>(
  args: RunProviderAttemptPlanArgs<TChoice, TValue, TInitial>,
): Promise<ProviderAttemptPlanResult<TChoice, TValue>> {
  if (!Number.isSafeInteger(args.retries) || args.retries < 0) {
    throw new Error("Provider retries must be a nonnegative integer.");
  }
  const primary = await runChoice(args, args.primary, args.primaryInitial);
  if (primary.kind !== "provider_failed") return primary;
  // The user's next subscription serves the client's retry of this choice, so
  // the failure stands even if the client has already gone.
  if (subscriptionUsageLimitFromFailure(primary.failure)?.switched === true) return primary;
  // A client that disconnected while the plan settled is a cancellation,
  // attributed to the only choice that was dispatched.
  if (args.isCustomerCanceled(args.primary)) {
    return syntheticCancellation(args, {
      choice: args.primary,
      attempt: primary.attempt + 1,
      latencyMs: primary.latencyMs,
    });
  }
  return primary;
}

async function runChoice<TChoice, TValue, TInitial>(
  args: RunProviderAttemptPlanArgs<TChoice, TValue, TInitial>,
  firstChoice: TChoice,
  initial: TInitial | undefined,
): Promise<ChoiceResult<TChoice, TValue>> {
  let choice = firstChoice;
  let latencyMs = 0;
  let lastFailure: Record<string, unknown> | null = null;
  let lastAttempt = 0;

  // A switch to another plan retries without spending the retry budget; each
  // switch holds a plan, so switches are bounded by the plans connected.
  let maxAttempts = args.retries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastAttempt = attempt;
    if (attempt !== 1 || initial === undefined) {
      if (args.isCustomerCanceled(choice)) {
        return syntheticCancellation(args, { choice, attempt, latencyMs });
      }
    }

    const result = await args.runAttempt({
      choice,
      attempt,
      initial: attempt === 1 ? initial : undefined,
    });
    latencyMs += result.latencyMs;
    if (result.kind === "succeeded") {
      return { kind: "succeeded", choice, attempt, latencyMs, value: result.value };
    }

    args.recordFailedAttempt({ choice, attempt, result });
    lastFailure = result.message;
    if (result.kind === "customer_canceled") {
      return {
        kind: "customer_canceled",
        choice,
        attempt,
        latencyMs,
        failure: result.message,
      };
    }
    if (result.kind === "provider_failed" && result.nextSubscription !== undefined && args.onSubscription) {
      choice = args.onSubscription(choice, result.nextSubscription);
      maxAttempts += 1;
      continue;
    }
    if (!result.retryable) break;
  }

  if (lastFailure === null) {
    throw new Error("Provider attempt plan completed without an attempt.");
  }

  return {
    kind: "provider_failed",
    choice,
    attempt: lastAttempt,
    latencyMs,
    failure: lastFailure,
  };
}

function syntheticCancellation<TChoice, TValue, TInitial>(
  args: RunProviderAttemptPlanArgs<TChoice, TValue, TInitial>,
  state: { choice: TChoice; attempt: number; latencyMs: number },
): ProviderAttemptPlanResult<TChoice, TValue> {
  return {
    kind: "customer_canceled",
    ...state,
    failure: args.canceledFailure(),
  };
}
