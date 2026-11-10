import { expect, test } from "bun:test";

import {
  routingBillingProviderAttemptFacts,
  RoutingBillingFinalization,
} from "./billing_finalization.js";

test("the first freeze wins and every later freeze reads the same payload", () => {
  const finalization = createFinalization();
  const firstTerminal = finalization.freeze("completed", [], null);
  const secondTerminal = finalization.freeze(
    "provider_failed",
    [attemptFacts({ model: "should-not-win" })],
    1,
  );
  const first = firstTerminal.readPayload();

  expect(secondTerminal).toBe(firstTerminal);
  expect(secondTerminal.readPayload()).toEqual(first);
  expect(first).toMatchObject({
    request_id: "req_1",
    organization_id: "org_1",
    terminal_outcome: "completed",
    provider_attempts: [],
    benchmark_replay_cost_usd: null,
    benchmark_pricing_known: false,
  });
  expect(Number.isFinite(Date.parse(first.finalized_at))).toBe(true);
});

test("preserves raw monetary strings and requires all authoritative components", () => {
  const message = { responseId: "provider_1" };
  const usage = {
    input: 10,
    cacheRead: 2,
    cacheWrite: 3,
    output: 4,
    totalTokens: 19,
    cost: {
      input: 1e-8,
      cacheRead: 0.000000003,
      cacheWrite: 0.000000004,
      output: 0.000000005,
      total: 0.000000022,
    },
  };
  const facts = (
    overrides: Partial<Parameters<typeof routingBillingProviderAttemptFacts>[0]> = {},
  ) =>
    attemptFacts({
      providerMessage: message,
      usage,
      providerPricingKnown: true,
      ...overrides,
    });

  expect(facts()).toMatchObject({
    provider_request_id: "provider_1",
    provider_input_cost_usd: "1e-8",
    provider_cache_read_cost_usd: "3e-9",
    provider_cache_write_cost_usd: "4e-9",
    provider_output_cost_usd: "5e-9",
    provider_cost_usd: "2.2e-8",
    provider_pricing_known: true,
  });
  expect(
    facts({ usage: { ...usage, cost: { ...usage.cost, cacheWrite: undefined } } }),
  ).toMatchObject({
    provider_input_cost_usd: null,
    provider_cache_read_cost_usd: null,
    provider_cache_write_cost_usd: null,
    provider_output_cost_usd: null,
    provider_cost_usd: null,
    provider_pricing_known: false,
  });
  expect(
    facts({ usage: { ...usage, input: -1 } }).provider_input_tokens,
  ).toBeNull();
});

function attemptFacts(
  changes: Partial<Parameters<typeof routingBillingProviderAttemptFacts>[0]> = {},
) {
  return routingBillingProviderAttemptFacts({
    provider: "openai",
    model: "openai/model",
    providerKeySource: "managed",
    attempt: 1,
    outcome: "completed",
    providerMessage: null,
    usage: null,
    providerPricingKnown: false,
    ...changes,
  });
}

function createFinalization(): RoutingBillingFinalization {
  return new RoutingBillingFinalization({
    requestId: "req_1",
    organizationId: "org_1",
  });
}
