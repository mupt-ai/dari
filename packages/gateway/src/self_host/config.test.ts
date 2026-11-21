import { expect, test } from "bun:test";

import {
  parseGatewayConfig,
  parseRouterSpec,
  parseRouterSpecText,
  routerSpecFor,
  routerSpecYaml,
} from "./config.js";

test("link.allowHttpRedirectHosts lists dev hosts, and nothing else is allowed by default", () => {
  const routers = { default: { models: ["openai/gpt-5.5"] } };
  expect(parseGatewayConfig({ routers }).link).toBeUndefined();
  expect(parseGatewayConfig({ routers, link: { allowHttpRedirectHosts: ["*.Example.ts.net", "dev.local"] } }).link)
    .toEqual({ allowHttpRedirectHosts: ["*.example.ts.net", "dev.local"] });
  expect(() => parseGatewayConfig({ routers, link: { allowHttpRedirectHosts: ["http://dev.local"] } })).toThrow("allowHttpRedirectHosts");
  expect(() => parseGatewayConfig({ routers, link: { allowHttpRedirectHosts: ["*"] } })).toThrow("allowHttpRedirectHosts");
});

const EXAMPLE_SPEC = `
name: Opus 5.5 + DeepSeek Subagents
models:
  - anthropic/claude-opus-5-5
  - id: deepseek-ai/DeepSeek-V4.1-Flash-1017
    thinking: [off, high]
    provider: opencode-go
    fast: true
roles:
  main: { model: anthropic/claude-opus-5-5 }
  subagent: { model: deepseek-ai/DeepSeek-V4.1-Flash-1017, prompt: Be brief. }
routing: { session_pinning: true, retries: 2, rules: [] }
payment: { allow: [subscription, key, credits] }
native_compaction: true
agents: { codex: [openai/gpt-6.1-sol] }
hosted: { speculative_routing: true }
`;

test("a router spec reads as the router the gateway serves", () => {
  // YAML 1.2: an unquoted `off` is the thinking level, not false.
  expect(parseRouterSpec("opus", parseRouterSpecText(EXAMPLE_SPEC))).toEqual({
    name: "Opus 5.5 + DeepSeek Subagents",
    router: {
      models: [
        { id: "anthropic/claude-opus-5-5" },
        { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", thinking: ["off", "high"], provider: "opencode-go" },
      ],
      agentModels: { codex: [{ id: "openai/gpt-6.1-sol" }] },
      roleModels: { main: "anthropic/claude-opus-5-5", subagent: "deepseek-ai/DeepSeek-V4.1-Flash-1017" },
      rolePrompts: { subagent: "Be brief." },
      retries: 2,
      subscriptions: true,
      sessionPinning: true,
      nativeCompaction: true,
      zdr: false,
    },
  });
});

test("an omitted setting takes its default, and a spec without subscription pays with keys", () => {
  const spec = (text: string) => parseRouterSpec("r", parseRouterSpecText(text)).router;
  expect(spec("name: Plain\nmodels: [openai/gpt-6.1-sol]")).toMatchObject({
    retries: 1,
    subscriptions: true,
    sessionPinning: false,
    nativeCompaction: false,
    roleModels: {},
    rolePrompts: {},
    agentModels: {},
  });
  expect(spec("name: Keys\nmodels: [openai/gpt-6.1-sol]\npayment: { allow: [key, credits] }").subscriptions).toBe(false);
});

test("a router spec the gateway cannot serve as written is refused", () => {
  const refused = (text: string) => () => parseRouterSpec("r", parseRouterSpecText(text));
  const models = "models: [openai/gpt-6.1-sol]";
  expect(refused(`name: R\n${models}\nzdr: true`)).toThrow("The router spec has unknown field zdr");
  expect(refused(`name: R\nmodels: [{ id: openai/gpt-6.1-sol, speed: 1 }]`)).toThrow("models[0] has unknown field speed");
  expect(refused(`name: R\n${models}\nrouting: { rules: [{ when: x }] }`)).toThrow("routing.rules runs only on hosted Dari");
  expect(refused(`name: R\n${models}\nroles: { main: { model: openai/gpt-6.1-terra } }`))
    .toThrow("roles.main.model must be one of the router's models.");
  expect(refused(`name: R\n${models}\nroles: { subagent: { prompt: "${"x".repeat(4001)}" } }`))
    .toThrow("roles.subagent.prompt must be text of at most 4000 characters.");
  expect(refused(`name: R\n${models}\npayment: { allow: [] }`)).toThrow("payment.allow needs at least one way to pay.");
  expect(refused(`name: R\n${models}\nrouting: { retries: 9 }`)).toThrow("routing.retries must be an integer from 0 to 5.");
  expect(refused(`name: R\nmodels: [{ id: openai/gpt-6.1-sol, thinking: [loud] }]`)).toThrow("invalid thinking levels");
  expect(refused(`name: R\nmodels: []`)).toThrow("non-empty `models` list");
  expect(refused(`models: [openai/gpt-6.1-sol]`)).toThrow("name must be text");
  expect(refused(`name: R\nmodels: [openai/gpt-6.1-sol\n`)).toThrow("not valid YAML");
});

test("a model names another provider only when that provider serves it", () => {
  const parsed = parseGatewayConfig({
    routers: { default: { models: [
      { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", provider: "fireworks" },
      // The provider its id names needs no `provider`.
      { id: "openai/gpt-6.1-sol", provider: "openai" },
    ] } },
  });
  expect(parsed.routers.default!.models).toEqual([
    { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", provider: "fireworks" },
    { id: "openai/gpt-6.1-sol" },
  ]);
  expect(() => parseGatewayConfig({
    routers: { default: { models: [{ id: "google/gemini-4-neon", provider: "opencode-go" }] } },
  })).toThrow("cannot be served by provider opencode-go on a self-hosted gateway; leave out `provider` to use google.");
  expect(() => parseGatewayConfig({
    routers: { default: { models: [{ id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", provider: "xai" }] } },
  })).toThrow("use fireworks or opencode-go, or leave out `provider`");
});

test("a config file router reads back as an equivalent spec", () => {
  const router = parseGatewayConfig({
    routers: { default: {
      models: ["anthropic/claude-opus-5-5", { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", thinking: ["off"], provider: "opencode-go" }],
      agentModels: { codex: ["openai/gpt-6.1-sol"] },
      roleModels: { subagent: "deepseek-ai/DeepSeek-V4.1-Flash-1017" },
      rolePrompts: { main: "Delegate." },
      subscriptions: false,
      sessionPinning: true,
      retries: 0,
    } },
  }).routers.default!;
  const yaml = routerSpecYaml(routerSpecFor("default", router));
  expect(yaml).toContain('- "off"');
  expect(parseRouterSpec("default", parseRouterSpecText(yaml))).toEqual({ name: "default", router });
});
