import { canonicalModelId, modelFamilyProvider } from "./model_ids.js";

export type ReasoningCacheScope = "effort_keyed" | "shared";

// How a model's provider prompt cache behaves when the reasoning payload
// changes between otherwise identical requests, from live-provider and
// router-path validation:
//   effort_keyed - each effective reasoning effort warms its own cache
//                  partition; switching effort misses/rewrites, switching back
//                  reuses that effort's still-warm partition.
//   shared       - one cache partition regardless of reasoning effort.
// OpenAI reasoning models through GPT-5.6 are effort_keyed (a first-ever
// effort missed a steady-warm prefix on every model tested). GPT-6 Sol and
// Luna explicitly preserve prompt-cache identity across effort changes, so
// their first-party OpenAI partitions are shared. Anthropic models are effort_keyed
// because the executor places cache_control on message blocks, which Anthropic
// invalidates on thinking changes; Opus 5.5 is the exception, since it supports
// mid-conversation effort changes without invalidating the prefix cache.
// Budget-thinking Haiku would share under a system-block breakpoint, so
// revalidate its entry if an executor's Anthropic cache placement changes.
// Fireworks caching ignored reasoning entirely.
// Unlisted models default to effort_keyed: the safe direction is to
// under-claim warmth, never to price a cold prefix as a cache read.
export const DEFAULT_REASONING_CACHE_SCOPES: Readonly<Record<string, ReasoningCacheScope>> = {
  "openai:openai/gpt-6.1-sol": "shared",
  "openai:openai/gpt-6-sol": "shared",
  "openai:openai/gpt-6-luna": "shared",
  "openai:openai/gpt-5.6-sol": "effort_keyed",
  "openai:openai/gpt-5.6-terra": "effort_keyed",
  "openai:openai/gpt-5.6-luna": "effort_keyed",
  "anthropic:anthropic/claude-opus-4-8": "effort_keyed",
  "anthropic:anthropic/claude-opus-5-5": "shared",
  "anthropic:anthropic/claude-haiku-4-5": "effort_keyed", // via executor message-block cache_control; see note above
  "fireworks:deepseek-ai/DeepSeek-V4-Pro-0813": "shared",
  "fireworks:deepseek-ai/DeepSeek-V4-Flash-0731": "shared",
  "fireworks:zai-org/GLM-5.2": "shared",
  "fireworks:zai-org/GLM-5.3-Flash": "shared",
};

export type ReasoningCacheScopeLookup = (modelId: string) => ReasoningCacheScope;

export function reasoningCacheScope(
  modelId: string,
  provider?: string,
): ReasoningCacheScope {
  const canonical = canonicalModelId(modelId);
  // Scope keys name the canonical family provider, so a serving alias reads
  // the owner's row instead of defaulting to effort_keyed.
  const familyProvider = modelFamilyProvider(canonical, provider).toLowerCase();
  const legacyPrefix = `${familyProvider}/`;
  const providerNeutral = familyProvider === "fireworks" && canonical.startsWith(legacyPrefix)
    ? canonical.slice(legacyPrefix.length)
    : canonical;
  return DEFAULT_REASONING_CACHE_SCOPES[`${familyProvider}:${providerNeutral}`]
    ?? "effort_keyed";
}

// The provider cache partition a prefix entry belongs to. An effort-keyed
// provider warms one partition per effective reasoning effort, so the pair
// identifies it; a shared-scope provider holds a single partition per model,
// and keying that by effort would remember several entries describing one
// cache. Hosts that store warmth per partition derive their key here so a
// reclassified provider moves the estimator and their storage together.
// modelId is used verbatim, matching how ChainHits keys warm prefixes: ids that
// differ only in spelling stay separate rather than cross-contaminating. The
// separator cannot appear in a model id or a bucket, so the pair is injective
// and can never collide with a shared-scope key.
export function cachePartitionKey(
  modelId: string,
  reasoningBucket: string | null | undefined,
  cacheScope?: ReasoningCacheScopeLookup,
  provider?: string,
): string {
  const scope = cacheScope ?? ((model: string) => reasoningCacheScope(model, provider));
  const executionIdentity = provider ? `${provider.toLowerCase()}\u0000${modelId}` : modelId;
  if (scope(modelId) === "shared") return executionIdentity;
  return `${executionIdentity}\u0000${reasoningBucket ?? ""}`;
}
