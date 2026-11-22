import { expect, test } from "bun:test";

import { reasoningCacheScope } from "../src/cache_scope.js";

const SOL = "openai/gpt-5.6-sol";
const GPT_6_1_SOL = "openai/gpt-6.1-sol";
const GPT_6_SOL = "openai/gpt-6-sol";
const GPT_6_LUNA = "openai/gpt-6-luna";
const GLM = "zai-org/GLM-5.2";
const GLM_5_3 = "zai-org/GLM-5.3";

test("reasoning cache scope follows the provider's cache contract", () => {
  // GPT-6 Sol variants share first-party OpenAI cache identity across efforts.
  expect(reasoningCacheScope(GPT_6_1_SOL, "openai")).toBe("shared");
  expect(reasoningCacheScope("anthropic/claude-opus-5-5", "anthropic")).toBe("shared");
  expect(reasoningCacheScope(GPT_6_SOL, "openai")).toBe("shared");
  expect(reasoningCacheScope(GPT_6_LUNA, "openai")).toBe("shared");
  // Do not assume an intermediary provider offers the same cache contract.
  expect(reasoningCacheScope(GPT_6_SOL, "openrouter")).toBe("effort_keyed");
  expect(reasoningCacheScope(SOL)).toBe("effort_keyed");
  // Fireworks GLM shares one partition per model; GLM 5.3 is keyed by effort.
  expect(reasoningCacheScope(GLM, "fireworks")).toBe("shared");
  expect(reasoningCacheScope(GLM_5_3, "fireworks")).toBe("effort_keyed");
});
