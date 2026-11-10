import { expect, test } from "bun:test";

import { messageWithProviderReportedCost, providerReportedCostTap, reportedCost } from "./provider_reported_cost.js";

test("reads OpenRouter and Vercel AI Gateway billed cost", () => {
  expect(reportedCost({ usage: { cost: 0.012 } })).toBe(0.012);
  expect(reportedCost({ providerMetadata: { gateway: { cost: "0.0045" } } })).toBe(0.0045);
  expect(reportedCost({ usage: { prompt_tokens: 3 } })).toBeUndefined();
});

test("adds the provider's charge to OpenRouter's fee on a BYOK call", () => {
  const byok = { cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.0412 } };
  expect(reportedCost({ usage: byok })).toBe(0.0412);
  expect(reportedCost({ usage: { ...byok, cost: 0.002 } })).toBeCloseTo(0.0432);
  // Off BYOK, OpenRouter's cost already includes the upstream charge.
  expect(reportedCost({ usage: { ...byok, is_byok: false, cost: 0.0412 } })).toBe(0.0412);
});

test("the tap reads cost from SSE and JSON bodies without changing them", async () => {
  const sse = "data: {\"choices\":[]}\n\ndata: {\"usage\":{\"cost\":0.5}}\n\ndata: [DONE]\n\n";
  const json = JSON.stringify({ usage: { cost: 0.25 } });
  for (const [body, cost] of [[sse, 0.5], [json, 0.25]] as const) {
    const tap = providerReportedCostTap(async () => new Response(body));
    expect(await (await tap.fetch("http://provider.test")).text()).toBe(body);
    expect(tap.cost()).toBe(cost);
  }
});

test("a reported cost replaces the priced total", () => {
  const message = { stopReason: "stop", usage: { input: 1, cost: { input: 0.1, total: 0.1 } } };
  expect(messageWithProviderReportedCost(message, 0.3)).toEqual({
    stopReason: "stop",
    usage: { input: 1, cost: { input: 0.1, total: 0.3 }, costSource: "provider" },
  });
  expect(messageWithProviderReportedCost(message, undefined)).toBe(message);
});

test("a reported cost on a thrown error keeps its message and marks it failed", () => {
  const error = Object.assign(new Error("upstream 429: rate limited"), { status: 429 });
  expect(messageWithProviderReportedCost(error as unknown as Record<string, unknown>, 0.2)).toEqual({
    stopReason: "error",
    errorMessage: "upstream 429: rate limited",
    content: [],
    status: 429,
    usage: { cost: { total: 0.2 }, costSource: "provider" },
  });
});

test("a reported cost on an error event survives failure handling", async () => {
  const { eventsWithProviderReportedCost } = await import("./provider_reported_cost.js");
  const { providerFailureFromEvent } = await import("../runtime/provider_stream_outcome.js");
  async function* events() {
    yield { type: "error", error: new Error("upstream reset") };
  }
  const tap = { fetch: globalThis.fetch, cost: () => 0.05 };
  for await (const event of eventsWithProviderReportedCost(events(), tap)) {
    const failure = providerFailureFromEvent(event);
    expect(failure.errorMessage).toBe("upstream reset");
    expect(failure.usage).toEqual({ cost: { total: 0.05 }, costSource: "provider" });
  }
});
