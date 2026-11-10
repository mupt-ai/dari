import { expect, test } from "bun:test";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels as getPiSupportedThinkingLevels,
} from "@mupt-ai/pi-ai";
import { getBuiltinModel } from "@mupt-ai/pi-ai/providers/all";

import { chatCompletionsToInteraction } from "../protocol/input/chat_completions.js";
import { modelSupportsImageInput } from "./model_capabilities.js";
import { buildOptions } from "./pi_options.js";
import type { ResolvedRouterModelConfig } from "../types.js";
import {
  buildModel,
  modelContextWindow,
  modelMetadataLookup,
  piFixture,
  requestWithReasoning,
} from "./pi.fixtures.js";

test("Claude Fable 5 is available in the Pi model registry", () => {
  const anthropic = getBuiltinModel("anthropic", "claude-fable-5");

  expect(anthropic?.contextWindow).toBe(1_000_000);
  expect(anthropic?.cost).toEqual({
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
  });
});
test("Claude Sonnet 5 is available in the Pi model registry", () => {
  const anthropic = getBuiltinModel("anthropic", "claude-sonnet-5");

  expect(anthropic?.contextWindow).toBe(1_000_000);
  expect(anthropic?.maxTokens).toBe(128_000);
  expect(anthropic?.cost).toEqual({
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
  });
  expect(getPiSupportedThinkingLevels(anthropic!)).toEqual([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("Claude Opus 5.5 is available in the Pi model registry with image input", async () => {
  expect(getBuiltinModel("anthropic", "claude-opus-5-5")?.input).toEqual(["text", "image"]);

  // Image-bearing conversations prune text-only candidates, so this is what
  // keeps Opus 5.5 routable once a conversation contains an image.
  const metadata = modelMetadataLookup();
  expect(modelSupportsImageInput(metadata("anthropic/claude-opus-5-5"))).toBe(true);
});

test("Claude Opus 5.5 catalog pricing and limits override the Pi registry", async () => {
  const config: ResolvedRouterModelConfig = {
    provider: "anthropic",
    native_model_id: "claude-opus-5-5",
    api: "anthropic-messages",
    base_url: "https://api.anthropic.com",
    context_window: 1_000_000,
    max_output_tokens: 128_000,
    supported_thinking_levels: ["off", "low", "medium", "high", "xhigh", "max"],
    default_thinking_level: "high",
    supports_managed_key: true,
    fast_mode: true,
    fast_mode_cost: { input: 10, output: 50, cached_input: 1, cache_write: 12.5 },
    cost: { input: 5, output: 25, cached_input: 0.5, cache_write: 6.25 },
  };

  const metadata = modelMetadataLookup({ "anthropic/claude-opus-5-5": config });

  expect(metadata("anthropic/claude-opus-5-5").model).toMatchObject({
    id: "claude-opus-5-5",
    maxTokens: 128_000,
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    fastMode: true,
  });
});

test("unknown Fireworks registry metadata is not invented", async () => {
  expect(modelContextWindow("fireworks/acme/custom-model")).toBeNull();
});

test("resolved model config overrides Pi registry execution metadata", () => {
  const pi = {
    ...piFixture,
    getModel: () => ({
      id: "accounts/fireworks/models/deepseek-v4-pro",
      provider: "fireworks",
      api: "anthropic-messages",
      baseUrl: "https://api.fireworks.ai/inference",
      cost: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
    }),
  };
  const config: ResolvedRouterModelConfig = {
    provider: "fireworks",
    native_model_id: "accounts/fireworks/models/deepseek-v4-pro",
    api: "openai-completions",
    base_url: "https://api.fireworks.ai/inference/v1",
    context_window: 131_000,
    supports_managed_key: true,
    cost: { input: 1.74, output: 3.48, cached_input: 0.145, cache_write: 0 },
  };

  const model = buildModel(
    pi,
    "deepseek-ai/DeepSeek-V4-Pro-0813",
    { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
    config
  );

  expect(model.id).toBe("accounts/fireworks/models/deepseek-v4-pro");
  expect(model.api).toBe("openai-completions");
  expect(model.baseUrl).toBe("https://api.fireworks.ai/inference/v1");
  expect(model.cost).toEqual({ input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 });
  expect(model.contextWindow).toBe(131_000);
});

test("builds GPT-6 Astra from resolved catalog metadata without Pi registry support", () => {
  const config: ResolvedRouterModelConfig = {
    provider: "openai",
    native_model_id: "gpt-6-astra",
    api: "openai-responses",
    base_url: "https://api.openai.com/v1",
    context_window: 1_050_000,
    max_output_tokens: 128_000,
    supported_thinking_levels: ["low", "medium", "high", "xhigh", "max"],
    default_thinking_level: "medium",
    supports_managed_key: true,
    fast_mode: true,
    fast_mode_cost: { input: 20, output: 100, cached_input: 2, cache_write: 25 },
    cost: { input: 10, output: 50, cached_input: 1, cache_write: 12.5 },
  };

  const model = buildModel(piFixture, "openai/gpt-6-astra", null, config);

  expect(model).toMatchObject({
    id: "gpt-6-astra",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    defaultThinkingLevel: "medium",
    supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    fastMode: true,
  });
});

test("builds GPT-6 Sol variants and Luna with cache-safe Responses metadata before Pi registry support", () => {
  const models = [
    { id: "openai/gpt-6.1-sol", nativeId: "gpt-6.1-sol", input: 2, output: 10 },
    { id: "openai/gpt-6-sol", nativeId: "gpt-6-sol", input: 2, output: 10 },
    { id: "openai/gpt-6-luna", nativeId: "gpt-6-luna", input: 0.1, output: 0.5 },
  ] as const;

  for (const expected of models) {
    const config: ResolvedRouterModelConfig = {
      provider: "openai",
      native_model_id: expected.nativeId,
      api: "openai-responses",
      base_url: "https://api.openai.com/v1",
      context_window: 272_000,
      max_output_tokens: 128_000,
      supported_thinking_levels: ["off", "low", "medium", "high", "xhigh", "max"],
      default_thinking_level: "medium",
      supports_managed_key: true,
      cost: { input: expected.input, output: expected.output, cached_input: expected.input / 10, cache_write: expected.input * 1.25 },
    };

    const model = buildModel(piFixture, expected.id, null, config);

    expect(model).toMatchObject({
      id: expected.nativeId,
      provider: "openai",
      api: "openai-responses",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 272_000,
      maxTokens: 128_000,
      defaultThinkingLevel: "medium",
      supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
      thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" },
    });
    expect(model.compat).toMatchObject({
      supportsStrictMode: true,
      supportsOpenAIGrammarTools: true,
      supportsAdditionalTools: true,
      supportsToolSearch: true,
      supportsExplicitPromptCacheMode: true,
      supportsReasoningConfigurationUpdate: true,
    });

    const low = buildOptions(
      chatCompletionsToInteraction(requestWithReasoning({ reasoning_effort: "low" })),
      "openai-key",
      expected.id,
      model,
      piFixture,
      "stable-conversation",
    );
    const high = buildOptions(
      chatCompletionsToInteraction(requestWithReasoning({ reasoning_effort: "high" })),
      "openai-key",
      expected.id,
      model,
      piFixture,
      "stable-conversation",
    );
    expect(low).toMatchObject({ sessionId: "stable-conversation", reasoning: "low" });
    expect(high).toMatchObject({ sessionId: "stable-conversation", reasoning: "high" });
  }
});

test("keeps image input for GPT-5.6 Bedrock inference profiles missing from the Pi registry", () => {
  const config: ResolvedRouterModelConfig = {
    provider: "amazon-bedrock",
    native_model_id: "us.openai.gpt-5.6-luna",
    api: "bedrock-converse-stream",
    base_url: "https://bedrock-runtime.us-east-1.amazonaws.com",
    context_window: 1_050_000,
    max_output_tokens: 128_000,
    supported_thinking_levels: ["off", "low", "medium", "high", "xhigh", "max"],
    default_thinking_level: "medium",
    supports_managed_key: false,
    cost: { input: 0.2, output: 1.2, cached_input: 0.02, cache_write: 0.25 },
  };

  const model = buildModel(piFixture, "openai/gpt-5.6-luna", null, config);

  expect(model).toMatchObject({
    id: "us.openai.gpt-5.6-luna",
    provider: "amazon-bedrock",
    api: "bedrock-converse-stream",
    input: ["text", "image"],
  });
});

test("keeps Haiku 5.5 image input without Pi registry support across serving providers", () => {
  for (const provider of ["anthropic", "amazon-bedrock", "openrouter", "vercel-ai-gateway"]) {
    const model = buildModel(piFixture, "anthropic/claude-haiku-5-5", null, {
      provider,
      native_model_id: provider === "anthropic"
        ? "claude-haiku-5-5"
        : provider === "amazon-bedrock"
          ? "us.anthropic.claude-haiku-5-5"
          : "anthropic/claude-haiku-5.5",
      api: provider === "anthropic" ? "anthropic-messages"
        : provider === "amazon-bedrock" ? "bedrock-converse-stream" : "openai-completions",
      context_window: 1_000_000,
      max_output_tokens: 128_000,
      supported_thinking_levels: ["low", "medium", "high", "xhigh", "max"],
      default_thinking_level: "high",
      cost: { input: 0.1, output: 0.5 },
    });
    expect(model.input).toContain("image");
  }
});

test("builds Claude Fable 5.1 from resolved catalog metadata without Pi registry support", () => {
  const config: ResolvedRouterModelConfig = {
    provider: "anthropic",
    native_model_id: "claude-fable-5-1",
    api: "anthropic-messages",
    base_url: "https://api.anthropic.com",
    context_window: 1_000_000,
    max_output_tokens: 128_000,
    supported_thinking_levels: ["low", "medium", "high", "xhigh", "max"],
    default_thinking_level: "high",
    supports_managed_key: true,
    cost: { input: 10, output: 50, cached_input: 0.25, cache_write: 12.5 },
  };

  const model = buildModel(
    piFixture,
    "anthropic/claude-fable-5-1",
    { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    config,
  );

  expect(model).toMatchObject({
    id: "claude-fable-5-1",
    provider: "anthropic",
    api: "anthropic-messages",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    reasoning: true,
    defaultThinkingLevel: "high",
    cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  });
});

test("builds Claude Opus 5 from resolved catalog metadata without Pi registry support", () => {
  const config: ResolvedRouterModelConfig = {
    provider: "anthropic",
    native_model_id: "claude-opus-5",
    api: "anthropic-messages",
    base_url: "https://api.anthropic.com",
    context_window: 1_000_000,
    max_output_tokens: 128_000,
    supported_thinking_levels: ["off", "low", "medium", "high", "xhigh", "max"],
    default_thinking_level: "high",
    supports_managed_key: true,
    fast_mode: true,
    fast_mode_cost: { input: 10, output: 50, cached_input: 1, cache_write: 12.5 },
    cost: { input: 5, output: 25, cached_input: 0.5, cache_write: 6.25 },
  };

  const model = buildModel(piFixture, "anthropic/claude-opus-5", null, config);

  expect(model).toMatchObject({
    id: "claude-opus-5",
    name: "claude-opus-5",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    compat: { forceAdaptiveThinking: true },
    defaultThinkingLevel: "high",
    supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    fastMode: true,
  });
});

test("builds Meta Muse Spark from resolved catalog metadata without Pi registry support", () => {
  const config: ResolvedRouterModelConfig = {
    provider: "meta",
    native_model_id: "muse-spark-1.1",
    api: "openai-completions",
    base_url: "https://api.meta.ai/v1",
    context_window: 1_048_576,
    max_output_tokens: 131_072,
    supported_thinking_levels: ["minimal", "low", "medium", "high", "xhigh"],
    default_thinking_level: "medium",
    supports_managed_key: true,
    cost: { input: 1.25, output: 4.25, cached_input: 0.15, cache_write: 0 },
  };

  const model = buildModel(piFixture, "meta/muse-spark-1.1", null, config);

  expect(model).toMatchObject({
    id: "muse-spark-1.1",
    name: "muse-spark-1.1",
    provider: "meta",
    api: "openai-completions",
    baseUrl: "https://api.meta.ai/v1",
    reasoning: true,
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    defaultThinkingLevel: "medium",
    supportedThinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
    cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
  });
});

test("fireworks models get session affinity and system-role compat defaults", () => {
  // Fireworks prompt caching is on by default but serverless cache hits ride
  // on the affinity headers pi-ai sends only when compat requests them, and
  // Fireworks chat templates can silently drop developer-role messages.
  const model = buildModel(piFixture, "fireworks/acme/custom-model");
  expect(model.compat).toEqual({
    sendSessionAffinityHeaders: true,
    supportsDeveloperRole: false,
  });

  const openai = buildModel(piFixture, "openai/acme-custom");
  expect(openai.compat).toBeUndefined();
});

test("registry compat keys win over the fireworks defaults", () => {
  const pi = {
    ...piFixture,
    getModel: () => ({
      id: "accounts/fireworks/models/kimi-k2p6",
      provider: "fireworks",
      api: "openai-completions",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      compat: { supportsDeveloperRole: true, supportsCacheControlOnTools: false },
    }),
  };

  const model = buildModel(pi, "fireworks/moonshotai/Kimi-K2.6");
  expect(model.compat).toEqual({
    sendSessionAffinityHeaders: true,
    supportsDeveloperRole: true,
    supportsCacheControlOnTools: false,
  });
});

test("Fireworks Kimi K3 applies DeepSeek thinking format, image input, and low/high/max efforts", () => {
  // Kimi K3 is not in the installed Pi registry under the fireworks provider,
  // so the routing backend must supply the DeepSeek thinking format (to parse
  // the reasoning_content field Fireworks returns) and the image input
  // modality (Fireworks supports image input for K3). K3 always reasons and
  // accepts only low/high/max, so no level may map to a disabled wire value.
  const kimiConfig: ResolvedRouterModelConfig = {
    provider: "fireworks",
    native_model_id: "accounts/fireworks/models/kimi-k3",
    api: "openai-completions",
    base_url: "https://api.fireworks.ai/inference/v1",
    context_window: 1_048_576,
    max_output_tokens: 131_072,
    supported_thinking_levels: ["low", "high", "max"],
    default_thinking_level: "max",
    supports_managed_key: true,
    cost: { input: 3, output: 15, cached_input: 0.3, cache_write: 0 },
  };

  const model = buildModel(piFixture, "moonshotai/Kimi-K3", null, kimiConfig);
  expect(model.compat).toMatchObject({
    sendSessionAffinityHeaders: true,
    supportsDeveloperRole: false,
    thinkingFormat: "deepseek",
    supportsReasoningEffort: true,
    requiresReasoningContentOnAssistantMessages: true,
  });
  expect(model.input).toEqual(["text", "image"]);
  expect(model.reasoning).toBe(true);
  expect(model.supportedThinkingLevels).toEqual(["low", "high", "max"]);
  expect(model.defaultThinkingLevel).toBe("max");
  // Unsupported levels must be nulled out, and "max" needs the explicit
  // provider-native spelling because Pi does not infer extended levels.
  expect(model.thinkingLevelMap).toMatchObject({
    off: null,
    minimal: null,
    medium: null,
    xhigh: null,
    max: "max",
  });
});

test("builds OpenRouter GLM 5.3 Flash with local multimodal metadata", () => {
  const config: ResolvedRouterModelConfig = {
    provider: "openrouter",
    native_model_id: "z-ai/glm-5.3-flash",
    api: "openai-completions",
    base_url: "https://openrouter.ai/api/v1",
    context_window: 1_048_576,
    max_output_tokens: 131_072,
    supported_thinking_levels: ["low", "high", "max"],
    default_thinking_level: "max",
    supports_managed_key: false,
    cost: { input: 0.075, output: 0.25, cached_input: 0.015, cache_write: 0 },
  };

  const model = buildModel(piFixture, "zai-org/GLM-5.3-Flash", null, config);

  expect(model).toMatchObject({
    id: "z-ai/glm-5.3-flash",
    provider: "openrouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    defaultThinkingLevel: "max",
    supportedThinkingLevels: ["low", "high", "max"],
    cost: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 },
  });
  expect(model.compat).toEqual({ thinkingFormat: "openrouter" });
  expect(model.thinkingLevelMap).toMatchObject({
    off: null,
    minimal: null,
    medium: null,
    xhigh: null,
    max: "max",
  });
});

test("model metadata lookup uses Pi registry levels and local overrides", async () => {
  const metadata = modelMetadataLookup({
    "openai/gpt-5.6-terra": {
      provider: "openai",
      native_model_id: "gpt-5.6-terra",
      api: "openai-responses",
      base_url: "https://api.openai.com/v1",
      context_window: 1_050_000,
      supported_thinking_levels: ["off", "low", "medium", "high", "xhigh", "max"],
      default_thinking_level: "medium",
      supports_managed_key: true,
      cost: { input: 2.5, output: 15, cached_input: 0.25, cache_write: 3.125 },
    },
    "anthropic/claude-fable-5": {
      provider: "anthropic",
      native_model_id: "claude-fable-5",
      api: "anthropic-messages",
      base_url: "https://api.anthropic.com",
      context_window: 1_000_000,
      supported_thinking_levels: ["low", "medium", "high", "xhigh", "max"],
      default_thinking_level: "high",
      supports_managed_key: true,
      cost: { input: 10, output: 50, cached_input: 1, cache_write: 12.5 },
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
      provider: "fireworks",
      native_model_id: "accounts/fireworks/models/deepseek-v4-pro",
      api: "openai-completions",
      base_url: "https://api.fireworks.ai/inference/v1",
      context_window: 1_000_000,
      supported_thinking_levels: ["off", "high", "max"],
      default_thinking_level: "high",
      supports_managed_key: true,
      cost: { input: 1.74, output: 3.48 },
    },
  });
  // Live Fireworks rejects reasoning_effort=minimal; the override drops it so
  // the router filters it before provider execution.
  expect(metadata("deepseek-ai/DeepSeek-V4-Pro-0813").supportedThinkingLevels).toEqual([
    "off",
    "high",
    "max",
  ]);
  expect(metadata("anthropic/claude-fable-5").supportedThinkingLevels).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  const terra = metadata("openai/gpt-5.6-terra");
  expect(terra.supportedThinkingLevels).toEqual([
    "off",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  expect(terra.model).toMatchObject({
    reasoning: true,
    defaultThinkingLevel: "medium",
    thinkingLevelMap: {
      minimal: null,
      xhigh: "xhigh",
      max: "max",
    },
  });
  const terraPiModel = terra.model as unknown as Parameters<
    typeof getPiSupportedThinkingLevels
  >[0];
  expect(getPiSupportedThinkingLevels(terraPiModel)).toEqual([
    "off",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  expect(clampThinkingLevel(terraPiModel, "max")).toBe("max");
});

test("builds Fireworks GLM 5.3 from resolved catalog metadata", () => {
  const config: ResolvedRouterModelConfig = {
    provider: "fireworks",
    native_model_id: "accounts/fireworks/models/glm-5p3",
    api: "openai-completions",
    base_url: "https://api.fireworks.ai/inference/v1",
    context_window: 1_048_576,
    max_output_tokens: 131_072,
    supported_thinking_levels: ["low", "high", "max"],
    default_thinking_level: "max",
    supports_managed_key: true,
    cost: { input: 1.4, output: 4.4, cached_input: 0.26, cache_write: 0 },
  };

  const model = buildModel(piFixture, "zai-org/GLM-5.3", null, config);

  expect(model).toMatchObject({
    id: "accounts/fireworks/models/glm-5p3",
    provider: "fireworks",
    api: "openai-completions",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    input: ["text"],
    reasoning: true,
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    defaultThinkingLevel: "max",
    supportedThinkingLevels: ["low", "high", "max"],
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    compat: {
      sendSessionAffinityHeaders: true,
      supportsDeveloperRole: false,
    },
  });
  expect(model.thinkingLevelMap).toMatchObject({
    off: null,
    minimal: null,
    medium: null,
    xhigh: null,
    max: "max",
  });
});

test("Fireworks GLM pricing and config metadata are available to routing", async () => {
  const config: ResolvedRouterModelConfig = {
    provider: "fireworks",
    native_model_id: "accounts/fireworks/models/glm-5p2",
    api: "openai-completions",
    base_url: "https://api.fireworks.ai/inference/v1",
    context_window: 1_048_575,
    supported_thinking_levels: ["off", "high", "max"],
    default_thinking_level: "max",
    supports_managed_key: true,
    cost: { input: 1.4, output: 4.4, cached_input: 0.14, cache_write: 0 },
  };

  const model = buildModel(piFixture, "zai-org/GLM-5.2", null, config);
  expect(model).toMatchObject({
    id: "accounts/fireworks/models/glm-5p2",
    provider: "fireworks",
    api: "openai-completions",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    contextWindow: 1_048_575,
    defaultThinkingLevel: "max",
    cost: { input: 1.4, output: 4.4, cacheRead: 0.14, cacheWrite: 0 },
  });

  const metadata = modelMetadataLookup({ "zai-org/GLM-5.2": config });
  expect(metadata("zai-org/GLM-5.2").model).toMatchObject({
    id: "accounts/fireworks/models/glm-5p2",
    provider: "fireworks",
    api: "openai-completions",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    contextWindow: 1_048_575,
    defaultThinkingLevel: "max",
  });
  expect(metadata("zai-org/GLM-5.2").supportedThinkingLevels).toEqual([
    "off",
    "high",
    "max",
  ]);
});

test("Fireworks DeepSeek pricing uses resolved catalog cache rates", async () => {
  const configs: Record<string, ResolvedRouterModelConfig> = {
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
      provider: "fireworks",
      native_model_id: "accounts/fireworks/models/deepseek-v4-pro",
      api: "openai-completions",
      base_url: "https://api.fireworks.ai/inference/v1",
      context_window: 1_000_000,
      supports_managed_key: true,
      cost: { input: 1.74, output: 3.48, cached_input: 0.145, cache_write: 0 },
    },
    "fireworks/deepseek-ai/DeepSeek-V4-Flash": {
      provider: "fireworks",
      native_model_id: "accounts/fireworks/models/deepseek-v4-flash",
      api: "openai-completions",
      base_url: "https://api.fireworks.ai/inference/v1",
      context_window: 1_000_000,
      supports_managed_key: true,
      cost: { input: 0.14, output: 0.28, cached_input: 0.03, cache_write: 0 },
    },
  };

  const pro = buildModel(
    piFixture,
    "deepseek-ai/DeepSeek-V4-Pro-0813",
    null,
    configs["deepseek-ai/DeepSeek-V4-Pro-0813"]
  );
  const flash = buildModel(
    piFixture,
    "fireworks/deepseek-ai/DeepSeek-V4-Flash",
    null,
    configs["fireworks/deepseek-ai/DeepSeek-V4-Flash"]
  );

  expect(pro.cost).toEqual({ input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 });
  expect(flash.cost).toEqual({ input: 0.14, output: 0.28, cacheRead: 0.03, cacheWrite: 0 });
});

const AZURE_DEEPSEEK_CONFIG: ResolvedRouterModelConfig = {
  provider: "azure",
  native_model_id: "DeepSeek-V4-Flash-0731",
  api: "openai-completions",
  base_url: "https://dari.services.ai.azure.com/openai/v1",
  context_window: 1_000_000,
  max_output_tokens: 384_000,
  supported_thinking_levels: ["off", "high", "max"],
  default_thinking_level: "high",
  supports_managed_key: false,
  cost: { input: 0.19, output: 0.51, cache_write: 0 },
};

test("DeepSeek on Azure drops the deepseek thinking format Fireworks needs", () => {
  // Foundry rejects the `thinking` parameter and takes plain reasoning_effort.
  const azure = buildModel(piFixture, "deepseek-ai/DeepSeek-V4-Flash-0731", null, AZURE_DEEPSEEK_CONFIG);
  expect(azure).toMatchObject({
    id: "DeepSeek-V4-Flash-0731",
    provider: "azure",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
  });
  expect(azure.compat).toEqual({
    supportsReasoningEffort: true,
    requiresReasoningContentOnAssistantMessages: true,
  });

  const fireworks = buildModel(piFixture, "deepseek-ai/DeepSeek-V4-Flash-0731", null, {
    ...AZURE_DEEPSEEK_CONFIG,
    provider: "fireworks",
    native_model_id: "accounts/fireworks/models/deepseek-v4-flash-0731",
    base_url: "https://api.fireworks.ai/inference/v1",
  });
  expect(fireworks.compat).toMatchObject({ thinkingFormat: "deepseek", supportsReasoningEffort: true });
});

test("Grok on Azure keeps image input and sends reasoning_effort over chat completions", () => {
  const model = buildModel(piFixture, "xai/grok-4.6", null, {
    provider: "azure",
    native_model_id: "grok-4.6",
    api: "openai-completions",
    base_url: "https://dari.services.ai.azure.com/openai/v1",
    context_window: 200_000,
    max_output_tokens: 128_000,
    supported_thinking_levels: ["low", "medium", "high", "xhigh"],
    default_thinking_level: "high",
    supports_managed_key: false,
    cost: { input: 2, output: 6, cached_input: 0.5, cache_write: 0 },
  });
  expect(model).toMatchObject({
    id: "grok-4.6",
    provider: "azure",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    compat: { supportsReasoningEffort: true },
  });
});

test("Grok 4.7 on Azure keeps image input and sends reasoning_effort over chat completions", () => {
  const model = buildModel(piFixture, "xai/grok-4.7", null, {
    provider: "azure",
    native_model_id: "grok-4.7",
    api: "openai-completions",
    base_url: "https://dari.services.ai.azure.com/openai/v1",
    context_window: 200_000,
    max_output_tokens: 128_000,
    supported_thinking_levels: ["low", "medium", "high", "xhigh"],
    default_thinking_level: "high",
    supports_managed_key: false,
    cost: { input: 2, output: 6, cached_input: 0.5, cache_write: 0 },
  });
  expect(model).toMatchObject({
    id: "grok-4.7",
    provider: "azure",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    compat: { supportsReasoningEffort: true },
  });
});
