import { canonicalModelId, modelFamilyProvider, nativeModelId, providerForModel } from "./model_ids.js";
import type { RouterPrefixHit } from "./types.js";

// Provider prompt caches stop serving a prefix roughly five minutes after it
// was last written. Stored prefix entries outlive that: a host's lookback
// keeps them long enough to still name the conversation and the decision it
// continued from. Only entries inside this window describe warmth.
export const PREFIX_WARMTH_WINDOW_MS = 5 * 60 * 1000;

// Anthropic checks 20 positions per breakpoint, counting the breakpoint
// itself as the first, so an old cached breakpoint hits only when at most
// 19 content blocks were appended after it. These are routing estimates, never
// billing.
export const ANTHROPIC_LOOKBACK_BLOCKS = 19;
export const CROSS_TOKENIZER_RATIO = 1.1;
const OPENAI_MIN_CACHE_TOKENS = 1024;
const OPENAI_CACHE_INCREMENT_TOKENS = 128;

export type PromptCacheProvider = "openai" | "anthropic" | "fireworks" | "meta" | "xai";
export type ModelProviderLookup = (model: string) => string;

// Callers that know the serving provider pass it; otherwise the model id's
// prefix decides, and an id with no parseable prefix is an error, not a
// silently generic model. Family classification is shared with cache_scope
// through modelFamilyProvider, the single source of truth for how
// serving-provider aliases map to canonical model families.

export function isAnthropicFamily(model: string, provider?: string): boolean {
  return modelFamilyProvider(model, provider) === "anthropic";
}

export function isOpenAiFamily(model: string, provider?: string): boolean {
  return modelFamilyProvider(model, provider) === "openai";
}

function isFireworksFamily(model: string, provider?: string): boolean {
  return modelFamilyProvider(model, provider) === "fireworks";
}

function isMetaFamily(model: string, provider?: string): boolean {
  return modelFamilyProvider(model, provider) === "meta";
}

export function promptCacheProviderForModel(
  model: string,
  provider?: string,
): PromptCacheProvider | null {
  if (isOpenAiFamily(model, provider)) return "openai";
  if (isAnthropicFamily(model, provider)) return "anthropic";
  if (isFireworksFamily(model, provider)) return "fireworks";
  if (isMetaFamily(model, provider)) return "meta";
  if (modelFamilyProvider(model, provider) === "xai") return "xai";
  return null;
}

export function openAiCachedPrefixTokens(promptTokens: number): number {
  if (promptTokens < OPENAI_MIN_CACHE_TOKENS) return 0;
  const extra = promptTokens - OPENAI_MIN_CACHE_TOKENS;
  return (
    OPENAI_MIN_CACHE_TOKENS +
    Math.floor(extra / OPENAI_CACHE_INCREMENT_TOKENS) * OPENAI_CACHE_INCREMENT_TOKENS
  );
}

// Anthropic cache minimums vary by model family. Keep this routing-side
// estimate conservative for known higher-minimum models; unknown future
// direct Anthropic models fall back to the common 1024-token threshold.
export function anthropicMinCacheTokens(model: string, provider?: string): number {
  if (!isAnthropicFamily(model, provider)) return OPENAI_MIN_CACHE_TOKENS;
  const native = nativeModelId(model)
    .toLowerCase()
    .replace(/(?<=\d)\.(?=\d)/g, "-");

  if (
    native.includes("opus-4-6") ||
    native.includes("opus-4-5") ||
    native.includes("haiku-4-5")
  ) {
    return 4096;
  }
  if (native.includes("fable-5") || native.includes("haiku-5-5")) {
    return 512;
  }
  return OPENAI_MIN_CACHE_TOKENS;
}

export function tokenizerFamily(model: string, providerOverride?: string): string {
  const provider = modelFamilyProvider(model, providerOverride);
  if (provider === "fireworks") {
    const canonical = canonicalModelId(model).toLowerCase();
    const providerPrefixed = canonical.startsWith(`${provider}/`);
    const native = providerPrefixed ? nativeModelId(canonical) : canonical;
    const accountPrefix = "accounts/fireworks/models/";
    const modelFamily = native.startsWith(accountPrefix)
      ? native.slice(accountPrefix.length)
      : native;
    const slash = modelFamily.indexOf("/");
    return `${provider}/${slash === -1 ? modelFamily : modelFamily.slice(0, slash)}`;
  }
  return provider;
}

// A hit whose model id has no parseable prefix cannot prove provenance, so it
// reads as cold rather than erroring the legacy path.
function prefixProviderMatches(model: string, expected: string): boolean {
  try {
    return providerForModel(model) === expected;
  } catch {
    return false;
  }
}

export function prefixHitMatchesProvider(
  hit: RouterPrefixHit,
  currentProvider: string | undefined,
): boolean {
  const storedProvider = hit.provider?.trim().toLowerCase();
  if (!currentProvider) {
    // Legacy callers that do not declare an execution provider keep the old
    // prefix-inferred behavior. A stored provider proves provenance only when
    // it agrees with the model id's prefix; otherwise treat the hit as cold.
    if (!storedProvider) return true;
    return prefixProviderMatches(hit.model, storedProvider);
  }
  const current = currentProvider.toLowerCase();
  if (storedProvider) return storedProvider === current;
  return prefixProviderMatches(hit.model, current);
}

// Provisional native xAI model: the live probe observed a 640-token cached
// prefix on a 705-token prompt, with reads in 128-token increments. These
// are conservative modeling assumptions, not documented provider guarantees.
const XAI_MIN_CACHE_TOKENS = 640;
const XAI_CACHE_INCREMENT_TOKENS = 128;

export function providerMinCacheTokens(model: string, provider?: string): number {
  if (modelFamilyProvider(model, provider) === "xai") return XAI_MIN_CACHE_TOKENS;
  if (isAnthropicFamily(model, provider)) return anthropicMinCacheTokens(model, provider);
  if (isFireworksFamily(model, provider) || isMetaFamily(model, provider)) return 0;
  return OPENAI_MIN_CACHE_TOKENS;
}

// The stored entries a provider cache can still be re-reading at nowMs. This
// is the definition of "warm", and every cost estimate rests on it, so an
// unparseable timestamp reads as cold: warmth is proven, never assumed.
// nowMs is supplied by the caller because this package reads no clock.
export function warmPrefixHits(
  hits: readonly RouterPrefixHit[] | undefined,
  nowMs: number
): RouterPrefixHit[] {
  const cutoffMs = nowMs - PREFIX_WARMTH_WINDOW_MS;
  return (hits ?? []).filter((hit) => {
    const updatedAtMs = Date.parse(hit.updated_at);
    return Number.isFinite(updatedAtMs) && updatedAtMs >= cutoffMs;
  });
}

export function providerCacheableTokens(
  model: string,
  provider: PromptCacheProvider,
  prefixTokens: number
): number {
  if (prefixTokens <= 0) return 0;
  if (provider === "openai") return openAiCachedPrefixTokens(prefixTokens);
  if (provider === "xai") {
    return prefixTokens < XAI_MIN_CACHE_TOKENS
      ? 0
      : Math.floor(prefixTokens / XAI_CACHE_INCREMENT_TOKENS) * XAI_CACHE_INCREMENT_TOKENS;
  }
  if (provider === "anthropic") {
    return prefixTokens >= anthropicMinCacheTokens(model, provider) ? Math.floor(prefixTokens) : 0;
  }
  return Math.floor(prefixTokens);
}
