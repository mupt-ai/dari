import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { createRequestHandler } from "../http/handler.js";
import { createPrioritySelectorBackend } from "../strategies/priority_selector.js";
import { parseGatewayConfig } from "./config.js";
import { createSelfHostedPlatform } from "./platform.js";
import { PrefixStore } from "./prefix_store.js";
import { SessionPinStore } from "./session_pin_store.js";
import { SubscriptionStore } from "./subscriptions/index.js";
import { tokens } from "./subscriptions/test_support.js";

// A Claude Code plan serves Anthropic models only to Claude Code, so a model
// list for Claude Code (named by the Dari CLI's launcher) includes them, and
// one for any other client does not, matching what each client's requests
// can be served.
test("the model list counts a Claude Code plan only for Claude Code", async () => {
  const db = new Database(":memory:");
  const subscriptions = new SubscriptionStore(db);
  subscriptions.connect(tokens({ expiresAt: new Date(Date.now() + 86_400_000) }), null);
  const platform = createSelfHostedPlatform({
    config: parseGatewayConfig({
      routers: { default: { models: ["anthropic/claude-sonnet-5-5", "openai/gpt-6.1-sol"] } },
    }),
    gatewayKeys: ["k"],
    subscriptions,
    prefixes: new PrefixStore(db),
    sessionPins: new SessionPinStore(db),
    providerApiKey: async (provider) => (provider === "openai" ? "sk-openai" : undefined),
    autoRouting: false,
    env: {},
    fetch: async () => {
      throw new Error("unexpected OAuth request");
    },
  });
  const handler = createRequestHandler({ platform, selectorBackend: createPrioritySelectorBackend() });
  const listed = async (headers: Record<string, string>) => {
    const response = await handler(new Request("http://gateway/v1/models", {
      headers: { authorization: "Bearer k", ...headers },
    }));
    expect(response.status).toBe(200);
    return ((await response.json()) as { models: { slug: string }[] }).models.map((model) => model.slug);
  };

  expect(await listed({ "x-dari-client-harness": "claude_code" })).toEqual([
    "dari/model/anthropic/claude-sonnet-5-5",
    "dari/model/openai/gpt-6.1-sol",
  ]);
  expect(await listed({})).toEqual(["dari/model/openai/gpt-6.1-sol"]);
  // Only known clients are accepted.
  expect(await listed({ "x-dari-client-harness": "anything" })).toEqual(["dari/model/openai/gpt-6.1-sol"]);
});
