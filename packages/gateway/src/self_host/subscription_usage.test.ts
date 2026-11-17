import { afterEach, expect, test } from "bun:test";

import { anthropicReply, startSubscriptionGateway, waitFor } from "./subscription_test_gateway.js";

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

const RESET = () => String(Math.floor(Date.now() / 1000) + 3600);

// A plan's responses report its usage; once it is near its limit the next
// conversation starts on the other plan, before the provider refuses any.
test("a plan reported near its limit stops taking new conversations", async () => {
  const gateway = await startSubscriptionGateway((token) => anthropicReply({
    // Plan a has used 97% of its five-hour window.
    "anthropic-ratelimit-unified-5h-utilization": token === "sk-ant-oat01-a" ? "0.97" : "0.10",
    "anthropic-ratelimit-unified-5h-reset": RESET(),
  }));
  stop = gateway.stop;
  const [a] = gateway.planIds;

  expect((await gateway.claudeCode("11111111-1111-4111-8111-111111111111", "first")).status).toBe(200);
  expect(gateway.served).toEqual(["sk-ant-oat01-a"]);
  await waitFor(() => gateway.plan(a!)?.usage?.utilization === 0.97);

  expect((await gateway.claudeCode("22222222-2222-4222-8222-222222222222", "second")).status).toBe(200);
  expect(gateway.served).toEqual(["sk-ant-oat01-a", "sk-ant-oat01-b"]);
});

// A plan that refuses a request at its usage limit is held, and the same
// request is served by the next plan: the client never sees the refusal.
test("a request refused at a plan's usage limit is served by the next plan", async () => {
  const gateway = await startSubscriptionGateway((token) => token === "sk-ant-oat01-a"
    ? Response.json(
      { type: "error", error: { type: "rate_limit_error", message: "usage limit" } },
      {
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": RESET(),
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
        },
      },
    )
    : anthropicReply());
  stop = gateway.stop;
  const [a] = gateway.planIds;

  const response = await gateway.claudeCode("33333333-3333-4333-8333-333333333333", "hello");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("hi");
  expect(gateway.served).toEqual(["sk-ant-oat01-a", "sk-ant-oat01-b"]);
  expect(gateway.plan(a!)?.unavailableUntil).not.toBeNull();
});

// A plan can cap one model on its own (a weekly Opus or Fable limit). Only that
// model is held on the exhausted plan; another plan serves it immediately
// and on subsequent requests, while other models keep using the first plan.
test("a model limit fails over to another plan without holding the other models", async () => {
  let secondExhausted = false;
  const gateway = await startSubscriptionGateway((token, model) => (token === "sk-ant-oat01-a" || secondExhausted) && model === "claude-fable-5"
    ? Response.json(
      { type: "error", error: { type: "rate_limit_error", message: "usage limit" } },
      {
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": RESET(),
          "anthropic-ratelimit-unified-representative-claim": "seven_day_overage_included",
        },
      },
    )
    : anthropicReply(), ["anthropic/claude-sonnet-5-5", "anthropic/claude-fable-5"]);
  stop = gateway.stop;
  const [a, b] = gateway.planIds;
  const session = "44444444-4444-4444-8444-444444444444";

  const response = await gateway.claudeCode(session, "hello", "dari/model/anthropic/claude-fable-5");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("hi");
  expect(gateway.served).toEqual(["sk-ant-oat01-a", "sk-ant-oat01-b"]);
  expect(gateway.plan(a!)).toMatchObject({
    unavailableUntil: null,
    modelHolds: [expect.objectContaining({ model: "anthropic/claude-fable-5" })],
  });

  const again = await gateway.claudeCode(session, "Fable again", "dari/model/anthropic/claude-fable-5");
  expect(again.status).toBe(200);
  await again.text();
  expect(gateway.served).toEqual(["sk-ant-oat01-a", "sk-ant-oat01-b", "sk-ant-oat01-b"]);

  // The plan still serves its other models.
  expect((await gateway.claudeCode(session, "again")).status).toBe(200);
  expect(gateway.served).toEqual(["sk-ant-oat01-a", "sk-ant-oat01-b", "sk-ant-oat01-b", "sk-ant-oat01-a"]);

  // Exhausting the second plan's Fable quota must hold that credential, not
  // its provider-wide default, and must stop rather than loop through holds.
  secondExhausted = true;
  const exhausted = await gateway.claudeCode(session, "Fable again", "dari/model/anthropic/claude-fable-5");
  expect(exhausted.status).toBe(503);
  await exhausted.text();
  expect(gateway.served.at(-1)).toBe("sk-ant-oat01-b");
  expect(gateway.plan(b!)).toMatchObject({
    unavailableUntil: null,
    modelHolds: [expect.objectContaining({ model: "anthropic/claude-fable-5" })],
  });
  expect((await gateway.claudeCode(session, "Sonnet still works")).status).toBe(200);
  expect(gateway.served.at(-1)).toBe("sk-ant-oat01-a");

});
