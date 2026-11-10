import { canonicalModelId, isRecord } from "@mupt-ai/dari-router/policy-engine";

import { gatewayFor } from "./gateways.js";

const MODEL_CONTEXT_OVERRIDES: Record<string, number> = {
  // Selector and title models are not router candidate configs, so their
  // context windows cannot depend on the Pi registry carrying them.
  "openai/gpt-5.6-luna": 1_050_000,
  "openai/gpt-6-luna": 1_050_000,
};

// Models whose true non-reasoning mode is the provider-literal effort "none"
// rather than omitting the field. Live-validated: Fireworks DeepSeek thinks
// by default when the request carries no reasoning_effort (and pi-ai's
// completions path drops Dari's "off" before serializing), so a client's
// explicit off must be injected into the provider payload as
// reasoning_effort "none" (verified quiet: ~2 output tokens vs ~40 thinking).
// OpenAI gpt-5.x models need no entry: the pi-ai registry already maps their
// "off" to wire "none".
// Models whose catalog metadata is not yet bundled in the installed Pi registry
// but need explicit compat overrides to produce correct provider payloads.
const MODEL_COMPAT_OVERRIDES: Record<string, Record<string, unknown>> = {
  // The Pi registry does not carry Fable 5.1, Opus 5.5, Sonnet 5.5, and Opus 5's
  // adaptive-thinking compatibility for every serving provider (OpenRouter,
  // Bedrock), so it is declared here. Sonnet 5 is in the Pi
  // registry (with forceAdaptiveThinking), but it's missing supportsTemperature
  // (the Anthropic docs confirm non-default temperature returns 400).
  "anthropic/claude-fable-5-1": {
    forceAdaptiveThinking: true,
    supportsTemperature: false,
  },
  "anthropic/claude-fable-5-2": {
    forceAdaptiveThinking: true,
    supportsTemperature: false,
  },
  "anthropic/claude-opus-5-5": {
    forceAdaptiveThinking: true,
    supportsTemperature: false,
    supportsMidConvoEffort: true,
  },
  "anthropic/claude-opus-5": {
    forceAdaptiveThinking: true,
    supportsTemperature: false,
  },
  "anthropic/claude-sonnet-5-5": {
    forceAdaptiveThinking: true,
    supportsTemperature: false,
    supportsMidConvoEffort: true,
  },
  "anthropic/claude-sonnet-5": {
    supportsTemperature: false,
  },
  "anthropic/claude-haiku-5-5": {
    forceAdaptiveThinking: true,
    supportsTemperature: false,
  },
  // GPT-6 Astra always reasons and OpenAI rejects temperature on it (400
  // "Unsupported parameter: 'temperature'"), on api.openai.com and on Azure
  // alike. The OpenAI transports do not read this flag themselves, so
  // buildOptions drops the parameter. Live-validated 2026-09-15.
  "openai/gpt-6-astra": {
    supportsTemperature: false,
  },
  // GPT-6 Sol and Luna are newer than the installed Pi registry. They retain
  // the GPT-5.6 Responses feature set, including explicit prompt caching and
  // deferred tool loading. Keep this local until Pi ships their metadata.
  "openai/gpt-6.1-sol": {
    supportsStrictMode: true,
    supportsOpenAIGrammarTools: true,
    supportsAdditionalTools: true,
    supportsToolSearch: true,
    supportsExplicitPromptCacheMode: true,
    supportsReasoningConfigurationUpdate: true,
  },
  "openai/gpt-6.1-terra": {
    supportsStrictMode: true,
    supportsOpenAIGrammarTools: true,
    supportsAdditionalTools: true,
    supportsToolSearch: true,
    supportsExplicitPromptCacheMode: true,
    supportsReasoningConfigurationUpdate: true,
  },
  "openai/gpt-6-sol": {
    supportsStrictMode: true,
    supportsOpenAIGrammarTools: true,
    supportsAdditionalTools: true,
    supportsToolSearch: true,
    supportsExplicitPromptCacheMode: true,
    supportsReasoningConfigurationUpdate: true,
  },
  "openai/gpt-6-luna": {
    supportsStrictMode: true,
    supportsOpenAIGrammarTools: true,
    supportsAdditionalTools: true,
    supportsToolSearch: true,
    supportsExplicitPromptCacheMode: true,
    supportsReasoningConfigurationUpdate: true,
  },
  // Kimi K3 is not in the installed Pi registry under the Fireworks provider.
  // Fireworks returns preserved thinking in reasoning_content and accepts the
  // model's documented low/high/max reasoning_effort values.
  "moonshotai/Kimi-K3": {
    thinkingFormat: "deepseek",
    supportsReasoningEffort: true,
    requiresReasoningContentOnAssistantMessages: true,
  },
  // DeepSeek V4 Flash 0731 is not in the installed Pi registry (new model),
  // so it needs the same compat overrides as Kimi K3 for correct deepseek-
  // format response parsing and multi-turn reasoning continuity.
  "deepseek-ai/DeepSeek-V4-Flash-0731": {
    thinkingFormat: "deepseek",
    supportsReasoningEffort: true,
    requiresReasoningContentOnAssistantMessages: true,
  },
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
    thinkingFormat: "deepseek",
    supportsReasoningEffort: true,
    requiresReasoningContentOnAssistantMessages: true,
  },
};

// Serving-provider specific compat that replaces the model-level override
// above. Microsoft Foundry serves DeepSeek through its own OpenAI-compatible
// endpoint: the `thinking` parameter the deepseek thinking format sends is
// rejected (400 unrecognized_request_argument), plain reasoning_effort
// (none/low/high/max) is accepted, and reasoning comes back in
// reasoning_content. Grok on Foundry takes reasoning_effort the same way.
// Live-validated against a Foundry resource on 2026-09-15.
const PROVIDER_MODEL_COMPAT_OVERRIDES: Record<string, Record<string, Record<string, unknown>>> = {
  azure: {
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
      supportsReasoningEffort: true,
      requiresReasoningContentOnAssistantMessages: true,
    },
    "xai/grok-4.6": {
      supportsReasoningEffort: true,
    },
    "xai/grok-4.7": {
      supportsReasoningEffort: true,
    },
  },
};

// Compat keys that describe a model's native reasoning wire format, which a
// gateway replaces with its own.
const NATIVE_REASONING_COMPAT_KEYS: ReadonlySet<string> = new Set([
  "thinkingFormat",
  "supportsReasoningEffort",
  "requiresReasoningContentOnAssistantMessages",
]);

// Models whose input modalities are not detectable from the Pi registry.
// GPT-5.6 is registered for Bedrock only under the unprefixed
// "openai.gpt-5.6-*" ids; Dari executes the "us." inference profiles, which
// miss the registry and would otherwise be pruned as text-only.
const MODEL_INPUT_OVERRIDES: Record<string, string[]> = {
  "anthropic/claude-haiku-5-5": ["text", "image"],
  "anthropic/claude-sonnet-5-5": ["text", "image"],
  "meta/muse-ember": ["text", "image"],
  "openai/gpt-6.1-sol": ["text", "image"],
  "openai/gpt-6.1-terra": ["text", "image"],
  "openai/gpt-6-sol": ["text", "image"],
  "openai/gpt-6-luna": ["text", "image"],
  "openai/gpt-5.6-luna": ["text", "image"],
  "openai/gpt-5.6-sol": ["text", "image"],
  "openai/gpt-5.6-terra": ["text", "image"],
  "openai/gpt-6-astra": ["text", "image"],
  "moonshotai/Kimi-K3": ["text", "image"],
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": ["text", "image"],
  "zai-org/GLM-5.3-Flash": ["text", "image"],
  // Grok 4.6 and 4.7 are registered for xAI's Responses API only; Foundry
  // serves them through chat completions with the same text and image input.
  "xai/grok-4.6": ["text", "image"],
  "xai/grok-4.7": ["text", "image"],
};

const MODEL_OFF_WIRE_NONE: ReadonlySet<string> = new Set([
  // No longer bundled under Fireworks in Pi 1.1; preserve explicit off.
  "zai-org/GLM-5.2",
  "deepseek-ai/DeepSeek-V4-Pro-0813",
  "fireworks/deepseek-ai/DeepSeek-V4-Flash",
  "deepseek-ai/DeepSeek-V4-Flash-0731",
  "deepseek-ai/DeepSeek-V4.1-Flash-1017",
]);

// Wire values a provider's API accepts for thinking levels the Pi registry
// leaves unmapped. Meta's Model API takes reasoning effort "none" on every
// Muse model (dev.meta.ai/docs/coding-agents).
const PROVIDER_THINKING_LEVEL_OVERRIDES: Record<string, Record<string, string>> = {
  meta: { off: "none" },
};

export function providerThinkingLevelOverrides(provider: string): Record<string, string> | undefined {
  return PROVIDER_THINKING_LEVEL_OVERRIDES[provider];
}

/** Registered Pi metadata with the serving provider's thinking level overrides. */
export function withThinkingLevelOverrides(
  provider: string,
  registered: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const override = providerThinkingLevelOverrides(provider);
  if (registered === undefined || override === undefined) return registered;
  const map = isRecord(registered.thinkingLevelMap) ? registered.thinkingLevelMap : {};
  return { ...registered, thinkingLevelMap: { ...map, ...override } };
}

export function offRequiresWireNone(modelId: string): boolean {
  return MODEL_OFF_WIRE_NONE.has(canonicalModelId(modelId));
}

export function contextWindowOverride(modelId: string): number | undefined {
  return MODEL_CONTEXT_OVERRIDES[canonicalModelId(modelId)];
}

export function inputModalitiesOverride(modelId: string): string[] | undefined {
  return MODEL_INPUT_OVERRIDES[canonicalModelId(modelId)];
}

export function runtimeCompat(provider: string, registered: Record<string, unknown> | undefined, modelId?: string): unknown {
  const canonical = modelId ? canonicalModelId(modelId) : undefined;
  const compatOverride = canonical
    ? PROVIDER_MODEL_COMPAT_OVERRIDES[provider]?.[canonical] ?? MODEL_COMPAT_OVERRIDES[canonical]
    : undefined;
  const gateway = gatewayFor(provider);
  if (gateway) {
    // A gateway's own dialect decides how reasoning goes over the wire, so
    // the model overrides' native reasoning settings do not apply.
    const modelOverride = Object.fromEntries(
      Object.entries(compatOverride ?? {}).filter(([key]) => !NATIVE_REASONING_COMPAT_KEYS.has(key)),
    );
    return {
      ...(isRecord(registered?.compat) ? registered.compat : {}),
      ...modelOverride,
      ...gateway.compat,
    };
  }
  if (provider !== "fireworks") {
    if (compatOverride === undefined) return registered?.compat;
    return {
      ...(isRecord(registered?.compat) ? registered.compat : {}),
      ...compatOverride,
    };
  }
  // Fireworks needs two compat defaults pi-ai does not detect for it:
  // serverless cache hits ride on session-affinity headers pi-ai only sends
  // when compat asks for them, and several Fireworks chat templates (e.g.
  // DeepSeek) silently drop developer-role messages, so system prompts must
  // go out under the system role. Registry-declared compat keys still win,
  // and per-model overrides win over both for models the registry omits.
  return {
    sendSessionAffinityHeaders: true,
    supportsDeveloperRole: false,
    ...(isRecord(registered?.compat) ? registered.compat : {}),
    ...compatOverride,
  };
}
