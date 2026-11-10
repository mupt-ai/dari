import { expect, test } from "bun:test";

import { executionProviderForModel } from "./execution_provider.js";
import type { ResolvedRouter } from "../types.js";

const router = {
  router_id: "rtr_1",
  organization_id: "org_1",
  api_key_id: null,
  attributed_user_id: null,
  enabled_models: ["xai/grok-4.5"],
  provider_keys: {},
  model_configs: {
    "xai/grok-4.5": {
      provider: "openrouter",
      native_model_id: "x-ai/grok-4.5",
      api: "openai-completions",
      cost: { input: 2, output: 6 },
    },
  },
} satisfies ResolvedRouter;

test("managed runtime prefers resolved execution provider over canonical prefix", () => {
  expect(executionProviderForModel(router, "xai/grok-4.5")).toBe("openrouter");
});

test("standalone compatibility falls back to canonical prefix", () => {
  expect(executionProviderForModel(router, "anthropic/claude-sonnet-5")).toBe("anthropic");
});
