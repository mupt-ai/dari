import type { Provider } from "@mupt-ai/dari-router/policy-engine";
import { randomUUID } from "node:crypto";

import { HttpError } from "../http/errors.js";
import { executionProviderForModel, keySourceForModel } from "../models/execution_provider.js";
import { captureOperationalError } from "../observability/errors.js";
import { gatewayPlatform, type RequestTags } from "../platform/platform.js";
import type { ProviderKeySource, ResolvedRouter } from "../types.js";

export type RoutingUsageContext = {
  organizationId: string;
  routerId: string;
  provider: Provider;
  model: string;
  tags: RequestTags;
  startedAt: Date;
};

/**
 * Reject requests that need model selection when the organization is not on
 * the Autorouting plan. Without it, Gateway serves only routers with a single
 * model and thinking level, which never invoke the selector.
 */
export function assertAutoroutingAllowed(credentials: ResolvedRouter, selects: boolean): void {
  if (selects && credentials.autorouting_enabled === false) {
    throw new HttpError(
      402,
      "Autorouting requires the Autorouting plan. Subscribe at https://app.dari.dev/usage, or keep one model and thinking level on this router.",
      "autorouting_plan_required",
    );
  }
}

/**
 * Whether the router offers more than one model/thinking-level pair. A model
 * without listed levels serves every level it supports, so it counts as
 * selecting, matching candidate preparation and the CLI.
 */
export function routerSelectsModels(credentials: ResolvedRouter): boolean {
  let pairs = 0;
  for (const model of credentials.enabled_models) {
    const levels = credentials.model_thinking_levels?.[model]?.length ?? 0;
    if (levels === 0) return true;
    pairs += levels;
  }
  return pairs > 1;
}

/**
 * Reject billable requests before the routing decision once the org's
 * credits are exhausted, unless a personal subscription serves one of the
 * router's models: those owe no credits, so they keep serving and routing
 * narrows to them. Managed and own-key requests stay gated (own-key requests
 * owe the router fee), and refusing before selection keeps an exhausted org
 * from burning selector-model spend.
 */
export function assertCreditAvailableBeforeRouting(billable: boolean, credentials: ResolvedRouter): void {
  if (
    billable &&
    credentials.credit_exhausted &&
    !credentials.enabled_models.some((model) => keySourceForModel(credentials, model) === "subscription")
  ) {
    throw creditExhaustedError();
  }
}

/**
 * Decide whether this routed call bills org credits: returns the usage
 * context for billable managed-key selections and undefined otherwise.
 * Throws 402 when the selection needs a managed key while the org's
 * credits are exhausted.
 */
export function usageContextFor(args: {
  billable: boolean;
  credentials: ResolvedRouter;
  routerId: string;
  selectedModel: string;
  keySource: ProviderKeySource;
  tags: RequestTags;
}): RoutingUsageContext | undefined {
  if (!args.billable || args.keySource !== "managed") return undefined;
  if (args.credentials.credit_exhausted) throw creditExhaustedError();
  return {
    organizationId: args.credentials.organization_id,
    routerId: args.routerId,
    provider: executionProviderForModel(args.credentials, args.selectedModel),
    model: args.selectedModel,
    tags: args.tags,
    startedAt: new Date(),
  };
}

/**
 * Bill one managed-key routed call to the org's credits through the
 * platform. Stream billing calls this from the protocol stream's onFinal hook; the
 * non-stream path awaits it before responding. Never throws: the provider
 * spend already happened, so a recording failure must not fail an
 * otherwise-successful completion — it is logged and reported operationally
 * instead.
 */
export async function reportRoutingUsage(context: RoutingUsageContext, message: Record<string, unknown>): Promise<void> {
  const payload = usagePayload(context, message);
  if (payload.total_cost_usd === "0") {
    console.error("Routing usage billed at zero cost; model pricing may be missing.", usageLogFields(payload));
  }
  try {
    await gatewayPlatform().recordUsage(payload);
  } catch (error) {
    reportUsageFailure(error, payload);
  }
}

function reportUsageFailure(
  error: unknown,
  payload: Record<string, unknown>,
): void {
  console.error("Routing usage not recorded.", usageLogFields(payload));
  captureOperationalError(error, {
    code: "billing_usage_report_failed",
    routerId:
      typeof payload.router_id === "string" ? payload.router_id : undefined,
  });
}

export function creditExhaustedError(): HttpError {
  return new HttpError(402, "Organization credits are exhausted.", "credit_exhausted");
}

function usagePayload(context: RoutingUsageContext, message: Record<string, unknown>): Record<string, unknown> {
  const usage = isRecord(message.usage) ? message.usage : {};
  const cost = isRecord(usage.cost) ? usage.cost : {};
  const responseId = typeof message.responseId === "string" && message.responseId ? message.responseId : undefined;
  return {
    organization_id: context.organizationId,
    router_id: context.routerId,
    provider: context.provider,
    model: context.model,
    provider_request_id: responseId ?? `routing-${randomUUID()}`,
    input_tokens: tokens(usage.input),
    cached_input_tokens: tokens(usage.cacheRead),
    output_tokens: tokens(usage.output),
    usage_estimated: usage.estimated === true,
    input_cost_usd: usd(cost.input),
    cached_input_cost_usd: usd(cost.cacheRead),
    output_cost_usd: usd(cost.output),
    total_cost_usd: usd(cost.total) ?? "0",
    started_at: context.startedAt.toISOString(),
    ended_at: new Date().toISOString(),
    tags: context.tags,
  };
}

function usageLogFields(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    organization_id: payload.organization_id,
    router_id: payload.router_id,
    provider_request_id: payload.provider_request_id,
    model: payload.model,
    total_cost_usd: payload.total_cost_usd,
  };
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function usd(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
