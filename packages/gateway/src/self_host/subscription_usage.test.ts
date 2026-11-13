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
// model is held: the client's retry routes to the plan's other models, and the
// plan is never switched.
test("a request refused at one model's own limit holds only that model", async () => {
  const gateway = await startSubscriptionGateway((_token, model) => model === "claude-fable-5"
    ? Response.json(
      { type: "error", error: { type: "rate_limit_error", message: "usage limit" } },
      {
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": RESET(),
          "anthropic-ratelimit-unified-representative-claim": "seven_day_fable",
        },
      },
    )
    : anthropicReply(), ["anthropic/claude-sonnet-5-5", "anthropic/claude-fable-5"]);
  stop = gateway.stop;
  const [a] = gateway.planIds;
  const session = "44444444-4444-4444-8444-444444444444";

  const refused = await gateway.claudeCode(session, "hello", "dari/model/anthropic/claude-fable-5");
  expect(refused.status).toBe(503);
  expect(refused.headers.get("retry-after")).toBe("1");
  expect(await refused.text()).toContain("usage limit for anthropic/claude-fable-5 is reached");
  expect(gateway.served).toEqual(["sk-ant-oat01-a"]);
  expect(gateway.plan(a!)).toMatchObject({
    unavailableUntil: null,
    modelHolds: [expect.objectContaining({ model: "anthropic/claude-fable-5" })],
  });

  // The plan still serves its other models.
  expect((await gateway.claudeCode(session, "again")).status).toBe(200);
  expect(gateway.served).toEqual(["sk-ant-oat01-a", "sk-ant-oat01-a"]);
});
