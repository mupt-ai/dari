import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { HttpError } from "../http/errors.js";
import { pkceChallenge } from "../link/endpoints.js";
import type { InteractionRequest } from "../interaction/types.js";
import { linkGrantAccess } from "../link/grant_access.js";
import type { ResolveRouterRequest } from "../platform/platform.js";
import { parseGatewayConfig, parseRouterSpec } from "./config.js";
import { providersWithoutCredentials, resolveSelfHostedRouter, type SelfHostedResolverDeps } from "./resolve.js";
import { linkGrants } from "../link/grants.js";
import { SqliteLinkStore } from "../link/sqlite_store.js";
import { RouterModelStore } from "./router_models.js";
import { RouterSpecStore } from "./router_specs.js";
import { SubscriptionStore } from "./subscriptions/index.js";
import { codexAccessToken, tokens } from "./subscriptions/test_support.js";
import { addTestApp, approveTestGrant } from "../link/test_support.js";

const FUTURE = new Date(Date.now() + 24 * 60 * 60_000);

function deps(overrides: {
  apiKeys?: Record<string, string>;
  config?: unknown;
  autoRouting?: boolean;
} = {}): SelfHostedResolverDeps & { subscriptions: SubscriptionStore } {
  const db = new Database(":memory:");
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
    routerModels: new RouterModelStore(db),
    routerSpecs: new RouterSpecStore(db),
    gatewayKeys: ["gw-1", "gw-2"],
    subscriptions: new SubscriptionStore(db),
    links: new SqliteLinkStore(db),
    prefixHits: () => [],
    providerApiKey: async (provider) => overrides.apiKeys?.[provider],
    autoRouting: overrides.autoRouting ?? false,
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
    expect(claudeCode.provider_credentials?.["anthropic/claude-sonnet-4-5"]).toEqual({
      apiKey: "sk-ant-oat01-access",
      subscription: "anthropic_claude_code",
      credentialId: plan.id,
    });
    expect(claudeCode.provider_keys.anthropic).toBeUndefined();

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
    expect(museCode.provider_credentials).toEqual({
      "meta/muse-spark-1.3": { apiKey: "meta-minted-key", subscription: "meta_muse", credentialId: plan.id },
    });
    expect(museCode.model_configs?.["meta/muse-spark-1.3"]).toBeUndefined();
    // Meta's API key serves the request when the plan cannot.
    expect(museCode.provider_keys).toEqual({ meta: "meta-api-key" });
    expect(museCode.model_fallbacks?.["meta/muse-spark-1.3"]).toEqual([
      { config: expect.objectContaining({ provider: "meta", native_model_id: "muse-spark-1.3" }) },
    ]);

    const otherClient = await resolveSelfHostedRouter(resolver, request());
    expect(otherClient.provider_keys).toEqual({ meta: "meta-api-key" });
    expect(otherClient.provider_key_sources).toEqual({ meta: "user" });

    resolver.subscriptions.markUnavailable(plan.id, FUTURE, "usage_limit");
    const held = await resolveSelfHostedRouter(resolver, request({ clientHarness: "muse_code" }));
    expect(held.provider_keys).toEqual({ meta: "meta-api-key" });
    expect(held.provider_credentials).toEqual({});
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
    expect(resolved.provider_credentials?.["openai/gpt-5.5"]).toEqual({
      apiKey: accessToken,
      subscription: "openai_codex",
      credentialId: plan.id,
    });
    expect(resolved.provider_keys).toEqual({ anthropic: "sk-ant", openai: "sk-openai" });
    expect(resolved.model_fallbacks?.["openai/gpt-5.5"]).toEqual([
      { config: expect.objectContaining({ provider: "openai", native_model_id: "gpt-5.5" }) },
    ]);
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

  test("a model held at its own limit leaves routing while the plan serves the rest", async () => {
    const resolver = deps({
      config: { routers: { default: { models: ["anthropic/claude-sonnet-5-5", "anthropic/claude-fable-5"] } } },
    });
    const plan = resolver.subscriptions.connect(tokens({ expiresAt: FUTURE }), null)!;
    resolver.subscriptions.holdModel(plan.id, "anthropic/claude-fable-5", FUTURE, "seven day fable");
    const resolved = await resolveSelfHostedRouter(resolver, request({ clientHarness: "claude_code" }));
    expect(resolved.enabled_models).toEqual(["anthropic/claude-sonnet-5-5"]);
    expect(Object.keys(resolved.provider_credentials ?? {})).toEqual(["anthropic/claude-sonnet-5-5"]);

    resolver.subscriptions.holdModel(plan.id, "anthropic/claude-sonnet-5-5", FUTURE, "seven day sonnet");
    const exhausted = await rejection(resolveSelfHostedRouter(resolver, request({ clientHarness: "claude_code" })));
    expect(exhausted).toMatchObject({ status: 424, code: "personal_subscription_unavailable" });
    expect(exhausted.message).toContain("Every connected Claude Code subscription is at its usage limit for the models");
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

  test("a model bound to OpenCode Go runs as its OpenCode Go model on the Go plan", async () => {
    const resolver = deps({
      config: {
        routers: {
          default: { models: [{ id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", provider: "opencode-go", thinking: ["high"] }] },
        },
      },
    });
    const plan = resolver.subscriptions.connect(
      tokens({ provider: "opencode_go", accessToken: "go-plan-key", expiresAt: FUTURE }),
      null,
    )!;
    const resolved = await resolveSelfHostedRouter(resolver, request());
    expect(resolved).toMatchObject({
      enabled_models: ["deepseek-ai/DeepSeek-V4.1-Flash-1017"],
      provider_credentials: {
        "deepseek-ai/DeepSeek-V4.1-Flash-1017": { apiKey: "go-plan-key", subscription: "opencode_go", credentialId: plan.id },
      },
      model_thinking_levels: { "deepseek-ai/DeepSeek-V4.1-Flash-1017": ["high"] },
    });
    expect(resolved.model_configs?.["deepseek-ai/DeepSeek-V4.1-Flash-1017"]).toMatchObject({
      provider: "opencode-go",
      native_model_id: "deepseek-v4.1-flash",
      api: "openai-completions",
      base_url: "https://opencode.ai/inference/go/openai/v1",
    });
    // Priced as the OpenCode Go model, for estimates; the plan bills no tokens.
    expect(resolved.model_prices?.["deepseek-ai/DeepSeek-V4.1-Flash-1017"]).toBeDefined();
  });

  test("a model bound to Vercel Token Pass runs as Vercel's featured model on the Token Pass key", async () => {
    const resolver = deps({
      config: { routers: { default: { models: [{ id: "zai-org/GLM-5.3", provider: "vercel-token-pass" }] } } },
    });
    resolver.subscriptions.connect(
      tokens({ provider: "vercel_token_pass", accessToken: "vck_pass", refreshToken: "vck_pass", expiresAt: FUTURE }),
      null,
    );
    const resolved = await resolveSelfHostedRouter(resolver, request());
    expect(resolved).toMatchObject({
      enabled_models: ["zai-org/GLM-5.3"],
      provider_credentials: { "zai-org/GLM-5.3": { apiKey: "vck_pass", subscription: "vercel_token_pass" } },
    });
    expect(resolved.model_configs?.["zai-org/GLM-5.3"]).toMatchObject({
      provider: "vercel-token-pass",
      native_model_id: "zai/glm-5.3",
      api: "anthropic-messages",
      base_url: "https://ai-gateway.vercel.sh",
    });
    // Priced as Vercel AI Gateway lists the model, for estimates.
    expect(resolved.model_prices?.["zai-org/GLM-5.3"]).toBeDefined();
  });

  test("xAI models are served on a Grok plan, and on the xAI key without one", async () => {
    const resolver = deps({
      apiKeys: { xai: "xai-key" },
      config: { routers: { default: { models: ["xai/grok-4.7"] } } },
    });
    expect((await resolveSelfHostedRouter(resolver, request())).provider_key_sources).toEqual({ xai: "user" });
    resolver.subscriptions.connect(tokens({ provider: "xai_grok", accessToken: "grok-access", expiresAt: FUTURE }), null);
    expect(await resolveSelfHostedRouter(resolver, request())).toMatchObject({
      provider_credentials: { "xai/grok-4.7": { apiKey: "grok-access", subscription: "xai_grok" } },
      provider_keys: { xai: "xai-key" },
      model_fallbacks: { "xai/grok-4.7": [{ config: expect.objectContaining({ provider: "xai" }) }] },
    });
  });

  // Plans serve a model in a fixed order, not the order they were connected.
  test("a model is served by its plans in order", async () => {
    const resolver = deps({
      config: { routers: { default: { models: ["moonshotai/Kimi-K3"] } } },
    });
    resolver.subscriptions.connect(
      tokens({ provider: "vercel_token_pass", accessToken: "vck_pass", refreshToken: "vck_pass", expiresAt: FUTURE }),
      null,
    );
    const goPlan = resolver.subscriptions.connect(
      tokens({ provider: "opencode_go", accessToken: "go-key", expiresAt: FUTURE }),
      null,
    )!;

    const resolved = await resolveSelfHostedRouter(resolver, request());
    expect(resolved.provider_credentials?.["moonshotai/Kimi-K3"]).toMatchObject({
      subscription: "opencode_go",
      credentialId: goPlan.id,
    });
    expect(resolved.model_configs?.["moonshotai/Kimi-K3"]).toMatchObject({ provider: "opencode-go" });
    expect(resolved.model_fallbacks?.["moonshotai/Kimi-K3"]).toEqual([
      { config: expect.objectContaining({ provider: "vercel-token-pass" }), subscription: "vercel_token_pass" },
    ]);
  });

  test("a saved router spec is served in place of the config file's router", async () => {
    const resolver = deps({ apiKeys: { openai: "sk-openai", anthropic: "sk-ant" } });
    const db = new Database(":memory:");
    resolver.routerSpecs = new RouterSpecStore(db);
    resolver.routerSpecs.save("default", {
      ...parseRouterSpec("default", { name: "Spec", models: ["openai/gpt-6.1-sol"], payment: { allow: ["key"] } }),
      text: "",
    });
    resolver.routerSpecs.save("specced", {
      ...parseRouterSpec("specced", { name: "Other", models: ["anthropic/claude-opus-5-5"] }),
      text: "",
    });
    expect((await resolveSelfHostedRouter(resolver, request())).enabled_models).toEqual(["openai/gpt-6.1-sol"]);
    expect((await resolveSelfHostedRouter(resolver, request({ routerId: "specced" }))).enabled_models)
      .toEqual(["anthropic/claude-opus-5-5"]);
    resolver.routerSpecs.remove("default");
    expect((await resolveSelfHostedRouter(resolver, request())).enabled_models)
      .toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-5.5"]);
  });
});

describe("providersWithoutCredentials", () => {
  test("lists providers that neither an API key nor a connected subscription can serve", async () => {
    const resolverDeps = deps({ apiKeys: { openai: "sk-openai" } });
    expect(await providersWithoutCredentials(resolverDeps, resolverDeps.config.routers.default!)).toEqual([
      "anthropic",
    ]);
  });

  test("counts a plan that serves the provider's model though another provider", async () => {
    const resolverDeps = deps({ config: { routers: { default: { models: ["moonshotai/Kimi-K3"] } } } });
    resolverDeps.subscriptions.connect(tokens({ provider: "opencode_go", accessToken: "go-key", expiresAt: FUTURE }), null);
    expect(await providersWithoutCredentials(resolverDeps, resolverDeps.config.routers.default!)).toEqual([]);
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
    expect(() =>
      parseGatewayConfig({ routers: { default: { models: ["a/b"], agentModels: { cursor: ["a/b"] } } } }),
    ).toThrow("unknown coding agent");
    expect(() =>
      parseGatewayConfig({ routers: { default: { models: ["a/b"], agentModels: { codex: [] } } } }),
    ).toThrow("agentModels.codex");
    expect(() =>
      parseGatewayConfig({ routers: { default: { models: ["a/b"], roleModels: { reviewer: "a/b" } } } }),
    ).toThrow("unknown role");
    expect(() =>
      parseGatewayConfig({ routers: { default: { models: ["a/b"], roleModels: { main: "a/c" } } } }),
    ).toThrow("roleModels.main");
    expect(() =>
      parseGatewayConfig({ routers: { default: { models: ["a/b"], rolePrompts: { main: " " } } } }),
    ).toThrow("rolePrompts.main");
  });

  test("serves a router's role models", async () => {
    const resolved = await resolveSelfHostedRouter(
      deps({
        apiKeys: { anthropic: "sk-ant", openai: "sk-openai" },
        config: {
          routers: {
            default: {
              models: ["anthropic/claude-sonnet-4-5"],
              agentModels: { codex: ["openai/gpt-5.5"] },
              roleModels: { main: "anthropic/claude-sonnet-4-5", subagent: "openai/gpt-5.5" },
              rolePrompts: { main: " Delegate exploration to subagents. " },
            },
          },
        },
      }),
      request(),
    );
    expect(resolved.role_models).toEqual({ main: "anthropic/claude-sonnet-4-5", subagent: "openai/gpt-5.5" });
    expect(resolved.role_prompts).toEqual({ main: "Delegate exploration to subagents." });
  });

  test("applies router defaults", () => {
    expect(parseGatewayConfig({ routers: { default: { models: ["a/b"] } } })).toEqual({
      routers: {
        default: {
          models: [{ id: "a/b" }],
          agentModels: {},
          retries: 1,
          subscriptions: true,
          sessionPinning: false,
          nativeCompaction: false,
          zdr: false,
          roleModels: {},
          rolePrompts: {},
        },
      },
      providers: {},
    });
  });
});

// A coding agent with its own list on the router is served that list, at its
// own thinking levels and on its own providers; every other client is served
// the router's models.
test("serves a coding agent its own model list", async () => {
  const resolver = deps({
    apiKeys: { anthropic: "sk-ant", openai: "sk-openai", deepseek: "sk-deepseek" },
    config: {
      routers: {
        default: {
          models: ["anthropic/claude-sonnet-4-5", { id: "openai/gpt-5.5", thinking: ["medium"] }],
          agentModels: {
            codex: [{ id: "openai/gpt-5.5", thinking: ["high"] }, "deepseek/deepseek-chat"],
          },
        },
      },
    },
  });

  const codex = await resolveSelfHostedRouter(resolver, request({ clientHarness: "codex" }));
  expect(codex.enabled_models).toEqual(["openai/gpt-5.5", "deepseek/deepseek-chat"]);
  expect(codex.model_thinking_levels).toEqual({ "openai/gpt-5.5": ["high"] });
  expect(Object.keys(codex.provider_keys).sort()).toEqual(["deepseek", "openai"]);

  for (const clientHarness of ["pi", undefined] as const) {
    const other = await resolveSelfHostedRouter(resolver, request({ clientHarness }));
    expect(other.enabled_models).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-5.5"]);
    expect(other.model_thinking_levels).toEqual({ "openai/gpt-5.5": ["medium"] });
  }
});

// Without Dari Auto Routing, dari/routing only serves the first model, so
// model lists leave it out; with it, they offer it.
test("routing is listed only with Dari Auto Routing", async () => {
  const apiKeys = { anthropic: "sk-ant", openai: "sk-openai" };
  expect((await resolveSelfHostedRouter(deps({ apiKeys }), request())).routing_listed).toBe(false);
  expect((await resolveSelfHostedRouter(deps({ apiKeys, autoRouting: true }), request())).routing_listed).toBe(true);
});

// Claude Code requests resolve twice and only the second resolve's
// credentials serve. The first must not mark a plan used or refresh it: a
// failed refresh there would fail a request whose own plan is fine.
test("a grant with a gateway API key is served that gateway's models by name", async () => {
  const resolver = deps();
  const app = addTestApp(resolver.links, "App", ["http://127.0.0.1:1/callback"], false);
  const key = resolver.links.addKey("lu_1", "openrouter", "sk-or-test");
  const challenge = pkceChallenge("v".repeat(43));
  const code = approveTestGrant(resolver.links, {
    subject: "lu_1",
    clientId: app.clientId,
    redirectUri: "http://127.0.0.1:1/callback",
    codeChallenge: challenge,
    credentialIds: [key.id],
  });
  const tokens = await linkGrants(resolver.links).exchangeCode({ clientId: app.clientId, code, redirectUri: "http://127.0.0.1:1/callback", codeChallenge: challenge });
  const resolved = await resolveSelfHostedRouter(resolver, request({ apiKey: tokens.accessToken }));
  expect(resolved.provider_keys).toEqual({ openrouter: "sk-or-test" });
  expect(resolved.link_key_gateways).toEqual({ openrouter: null });
  expect(resolved.link_models).toEqual([]);

  const interaction = { model: "dari/model/openrouter/anthropic/claude-sonnet-4.5" } as InteractionRequest;
  const served = linkGrantAccess(resolved, interaction);
  expect(served.credentials.enabled_models).toEqual(["openrouter/anthropic/claude-sonnet-4.5"]);
  // Another gateway's model, and a provider's it holds no key for, are refused.
  for (const model of ["dari/model/vercel-ai-gateway/openai/gpt-5", "dari/model/anthropic/claude-sonnet-4-5"]) {
    expect(() => linkGrantAccess(resolved, { model } as InteractionRequest)).toThrow();
  }
});

test("a provisional resolve neither marks a plan used nor refreshes it", async () => {
  const resolver = deps({ apiKeys: { openai: "sk-openai" } });
  // Expires within the refresh margin, and the deps' fetch fails any refresh.
  const plan = resolver.subscriptions.connect(tokens({ expiresAt: new Date(Date.now() + 60_000) }), null)!;

  const provisional = await resolveSelfHostedRouter(resolver, request({ clientHarness: "claude_code", provisional: true }));
  expect(provisional.provider_credentials?.["anthropic/claude-sonnet-4-5"]?.apiKey).toBe("sk-ant-oat01-access");
  expect(resolver.subscriptions.get(plan.id)?.lastUsedAt).toBeNull();

  // The serving resolve does both, and here the refresh fails.
  await expect(resolveSelfHostedRouter(resolver, request({ clientHarness: "claude_code" }))).rejects.toThrow();
  expect(resolver.subscriptions.get(plan.id)?.lastUsedAt).not.toBeNull();
});

// OpenCode Go has no models of its own: each one it runs is another maker's.
// A grant of the plan serves those on the plan, then on a granted key of a
// provider that runs them.
test("a grant with an OpenCode Go plan is served the models the plan runs", async () => {
  const resolver = deps();
  const app = addTestApp(resolver.links, "App", ["http://127.0.0.1:1/callback"], false);
  const plan = resolver.subscriptions.connect(
    tokens({ provider: "opencode_go", accessToken: "go-plan-key", expiresAt: FUTURE }),
    null,
    new Date(),
    "lu_1",
  )!;
  const fireworks = resolver.links.addKey("lu_1", "fireworks", "sk-fw-test");
  const challenge = pkceChallenge("v".repeat(43));
  const resolve = async (credentialIds: string[]) => {
    const code = approveTestGrant(resolver.links, {
      subject: "lu_1",
      clientId: app.clientId,
      redirectUri: "http://127.0.0.1:1/callback",
      codeChallenge: challenge,
      credentialIds,
    });
    const granted = await linkGrants(resolver.links).exchangeCode({ clientId: app.clientId, code, redirectUri: "http://127.0.0.1:1/callback", codeChallenge: challenge });
    return await resolveSelfHostedRouter(resolver, request({ apiKey: granted.accessToken }));
  };

  const alone = await resolve([plan.id]);
  expect(new Set(alone.link_models)).toEqual(new Set([
    "moonshotai/Kimi-K3",
    "moonshotai/Kimi-K3.1-Pro",
    "zai-org/GLM-5.3",
    "zai-org/GLM-5.3-Flash",
    "zai-org/GLM-5.2",
    "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  ]));
  // Nothing of another provider's: the router's own Claude and GPT models have no plan here.
  expect(new Set(Object.values(alone.model_configs ?? {}).map((config) => config.provider))).toEqual(new Set(["opencode-go"]));
  expect(alone.provider_credentials?.["moonshotai/Kimi-K3"]).toEqual({ apiKey: "go-plan-key", subscription: "opencode_go", credentialId: plan.id });
  expect(alone.provider_keys).toEqual({});
  expect(alone.model_fallbacks).toEqual({});

  // With a Fireworks key granted too, the plan serves first and the key takes over in the request.
  const keyed = await resolve([plan.id, fireworks.id]);
  expect(keyed.model_configs?.["moonshotai/Kimi-K3"]?.provider).toBe("opencode-go");
  expect(keyed.provider_credentials?.["moonshotai/Kimi-K3"]?.subscription).toBe("opencode_go");
  expect(keyed.model_fallbacks?.["moonshotai/Kimi-K3"]).toMatchObject([{ config: { provider: "fireworks" } }]);
  expect(keyed.model_fallbacks?.["moonshotai/Kimi-K3"]?.[0]?.subscription).toBeUndefined();
  expect(keyed.provider_keys).toEqual({ fireworks: "sk-fw-test" });
});
