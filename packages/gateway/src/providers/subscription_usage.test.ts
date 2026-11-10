import { expect, test } from "bun:test";

import {
  eventsWithSubscriptionCacheWrites,
  messageWithSubscriptionCacheWrites,
  modelPricingFromPiModel,
  subscriptionCacheWriteUsage,
} from "./subscription_usage.js";

const SOL_PRICING = { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 };
const SOL = { api: "openai-codex-responses", model: "openai/gpt-5.6-sol", pricing: SOL_PRICING };

// A subscription turn mid-conversation: cached prefix read back, fresh tail
// reported as plain input because the backend omits cache_write_tokens.
function subscriptionUsage() {
  return {
    input: 7321,
    output: 222,
    cacheRead: 70144,
    cacheWrite: 0,
    totalTokens: 77687,
    cost: {
      input: 0.029284,
      output: 0.00444,
      cacheRead: 0.0280576,
      cacheWrite: 0,
      total: 0.0617816,
    },
  };
}

test("attributes fresh subscription tokens to the cache-write bucket", () => {
  const usage = subscriptionCacheWriteUsage(subscriptionUsage(), SOL) as Record<string, number>;

  expect(usage.input).toBe(0);
  expect(usage.cacheWrite).toBe(7321);
  expect(usage.cacheRead).toBe(70144);
  expect(usage.output).toBe(222);
});

test("reprices the moved tokens at the cache-write rate", () => {
  const usage = subscriptionCacheWriteUsage(subscriptionUsage(), SOL) as {
    cost: Record<string, number>;
  };

  expect(usage.cost.input).toBe(0);
  expect(usage.cost.cacheWrite).toBeCloseTo(0.036605, 10);
  expect(usage.cost.cacheRead).toBeCloseTo(0.0280576, 10);
  expect(usage.cost.total).toBeCloseTo(0.036605 + 0.0280576 + 0.00444, 10);
});

test("leaves usage alone when the backend reported its own cache writes", () => {
  const reported = { ...subscriptionUsage(), input: 3, cacheWrite: 7318 };

  expect(subscriptionCacheWriteUsage(reported, SOL)).toBe(reported);
});

test("leaves API-served calls alone", () => {
  const usage = subscriptionUsage();

  expect(subscriptionCacheWriteUsage(usage, { ...SOL, api: "openai-responses" })).toBe(usage);
});

test("leaves models without a cache-write premium alone", () => {
  const usage = subscriptionUsage();
  const flat = { ...SOL, pricing: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 4 } };

  expect(subscriptionCacheWriteUsage(usage, flat)).toBe(usage);
});

test("leaves prompts below the provider cache minimum alone", () => {
  const usage = { ...subscriptionUsage(), input: 400, cacheRead: 0, totalTokens: 622 };

  expect(subscriptionCacheWriteUsage(usage, SOL)).toBe(usage);
});

test("leaves fully cached turns alone", () => {
  const usage = { ...subscriptionUsage(), input: 0 };

  expect(subscriptionCacheWriteUsage(usage, SOL)).toBe(usage);
});

test("rewrites the message usage in place", () => {
  const message = { stopReason: "stop", usage: subscriptionUsage() };
  const rewritten = messageWithSubscriptionCacheWrites(message, SOL);

  expect(rewritten.stopReason).toBe("stop");
  expect((rewritten.usage as { cacheWrite: number }).cacheWrite).toBe(7321);
  expect(message.usage.cacheWrite).toBe(0);
});

test("rewrites the terminal stream event and passes the rest through", async () => {
  async function* events() {
    yield { type: "start" };
    yield { type: "text", text: "OK" };
    yield { type: "done", message: { stopReason: "stop", usage: subscriptionUsage() } };
  }

  const seen: Array<Record<string, unknown>> = [];
  for await (const event of eventsWithSubscriptionCacheWrites(events(), SOL)) seen.push(event);

  expect(seen.map((event) => event.type)).toEqual(["start", "text", "done"]);
  expect(seen[1]).toEqual({ type: "text", text: "OK" });
  const usage = (seen[2].message as { usage: Record<string, number> }).usage;
  expect(usage.cacheWrite).toBe(7321);
  expect(usage.input).toBe(0);
});

test("leaves streams whose terminal event carries no message alone", async () => {
  async function* events() {
    yield { type: "error", error: { message: "boom" } };
  }

  const seen: Array<Record<string, unknown>> = [];
  for await (const event of eventsWithSubscriptionCacheWrites(events(), SOL)) seen.push(event);

  expect(seen).toEqual([{ type: "error", error: { message: "boom" } }]);
});

test("reads the pricing pi-ai used off the built model", () => {
  expect(modelPricingFromPiModel({ cost: SOL_PRICING })).toEqual(SOL_PRICING);
  expect(modelPricingFromPiModel({ cost: { input: 5, output: 30 } })).toBeNull();
  expect(modelPricingFromPiModel({})).toBeNull();
});
