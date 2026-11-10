import type { InteractionUsage } from "../interaction/types.js";
import type { ProviderKeySource } from "../types.js";
import { finiteNumber, isRecord, tokenCount } from "./ingest_values.js";

const BILLING_EVENT_SCHEMA_VERSION = 1;

export type RoutingBillingTerminalOutcome =
  | "completed"
  | "customer_canceled"
  | "provider_failed"
  | "selection";

export type RoutingBillingProviderAttemptFacts = {
  provider: string;
  model: string;
  provider_key_source: ProviderKeySource;
  // The control-plane billing contract numbers attempts within a role; every
  // attempt retries the routed choice, so the role is always primary.
  role: "primary";
  attempt: number;
  outcome: "completed" | "provider_failed" | "customer_canceled";
  provider_request_id: string | null;
  provider_input_tokens: number | null;
  provider_cache_read_tokens: number | null;
  provider_cache_write_tokens: number | null;
  provider_output_tokens: number | null;
  provider_input_cost_usd: string | null;
  provider_cache_read_cost_usd: string | null;
  provider_cache_write_cost_usd: string | null;
  provider_output_cost_usd: string | null;
  provider_cost_usd: string | null;
  provider_pricing_known: boolean;
  usage_estimated: boolean;
};

export type RoutingBillingFinalizationPayload = {
  request_id: string;
  organization_id: string;
  event_schema_version: 1;
  provider_attempts: RoutingBillingProviderAttemptFacts[];
  benchmark_replay_cost_usd: string | null;
  benchmark_pricing_known: boolean;
  terminal_outcome: RoutingBillingTerminalOutcome;
  finalized_at: string;
};

export type FrozenRoutingBillingTerminal = {
  readPayload(): RoutingBillingFinalizationPayload;
};

type BillingFinalizationIdentity = {
  requestId: string;
  organizationId: string;
};

/**
 * One request-scoped terminal register. The first terminal facts and timestamp
 * win; every later response hook, catch, or duplicate provider terminal event
 * observes the same serialized bytes, which the routing report carries as the
 * request's billing facts.
 */
export class RoutingBillingFinalization {
  private terminal: FrozenRoutingBillingTerminal | null = null;

  constructor(private readonly identity: BillingFinalizationIdentity) {}

  freeze(
    terminalOutcome: RoutingBillingTerminalOutcome,
    providerAttempts: readonly RoutingBillingProviderAttemptFacts[],
    benchmarkReplayCostUsd: number | null,
  ): FrozenRoutingBillingTerminal {
    if (this.terminal !== null) return this.terminal;
    const finalizedAt = new Date().toISOString();
    const benchmarkCost = nonnegativeMoney(benchmarkReplayCostUsd);
    const payload: RoutingBillingFinalizationPayload = {
      request_id: this.identity.requestId,
      organization_id: this.identity.organizationId,
      event_schema_version: BILLING_EVENT_SCHEMA_VERSION,
      provider_attempts: [...providerAttempts],
      benchmark_replay_cost_usd: benchmarkCost,
      benchmark_pricing_known: benchmarkCost !== null,
      terminal_outcome: terminalOutcome,
      finalized_at: finalizedAt,
    };
    const serializedPayload = JSON.stringify(payload);
    const terminal: FrozenRoutingBillingTerminal = {
      readPayload: () =>
        JSON.parse(serializedPayload) as RoutingBillingFinalizationPayload,
    };
    this.terminal = terminal;
    return terminal;
  }
}

export function routingBillingProviderAttemptFacts(args: {
  provider: string;
  model: string;
  providerKeySource: ProviderKeySource;
  attempt: number;
  outcome: "completed" | "provider_failed" | "customer_canceled";
  providerMessage: Record<string, unknown> | null;
  usage: InteractionUsage | Record<string, unknown> | null;
  providerPricingKnown: boolean;
}): RoutingBillingProviderAttemptFacts {
  const usage = args.usage;
  const cost = usage !== null && isRecord(usage.cost) ? usage.cost : null;
  const inputCost = cost === null ? null : nonnegativeMoney(cost.input);
  const cacheReadCost = cost === null ? null : nonnegativeMoney(cost.cacheRead);
  const cacheWriteCost = cost === null ? null : nonnegativeMoney(cost.cacheWrite);
  const outputCost = cost === null ? null : nonnegativeMoney(cost.output);
  const totalCost = cost === null ? null : nonnegativeMoney(cost.total);
  const providerPricingKnown =
    args.providerPricingKnown &&
    inputCost !== null &&
    cacheReadCost !== null &&
    cacheWriteCost !== null &&
    outputCost !== null &&
    totalCost !== null;
  const costs = providerPricingKnown
    ? {
        input: inputCost,
        cacheRead: cacheReadCost,
        cacheWrite: cacheWriteCost,
        output: outputCost,
        total: totalCost,
      }
    : null;

  return {
    provider: args.provider,
    model: args.model,
    provider_key_source: args.providerKeySource,
    role: "primary",
    attempt: args.attempt,
    outcome: args.outcome,
    provider_request_id: providerRequestId(args.providerMessage),
    provider_input_tokens: nonnegativeTokenCount(usage?.input),
    provider_cache_read_tokens: nonnegativeTokenCount(usage?.cacheRead),
    provider_cache_write_tokens: nonnegativeTokenCount(usage?.cacheWrite),
    provider_output_tokens: nonnegativeTokenCount(usage?.output),
    provider_input_cost_usd: costs?.input ?? null,
    provider_cache_read_cost_usd: costs?.cacheRead ?? null,
    provider_cache_write_cost_usd: costs?.cacheWrite ?? null,
    provider_output_cost_usd: costs?.output ?? null,
    provider_cost_usd: costs?.total ?? null,
    provider_pricing_known: providerPricingKnown,
    usage_estimated:
      usage !== null && (usage as Record<string, unknown>).estimated === true,
  };
}

function providerRequestId(message: Record<string, unknown> | null): string | null {
  return message !== null &&
    typeof message.responseId === "string" &&
    message.responseId.length > 0
    ? message.responseId
    : null;
}

function nonnegativeMoney(value: unknown): string | null {
  const number = finiteNumber(value);
  return number === null || number < 0 ? null : String(number);
}

function nonnegativeTokenCount(value: unknown): number | null {
  const count = tokenCount(value);
  return count === null || count < 0 ? null : count;
}
