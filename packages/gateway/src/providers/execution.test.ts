import { expect, test } from "bun:test";

import { prepareProviderExecution } from "./provider_call.js";
import type { ResolvedRouter } from "../types.js";

const mappedRouter = (overrides: Partial<ResolvedRouter> = {}): ResolvedRouter => ({
  router_id: "rtr_openrouter",
  organization_id: "org_1",
  api_key_id: "key_1",
  attributed_user_id: null,
  enabled_models: ["xai/grok-4.5"],
  provider_keys: { openrouter: "or-key" },
  provider_key_sources: { openrouter: "user" },
  model_configs: {
    "xai/grok-4.5": {
      provider: "openrouter",
      native_model_id: "x-ai/grok-4.5",
      api: "openai-completions",
      cost: { input: 2, output: 6, cached_input: 0.3, cache_write: 0 },
    },
  },
  ...overrides,
});

const prepare = (credentials: ResolvedRouter) =>
  prepareProviderExecution({
    decision: {
      selectedModel: "xai/grok-4.5",
      reasoningEffort: "high",
      reason: "test",
    },
    credentials,
    billable: true,
    routerId: credentials.router_id,
    pricing: () => null,
    conversationId: "conv_1",
  });

test("prepareProviderExecution uses the mapped provider key and keeps BYOK unbilled", () => {
  const execution = prepare(mappedRouter());
  expect(execution.apiKey).toBe("or-key");
  expect(execution.headers["X-Dari-Provider-Key-Source"]).toBe("user");
  expect(execution.usageContext).toBeUndefined();
});

test("prepareProviderExecution bills managed-key calls to the organization", () => {
  const managed = mappedRouter({
    provider_keys: { openrouter: "managed-key" },
    provider_key_sources: { openrouter: "managed" },
  });

  const execution = prepare(managed);
  expect(execution.headers["X-Dari-Provider-Key-Source"]).toBe("managed");
  expect(execution.usageContext).toMatchObject({
    organizationId: "org_1",
    routerId: "rtr_openrouter",
    model: "xai/grok-4.5",
  });
});

test("prepareProviderExecution carries Bedrock SigV4 credentials without exposing them as an API key", () => {
  const execution = prepareProviderExecution({
    decision: {
      selectedModel: "openai/gpt-5.6-sol",
      reasoningEffort: "medium",
      reason: "test",
    },
    credentials: mappedRouter({
      enabled_models: ["openai/gpt-5.6-sol"],
      provider_keys: {},
      provider_auth: {
        "amazon-bedrock": {
          type: "aws_sigv4",
          access_key_id: "AKIAEXAMPLE",
          secret_access_key: "secret-example",
          session_token: "session-example",
          region: "us-east-1",
        },
      },
      provider_key_sources: { "amazon-bedrock": "user" },
      model_configs: {
        "openai/gpt-5.6-sol": {
          provider: "amazon-bedrock",
          native_model_id: "global.openai.gpt-5.6-sol",
          api: "bedrock-converse-stream",
          cost: { input: 1, output: 2 },
        },
      },
    }),
    billable: true,
    routerId: "rtr_openrouter",
    pricing: () => null,
    conversationId: "conv_1",
  });

  expect(execution.apiKey).toBe("");
  expect(execution.auth).toEqual({
    type: "aws_sigv4",
    access_key_id: "AKIAEXAMPLE",
    secret_access_key: "secret-example",
    session_token: "session-example",
    region: "us-east-1",
  });
  expect(execution.headers["X-Dari-Provider-Key-Source"]).toBe("user");
});

test("prepareProviderExecution carries the router's ZDR setting onto the model config", () => {
  expect(prepare(mappedRouter({ zdr: true })).config?.zdr).toBe(true);
  expect(prepare(mappedRouter({ zdr: false })).config?.zdr).toBe(false);
});
