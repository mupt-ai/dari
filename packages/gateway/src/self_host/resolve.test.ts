import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { HttpError } from "../http/errors.js";
import type { ResolveRouterRequest } from "../platform/platform.js";
import { parseGatewayConfig } from "./config.js";
import { providersWithoutCredentials, resolveSelfHostedRouter, type SelfHostedResolverDeps } from "./resolve.js";
import { SubscriptionStore } from "./subscriptions/index.js";
import { codexAccessToken, tokens } from "./subscriptions/test_support.js";

const FUTURE = new Date(Date.now() + 24 * 60 * 60_000);

function deps(overrides: {
  apiKeys?: Record<string, string>;
  config?: unknown;
} = {}): SelfHostedResolverDeps & { subscriptions: SubscriptionStore } {
  return {
    config: parseGatewayConfig(overrides.config ?? {
      routers: {
        default: {
          models: [
            "anthropic/claude-sonnet-4-5",
            { id: "openai/gpt-5.5", thinking: ["medium", "high"] },
          ],
        },
      },
    }),
    gatewayKeys: ["gw-1", "gw-2"],
    subscriptions: new SubscriptionStore(new Database(":memory:")),
    prefixHits: () => [],
    providerApiKey: async (provider) => overrides.apiKeys?.[provider],
    env: {},
    fetch: async () => {
      throw new Error("unexpected OAuth request");
    },
  };
}

function request(overrides: Partial<ResolveRouterRequest> = {}): ResolveRouterRequest {
  return { routerId: "default", apiKey: "gw-2", ...overrides };
}

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("expected resolution to fail");
}

describe("resolveSelfHostedRouter", () => {
  test("serves models with provider API keys and catalog prices", async () => {
    const resolved = await resolveSelfHostedRouter(
      deps({ apiKeys: { anthropic: "sk-ant", openai: "sk-openai" } }),
      request(),
    );
    expect(resolved).toMatchObject({
      router_id: "default",
      api_key_id: "gateway_key_2",
      enabled_models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5.5"],
      provider_keys: { anthropic: "sk-ant", openai: "sk-openai" },
      provider_key_sources: { anthropic: "user", openai: "user" },
      model_thinking_levels: { "openai/gpt-5.5": ["medium", "high"] },
      primary_retries: 1,
    });
    expect(resolved.model_prices?.["anthropic/claude-sonnet-4-5"]?.input).toBeGreaterThan(0);
  });

  test("refuses unknown keys and routers", async () => {
    expect((await rejection(resolveSelfHostedRouter(deps(), request({ apiKey: "nope" })))).status).toBe(401);
    expect((await rejection(resolveSelfHostedRouter(deps(), request({ routerId: "other" })))).status).toBe(404);
  });

  test("leaves out models no credential can serve", async () => {
    const resolved = await resolveSelfHostedRouter(deps({ apiKeys: { openai: "sk-openai" } }), request());
    expect(resolved.enabled_models).toEqual(["openai/gpt-5.5"]);
    const missing = await rejection(resolveSelfHostedRouter(deps(), request()));
    expect(missing).toMatchObject({ status: 424, code: "provider_credentials_missing" });
  });

  test("a Claude Code plan serves Anthropic models only for Claude Code", async () => {
    const resolver = deps({ apiKeys: { openai: "sk-openai" } });
    const plan = resolver.subscriptions.connect(tokens({ expiresAt: FUTURE }), null)!;

    const claudeCode = await resolveSelfHostedRouter(resolver, request({ clientHarness: "claude_code" }));
    expect(claudeCode.provider_keys.anthropic).toBe("sk-ant-oat01-access");
    expect(claudeCode.provider_key_sources?.anthropic).toBe("subscription");
    expect(claudeCode.subscription_credential_ids?.anthropic).toBe(plan.id);

    const otherClient = await resolveSelfHostedRouter(resolver, request());
    expect(otherClient.enabled_models).toEqual(["openai/gpt-5.5"]);
  });

  test("a Muse Code plan serves Meta models only for Muse Code, as Meta's own key", async () => {
    const resolver = deps({
      apiKeys: { meta: "meta-api-key" },
      config: { routers: { default: { models: ["meta/muse-spark-1.3"] } } },
    });
    const plan = resolver.subscriptions.connect(
      tokens({ provider: "meta_muse", accessToken: "meta-minted-key", refreshToken: "meta-sign-in", expiresAt: FUTURE }),
      null,
    )!;

    const museCode = await resolveSelfHostedRouter(resolver, request({ clientHarness: "muse_code" }));
    expect(museCode.provider_keys).toEqual({ meta: "meta-minted-key" });
    expect(museCode.provider_key_sources).toEqual({ meta: "subscription" });
    expect(museCode.subscription_credential_ids).toEqual({ meta: plan.id });
    expect(museCode.model_configs?.["meta/muse-spark-1.3"]).toBeUndefined();

    const otherClient = await resolveSelfHostedRouter(resolver, request());
    expect(otherClient.provider_keys).toEqual({ meta: "meta-api-key" });
    expect(otherClient.provider_key_sources).toEqual({ meta: "user" });

    resolver.subscriptions.markUnavailable(plan.id, FUTURE, "usage_limit");
    const held = await resolveSelfHostedRouter(resolver, request({ clientHarness: "muse_code" }));
    expect(held.provider_keys).toEqual({ meta: "meta-api-key" });
  });

  test("an exhausted Muse Code plan with no API key names the plan", async () => {
    const resolver = deps({ config: { routers: { default: { models: ["meta/muse-spark-1.3"] } } } });
    const plan = resolver.subscriptions.connect(tokens({ provider: "meta_muse", expiresAt: FUTURE }), null)!;
    resolver.subscriptions.markUnavailable(plan.id, FUTURE, "usage_limit");
    const exhausted = await rejection(resolveSelfHostedRouter(resolver, request({ clientHarness: "muse_code" })));
    expect(exhausted).toMatchObject({ status: 424, code: "personal_subscription_unavailable" });
    expect(exhausted.message).toContain("Every connected Muse Code subscription is at its usage limit");
  });

  test("a ChatGPT plan serves OpenAI models through the Codex backend", async () => {
    const resolver = deps({ apiKeys: { anthropic: "sk-ant", openai: "sk-openai" } });
    const accessToken = codexAccessToken("acct_1");
    const plan = resolver.subscriptions.connect(
      tokens({ provider: "openai_codex", accessToken, accountId: "acct_1", expiresAt: FUTURE }),
      null,
    )!;
    const resolved = await resolveSelfHostedRouter(resolver, request());
    expect(resolved.provider_keys).toMatchObject({ openai: accessToken, "openai-codex": accessToken });
    expect(resolved.provider_key_sources).toMatchObject({ openai: "subscription", "openai-codex": "subscription" });
    expect(resolved.subscription_credential_ids).toMatchObject({ openai: plan.id, "openai-codex": plan.id });
    expect(resolved.model_configs?.["openai/gpt-5.5"]).toMatchObject({
      provider: "openai-codex",
      native_model_id: "gpt-5.5",
      api: "openai-codex-responses",
      base_url: "https://chatgpt.com/backend-api",
      fast_mode: false,
    });
  });

  test("held plans give way to the API key, or fail when there is none", async () => {
    const withKey = deps({ apiKeys: { anthropic: "sk-ant" } });
    const plan = withKey.subscriptions.connect(tokens({ expiresAt: FUTURE }), null)!;
    withKey.subscriptions.markUnavailable(plan.id, FUTURE, "usage_limit");
    const resolved = await resolveSelfHostedRouter(withKey, request({ clientHarness: "claude_code" }));
    expect(resolved.provider_keys.anthropic).toBe("sk-ant");
    expect(resolved.provider_key_sources?.anthropic).toBe("user");

    const withoutKey = deps({
      config: { routers: { default: { models: ["anthropic/claude-sonnet-4-5"] } } },
    });
    const held = withoutKey.subscriptions.connect(tokens({ expiresAt: FUTURE }), null)!;
    withoutKey.subscriptions.markUnavailable(held.id, FUTURE, "usage_limit");
    const exhausted = await rejection(
      resolveSelfHostedRouter(withoutKey, request({ clientHarness: "claude_code" })),
    );
    expect(exhausted).toMatchObject({ status: 424, code: "personal_subscription_unavailable" });
  });

  test("routers can opt out of subscriptions", async () => {
    const resolver = deps({
      apiKeys: { anthropic: "sk-ant" },
      config: {
        routers: { default: { models: ["anthropic/claude-sonnet-4-5"], subscriptions: false } },
      },
    });
    resolver.subscriptions.connect(tokens({ expiresAt: FUTURE }), null);
    const resolved = await resolveSelfHostedRouter(resolver, request({ clientHarness: "claude_code" }));
    expect(resolved.provider_key_sources?.anthropic).toBe("user");
  });

  test("configured endpoints get an execution config and their own key", async () => {
    const resolver = deps({
      config: {
        routers: { default: { models: ["local/qwen3"] } },
        providers: { local: { baseUrl: "http://127.0.0.1:8000/v1/", apiKeyEnv: "LOCAL_KEY" } },
      },
    });
    resolver.env = { LOCAL_KEY: "local-secret" };
    const resolved = await resolveSelfHostedRouter(resolver, request());
    expect(resolved.provider_keys).toEqual({ local: "local-secret" });
    expect(resolved.model_configs?.["local/qwen3"]).toMatchObject({
      provider: "local",
      native_model_id: "qwen3",
      api: "openai-completions",
      base_url: "http://127.0.0.1:8000/v1",
    });
  });
});

describe("providersWithoutCredentials", () => {
  test("lists providers that neither an API key nor a connected subscription can serve", async () => {
    const resolverDeps = deps({ apiKeys: { openai: "sk-openai" } });
    expect(await providersWithoutCredentials(resolverDeps, resolverDeps.config.routers.default!)).toEqual([
      "anthropic",
    ]);
  });
});

describe("parseGatewayConfig", () => {
  test("rejects malformed routers", () => {
    expect(() => parseGatewayConfig({})).toThrow("routers");
    expect(() => parseGatewayConfig({ routers: { default: { models: [] } } })).toThrow("non-empty");
    expect(() => parseGatewayConfig({ routers: { default: { models: ["gpt-5"] } } })).toThrow("provider/model");
    expect(() => parseGatewayConfig({ routers: { default: { models: ["a/b", "a/b"] } } })).toThrow("twice");
    expect(() =>
      parseGatewayConfig({ routers: { default: { models: [{ id: "a/b", thinking: ["huge"] }] } } }),
    ).toThrow("thinking");
    expect(() =>
      parseGatewayConfig({ routers: { default: { models: ["a/b"] } }, providers: { a: {} } }),
    ).toThrow("baseUrl");
  });

  test("applies router defaults", () => {
    expect(parseGatewayConfig({ routers: { default: { models: ["a/b"] } } })).toEqual({
      routers: {
        default: {
          models: [{ id: "a/b" }],
          retries: 1,
          subscriptions: true,
          sessionPinning: false,
          zdr: false,
        },
      },
      providers: {},
    });
  });
});
