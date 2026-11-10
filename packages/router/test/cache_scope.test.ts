import { expect, test } from "bun:test";

import {
  cachePartitionKey,
  reasoningCacheScope,
  type ReasoningCacheScopeLookup,
} from "../src/cache_scope.js";

const SOL = "openai/gpt-5.6-sol";
const GPT_6_1_SOL = "openai/gpt-6.1-sol";
const GPT_6_SOL = "openai/gpt-6-sol";
const GPT_6_LUNA = "openai/gpt-6-luna";
const GLM = "zai-org/GLM-5.2";
const GLM_5_3 = "zai-org/GLM-5.3";

test("partition keys follow the provider's reasoning cache scope", () => {
  // Effort-keyed: each effective effort warms its own partition, and an entry
  // written before buckets existed is its own rather than any effort's.
  expect(cachePartitionKey(SOL, "low")).not.toBe(cachePartitionKey(SOL, "high"));
  expect(cachePartitionKey(SOL, null)).not.toBe(cachePartitionKey(SOL, "low"));
  expect(cachePartitionKey(SOL, "low")).toBe(cachePartitionKey(SOL, "low"));

  // GPT-6 Sol variants share first-party OpenAI cache identity across efforts.
  expect(reasoningCacheScope(GPT_6_1_SOL, "openai")).toBe("shared");
  expect(reasoningCacheScope("anthropic/claude-opus-5-5", "anthropic")).toBe("shared");
  expect(reasoningCacheScope(GPT_6_SOL, "openai")).toBe("shared");
  expect(reasoningCacheScope(GPT_6_LUNA, "openai")).toBe("shared");
  expect(cachePartitionKey(GPT_6_SOL, "low", undefined, "openai")).toBe(
    cachePartitionKey(GPT_6_SOL, "max", undefined, "openai"),
  );
  expect(cachePartitionKey(GPT_6_LUNA, "off", undefined, "openai")).toBe(
    cachePartitionKey(GPT_6_LUNA, "high", undefined, "openai"),
  );
  // Do not assume an intermediary provider offers the same cache contract.
  expect(reasoningCacheScope(GPT_6_SOL, "openrouter")).toBe("effort_keyed");

  // Shared: one partition per model, so effort cannot split it.
  const fireworksScope = (model: string) => reasoningCacheScope(model, "fireworks");
  expect(cachePartitionKey(GLM, "off", fireworksScope)).toBe(cachePartitionKey(GLM, "medium", fireworksScope));
  expect(cachePartitionKey(GLM, "off", fireworksScope)).not.toBe(cachePartitionKey(SOL, "off"));

  // Fireworks GLM 5.3 uses separate provider cache partitions by effort.
  expect(cachePartitionKey(GLM_5_3, "low", fireworksScope)).not.toBe(cachePartitionKey(GLM_5_3, "max", fireworksScope));
  expect(cachePartitionKey(GLM, "off", fireworksScope, "fireworks")).not.toBe(
    cachePartitionKey(GLM, "off", () => "effort_keyed", "openrouter"),
  );

  // A host that reclassifies a provider moves its storage with the estimator.
  const shared: ReasoningCacheScopeLookup = () => "shared";
  expect(cachePartitionKey(SOL, "low", shared)).toBe(cachePartitionKey(SOL, "high", shared));
});
