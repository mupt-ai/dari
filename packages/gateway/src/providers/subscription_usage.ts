import { isRecord, pricingForPrompt, providerMinCacheTokens, type ModelPricing } from "@mupt-ai/dari-router/policy-engine";

// The ChatGPT subscription backend reports cached prompt tokens but never
// cache_write_tokens, so every fresh token lands in the input bucket and is
// priced at the input rate. The public API bills those tokens as cache writes
// (the GPT-5.6 family accepts only 24h extended caching, and its responses
// report a write within a few tokens of the fresh count), so subscription rows
// otherwise read as $0.00 cache write while the identical API request records
// the premium. Attribute them here, where the provider identity and the
// pricing pi-ai used are both known, so telemetry, client usage, and the
// estimator — which already prices fresh input at the cache-write rate — agree.
const SUBSCRIPTION_RESPONSES_API = "openai-codex-responses";

const MTOK = 1_000_000;

export type SubscriptionUsageContext = {
  api: string;
  model: string;
  pricing: ModelPricing | null;
};

export function messageWithSubscriptionCacheWrites(
  message: Record<string, unknown>,
  context: SubscriptionUsageContext
): Record<string, unknown> {
  const usage = subscriptionCacheWriteUsage(message.usage, context);
  return usage === message.usage ? message : { ...message, usage };
}

// Every stream consumer reads final usage off the terminal `done` message.
export async function* eventsWithSubscriptionCacheWrites(
  events: AsyncIterable<Record<string, unknown>>,
  context: SubscriptionUsageContext
): AsyncIterable<Record<string, unknown>> {
  for await (const event of events) {
    if (event.type === "done" && isRecord(event.message)) {
      yield { ...event, message: messageWithSubscriptionCacheWrites(event.message, context) };
      continue;
    }
    yield event;
  }
}

export function subscriptionCacheWriteUsage(
  usage: unknown,
  context: SubscriptionUsageContext
): unknown {
  if (context.api !== SUBSCRIPTION_RESPONSES_API || !isRecord(usage)) return usage;
  const pricing = context.pricing === null ? null : pricingForPrompt(context.pricing,
    (finiteNumber(usage.input) ?? 0) + (finiteNumber(usage.cacheRead) ?? 0) + (finiteNumber(usage.cacheWrite) ?? 0));
  // Without a write premium the buckets price identically, so moving tokens
  // between them would change the report without changing the cost.
  if (!pricing || !(pricing.cacheWrite > pricing.input)) return usage;

  const input = finiteNumber(usage.input) ?? 0;
  const cacheRead = finiteNumber(usage.cacheRead) ?? 0;
  const cacheWrite = finiteNumber(usage.cacheWrite) ?? 0;
  // A reported write means this backend did account for the bucket; leave it.
  if (cacheWrite > 0 || input <= 0) return usage;
  // Prompts under the provider minimum are never cached, so their fresh tokens
  // are genuinely plain input. This path is gated to the OpenAI subscription
  // API above, so the execution provider is openai by construction.
  if (input + cacheRead < providerMinCacheTokens(context.model, "openai")) return usage;

  const cost = isRecord(usage.cost) ? usage.cost : {};
  const outputCost = finiteNumber(cost.output) ?? 0;
  const cacheReadCost = finiteNumber(cost.cacheRead) ?? 0;
  const cacheWriteCost = (input * pricing.cacheWrite) / MTOK;
  return {
    ...usage,
    input: 0,
    cacheWrite: input,
    cost: {
      ...cost,
      input: 0,
      cacheRead: cacheReadCost,
      cacheWrite: cacheWriteCost,
      output: outputCost,
      total: outputCost + cacheReadCost + cacheWriteCost,
    },
  };
}

export function modelPricingFromPiModel(model: Record<string, unknown>): ModelPricing | null {
  const cost = model.cost;
  if (!isRecord(cost)) return null;
  const input = finiteNumber(cost.input);
  const output = finiteNumber(cost.output);
  const cacheRead = finiteNumber(cost.cacheRead);
  const cacheWrite = finiteNumber(cost.cacheWrite);
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null;
  const tiers = Array.isArray(cost.tiers) ? cost.tiers.filter((tier): tier is NonNullable<ModelPricing["tiers"]>[number] =>
    isRecord(tier) && [tier.inputTokensAbove, tier.input, tier.output, tier.cacheRead, tier.cacheWrite].every((rate) => finiteNumber(rate) !== null)) : [];
  return { input, output, cacheRead, cacheWrite, ...(tiers.length ? { tiers } : {}) };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
