import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { SqliteLinkStore } from "../link/sqlite_store.js";
import { ActivityStore } from "./activity_store.js";
import { parseGatewayConfig } from "./config.js";
import { createSelfHostedPlatform } from "./platform.js";
import { PrefixStore } from "./prefix_store.js";
import { RouterModelStore } from "./router_models.js";
import { RouterSpecStore } from "./router_specs.js";
import { SessionPinStore } from "./session_pin_store.js";
import { SubscriptionStore } from "./subscriptions/index.js";
import { tokens } from "./subscriptions/test_support.js";
import type { Source } from "../models/sources.js";

// With every Claude Code plan at its limit, a banked reset is spent on the
// plan out longest when the model's sources and the router's threshold say so
// (models/sources.ts shouldSpendReset), as on hosted Dari.
function gatewayWithTwoHeldPlans(policy: { sources: Source[]; resetMinHours: number }, grantEndsAt?: Date) {
  const db = new Database(":memory:");
  const subscriptions = new SubscriptionStore(db);
  const calls: string[] = [];
  const platform = createSelfHostedPlatform({
    config: parseGatewayConfig({ routers: { default: { models: ["anthropic/claude-sonnet-5-5"] } } }),
    activity: new ActivityStore(db),
    routerModels: new RouterModelStore(db),
    routerSpecs: new RouterSpecStore(db),
    gatewayKeys: ["k"],
    subscriptions,
    links: new SqliteLinkStore(db),
    prefixes: new PrefixStore(db),
    sessionPins: new SessionPinStore(db),
    providerApiKey: async () => undefined,
    autoRouting: false,
    env: {},
    fetch: async (url, init) => {
      calls.push(`${init.method ?? "GET"} ${url}`);
      if (url.includes("/api/oauth/usage")) {
        return Response.json({ cedar_ember: { eligible: true, next_grant_id: "g", grants: [{ id: "g", usable_now: true, resets_left: 1, ...(grantEndsAt ? { ends_at: grantEndsAt.toISOString() } : {}) }] } });
      }
      if (url.endsWith("/api/oauth/profile")) return Response.json({ organization: { uuid: "org_1" } });
      if (url.endsWith("/reset_rate_limits")) return Response.json({ result: "reset" });
      throw new Error(`unexpected request to ${url}`);
    },
  });
  const expiresAt = new Date(Date.now() + 86_400_000);
  const a = subscriptions.connect(tokens({ accountEmail: "a@example.com", expiresAt }), null)!;
  const b = subscriptions.connect(tokens({ accountEmail: "b@example.com", expiresAt }), null)!;
  subscriptions.markUnavailable(b.id, new Date(Date.now() + 3_600_000), "usage_limit");
  const hold = () => platform.markSubscriptionUnavailable({
    userId: "owner",
    credentialId: a.id,
    limit: { oauthProvider: "anthropic_claude_code", resetsAt: new Date(Date.now() + 1_800_000), reason: "usage_limit" },
    ...policy,
  });
  return { subscriptions, calls, hold, a, b };
}

const SPEND = ["POST https://api.anthropic.com/api/organizations/org_1/reset_rate_limits"];
const posts = (calls: string[]) => calls.filter((call) => call.startsWith("POST"));

test("a plan out longer than the threshold spends a banked reset", async () => {
  const g = gatewayWithTwoHeldPlans({ sources: ["plan", "reset"], resetMinHours: 0.5 });
  expect(await g.hold()).toBe(true);
  expect(g.subscriptions.get(g.b.id)!.unavailableUntil).toBeNull();
  expect(g.subscriptions.get(g.a.id)!.unavailableUntil).not.toBeNull();
  expect(posts(g.calls)).toEqual(SPEND);
});

test("a short wait keeps the reset", async () => {
  const g = gatewayWithTwoHeldPlans({ sources: ["plan", "reset"], resetMinHours: 24 });
  expect(await g.hold()).toBe(false);
  expect(posts(g.calls)).toEqual([]);
});

test("a short wait still spends a reset that would expire before the plan returns", async () => {
  const g = gatewayWithTwoHeldPlans({ sources: ["plan", "reset"], resetMinHours: 24 }, new Date(Date.now() + 600_000));
  expect(await g.hold()).toBe(true);
  expect(posts(g.calls)).toEqual(SPEND);
});

test("a model without reset in its sources never spends one", async () => {
  const g = gatewayWithTwoHeldPlans({ sources: ["plan", "key"], resetMinHours: 0 });
  expect(await g.hold()).toBe(false);
  expect(posts(g.calls)).toEqual([]);
});
