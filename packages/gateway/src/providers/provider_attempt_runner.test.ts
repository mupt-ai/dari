import { expect, test } from "bun:test";

import {
  runProviderAttemptPlan,
  type ProviderAttemptFailure,
  type ProviderAttemptResult,
} from "./provider_attempt_runner.js";

type Choice = "primary";

test("owns retries, latency, and failed-attempt recording", async () => {
  const calls: Array<{ choice: Choice; attempt: number }> = [];
  const recorded: Array<{ choice: Choice; attempt: number; kind: string }> = [];
  const results: ProviderAttemptResult<string>[] = [
    failed("primary-1", 3),
    failed("primary-2", 5),
    { kind: "succeeded", value: "served", latencyMs: 7 },
  ];

  const result = await runProviderAttemptPlan<Choice, string, never>({
    primary: "primary",
    retries: 2,
    isCustomerCanceled: () => false,
    canceledFailure: () => ({ errorMessage: "canceled" }),
    async runAttempt({ choice, attempt }) {
      calls.push({ choice, attempt });
      const next = results.shift();
      if (next === undefined) throw new Error("Missing scripted result.");
      return next;
    },
    recordFailedAttempt({ choice, attempt, result: failure }) {
      recorded.push({ choice, attempt, kind: failure.kind });
    },
  });

  expect(result).toEqual({
    kind: "succeeded",
    choice: "primary",
    attempt: 3,
    latencyMs: 15,
    value: "served",
  });
  expect(calls).toEqual([
    { choice: "primary", attempt: 1 },
    { choice: "primary", attempt: 2 },
    { choice: "primary", attempt: 3 },
  ]);
  expect(recorded).toEqual([
    { choice: "primary", attempt: 1, kind: "provider_failed" },
    { choice: "primary", attempt: 2, kind: "provider_failed" },
  ]);
});

test("returns the final failure once retries are exhausted", async () => {
  let dispatched = 0;
  const result = await runProviderAttemptPlan<Choice, string, never>({
    primary: "primary",
    retries: 1,
    isCustomerCanceled: () => false,
    canceledFailure: () => ({ errorMessage: "canceled" }),
    async runAttempt() {
      dispatched += 1;
      return failed(`primary-${dispatched}`, 2);
    },
    recordFailedAttempt() {},
  });

  expect(result).toEqual({
    kind: "provider_failed",
    choice: "primary",
    attempt: 2,
    latencyMs: 4,
    failure: { errorMessage: "primary-2" },
  });
  expect(dispatched).toBe(2);
});

test("attributes a disconnect after the final failed attempt to the primary", async () => {
  let canceled = false;
  let dispatched = 0;
  const recorded: Array<{ choice: Choice; attempt: number; kind: string }> = [];

  const result = await runProviderAttemptPlan<Choice, string, never>({
    primary: "primary",
    retries: 0,
    isCustomerCanceled: () => canceled,
    canceledFailure: () => ({ errorMessage: "canceled" }),
    async runAttempt() {
      dispatched += 1;
      canceled = true;
      return failed("primary failed", 4);
    },
    recordFailedAttempt({ choice, attempt, result: failure }) {
      recorded.push({ choice, attempt, kind: failure.kind });
    },
  });

  expect(result).toMatchObject({
    kind: "customer_canceled",
    choice: "primary",
    attempt: 2,
    latencyMs: 4,
  });
  expect(dispatched).toBe(1);
  expect(recorded).toEqual([
    { choice: "primary", attempt: 1, kind: "provider_failed" },
  ]);
});

test("does not fabricate a primary attempt when canceled before first dispatch", async () => {
  let dispatched = 0;
  const recorded: string[] = [];
  const result = await runProviderAttemptPlan<Choice, string, never>({
    primary: "primary",
    retries: 2,
    isCustomerCanceled: () => true,
    canceledFailure: () => ({ errorMessage: "canceled" }),
    async runAttempt() {
      dispatched += 1;
      return { kind: "succeeded", value: "unexpected", latencyMs: 1 };
    },
    recordFailedAttempt({ result: failure }) {
      recorded.push(failure.kind);
    },
  });

  expect(result).toMatchObject({ kind: "customer_canceled", choice: "primary" });
  expect(dispatched).toBe(0);
  expect(recorded).toEqual([]);
});

test("an already-started speculative attempt settles before cancellation is checked", async () => {
  let dispatchedInitial: string | undefined;
  const result = await runProviderAttemptPlan<Choice, string, string>({
    primary: "primary",
    retries: 0,
    primaryInitial: "speculative",
    isCustomerCanceled: () => true,
    canceledFailure: () => ({ errorMessage: "canceled" }),
    async runAttempt({ initial }) {
      dispatchedInitial = initial;
      return { kind: "succeeded", value: "settled", latencyMs: 2 };
    },
    recordFailedAttempt() {},
  });

  expect(dispatchedInitial).toBe("speculative");
  expect(result).toMatchObject({ kind: "succeeded", value: "settled" });
});

// An exhausted plan names the next one: the same request is retried on it at
// once, without spending the router's retry budget, and the result reports
// the choice that served.
test("retries on the next plan when an exhausted one names it", async () => {
  type PlanChoice = { plan: string };
  const dispatched: string[] = [];
  const result = await runProviderAttemptPlan<PlanChoice, string, never>({
    primary: { plan: "a" },
    retries: 0,
    isCustomerCanceled: () => false,
    canceledFailure: () => ({ errorMessage: "canceled" }),
    async runAttempt({ choice }) {
      dispatched.push(choice.plan);
      if (choice.plan === "a") {
        return {
          kind: "provider_failed",
          message: { errorMessage: "usage limit" },
          latencyMs: 1,
          retryable: false,
          nextSubscription: { credentialId: "cred_b", apiKey: "b" },
        };
      }
      return { kind: "succeeded", value: "served", latencyMs: 2 };
    },
    recordFailedAttempt() {},
    onSubscription: (_choice, next) => ({ plan: next.apiKey }),
  });
  expect(dispatched).toEqual(["a", "b"]);
  expect(result).toEqual({ kind: "succeeded", choice: { plan: "b" }, attempt: 2, latencyMs: 3, value: "served" });
});

function failed(message: string, latencyMs: number): ProviderAttemptFailure {
  return {
    kind: "provider_failed",
    message: { errorMessage: message },
    latencyMs,
    retryable: true,
  };
}
