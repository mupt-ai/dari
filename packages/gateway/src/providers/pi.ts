import {
  getSupportedThinkingLevels,
  normalizeContext,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderStreams,
} from "@mupt-ai/pi-ai";
import { anthropicMessagesApi } from "@mupt-ai/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@mupt-ai/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@mupt-ai/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@mupt-ai/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@mupt-ai/pi-ai/api/google-vertex.lazy";
import { mistralConversationsApi } from "@mupt-ai/pi-ai/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "@mupt-ai/pi-ai/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "@mupt-ai/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@mupt-ai/pi-ai/api/openai-responses.lazy";
import { getBuiltinModel } from "@mupt-ai/pi-ai/providers/all";
import {
  REASONING_EFFORTS,
  isRecord,
  nativeModelId,
  providerForModel,
  type ModelPricing,
  type ReasoningEffort,
  type RouterModelPrice,
} from "@mupt-ai/dari-router/policy-engine";
import { HttpError } from "../http/errors.js";
import { effectiveContextWindow } from "../models/context_limits.js";
import { defaultBaseUrl } from "../models/provider_defaults.js";
import {
  contextWindowOverride,
  inputModalitiesOverride,
  providerThinkingLevelOverrides,
  runtimeCompat,
  withThinkingLevelOverrides,
} from "../models/runtime_overrides.js";
import { BEDROCK_API } from "./model_capabilities.js";
import { buildContext } from "./pi_context.js";
import { providerIdentityFromModel } from "../interaction/provider_continuation_state.js";
import { buildOptions, supportedThinkingLevels } from "./pi_options.js";
import type { ProviderFetch } from "./response_capture.js";
import {
  eventsWithSafeguardResults,
  forwardsAnthropicSafeguards,
  messageWithSafeguardResults,
  safeguardResultsTap,
} from "./anthropic_safeguards.js";
import {
  eventsWithProviderReportedCost,
  messageWithProviderReportedCost,
  providerReportedCostTap,
  reportsProviderCost,
} from "./provider_reported_cost.js";
import {
  eventsWithSubscriptionCacheWrites,
  messageWithSubscriptionCacheWrites,
  modelPricingFromPiModel,
  type SubscriptionUsageContext,
} from "./subscription_usage.js";
import type { InteractionRequest, ProviderIdentity } from "../interaction/types.js";
import type { ResolvedProviderAuth, ResolvedRouterModelConfig } from "../types.js";

type PiAi = {
  completeSimple: (model: Record<string, unknown>, context: Record<string, unknown>, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  streamSimple: (model: Record<string, unknown>, context: Record<string, unknown>, options: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>;
  getModel?: (provider: string, id: string) => Record<string, unknown> | undefined;
  getSupportedThinkingLevels?: (model: Record<string, unknown>) => string[];
};

export type ModelRuntimeMetadata = {
  model: Record<string, unknown>;
  supportedThinkingLevels: string[];
};

// A platform-supplied endpoint for one call (see ProviderCredential).
export type ProviderEndpoint = {
  baseUrl?: string;
  headers?: Record<string, string>;
};

export type ProviderCompletion = {
  message: Record<string, unknown>;
  source: ProviderIdentity;
};

export type ProviderEventStream = {
  events: AsyncIterable<Record<string, unknown>>;
  source: ProviderIdentity;
};

export type ModelMetadataLookup = (modelId: string, pricing?: ModelPricing | null) => ModelRuntimeMetadata;

// Pi's built-in providers stream through these API implementations unchanged.
// Dari always passes resolved credentials, so it dispatches on the API rather
// than through a Models collection with its own auth resolution.
const PI_APIS: Record<string, ProviderStreams> = {
  "anthropic-messages": anthropicMessagesApi(),
  "azure-openai-responses": azureOpenAIResponsesApi(),
  "bedrock-converse-stream": bedrockConverseStreamApi(),
  "google-generative-ai": googleGenerativeAIApi(),
  "google-vertex": googleVertexApi(),
  "mistral-conversations": mistralConversationsApi(),
  "openai-codex-responses": openAICodexResponsesApi(),
  "openai-completions": openAICompletionsApi(),
  "openai-responses": openAIResponsesApi(),
};

function piStreamSimple(
  model: Record<string, unknown>,
  context: Record<string, unknown>,
  options: Record<string, unknown>,
): AssistantMessageEventStream {
  const api = PI_APIS[String(model.api)];
  if (!api) throw new Error(`No Pi API implementation for ${String(model.api)}.`);
  return api.streamSimple(model as unknown as Model<Api>, normalizeContext(context as unknown as Context), options);
}

export const pi: PiAi = {
  completeSimple: async (model, context, options) =>
    await piStreamSimple(model, context, options).result() as unknown as Record<string, unknown>,
  streamSimple: (model, context, options) =>
    piStreamSimple(model, context, options) as unknown as AsyncIterable<Record<string, unknown>>,
  getModel: (provider, id) => getBuiltinModel(provider as never, id as never) as unknown as Record<string, unknown> | undefined,
  getSupportedThinkingLevels: (model) => getSupportedThinkingLevels(model as unknown as Model<Api>),
};

export async function completeInteractionModel(args: {
  model: string;
  request: InteractionRequest;
  apiKey: string;
  auth?: ResolvedProviderAuth;
  pricing?: ModelPricing | null;
  config?: ResolvedRouterModelConfig;
  endpoint?: ProviderEndpoint;
  sessionId?: string;
  selectedReasoningEffort?: ReasoningEffort;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: ProviderFetch;
}): Promise<ProviderCompletion> {
  const model = modelAtEndpoint(buildModel(pi, args.model, args.pricing, args.config), args.endpoint);
  const source = providerIdentityFromModel(model);
  const context = buildContext(args.request, source);
  const costTap = reportsProviderCost(model) ? providerReportedCostTap(args.fetch) : undefined;
  const safeguards = forwardsAnthropicSafeguards(args.request, model)
    ? safeguardResultsTap(costTap?.fetch ?? args.fetch)
    : undefined;
  const options = buildOptions(
    args.request,
    args.auth ?? args.apiKey,
    args.model,
    model,
    pi,
    args.sessionId,
    args.selectedReasoningEffort,
    args.timeoutMs,
    args.signal,
    safeguards?.fetch ?? costTap?.fetch ?? args.fetch,
  );
  const usageContext = subscriptionUsageContext(args.model, model, source);
  const message = options.emitProviderEvents === true
    ? await completeProviderEventStream(pi.streamSimple(model, context, options))
    : await pi.completeSimple(model, context, options);
  return {
    message: messageWithProviderReportedCost(
      messageWithSubscriptionCacheWrites(
        messageWithSafeguardResults(message, safeguards?.results()),
        usageContext
      ),
      costTap?.cost(),
    ),
    source,
  };
}

function subscriptionUsageContext(
  modelId: string,
  model: Record<string, unknown>,
  source: ProviderIdentity
): SubscriptionUsageContext {
  // pi-ai priced this call from model.cost, so the repricing must read it back
  // rather than the caller's catalog pricing, which fast mode can override.
  return { api: source.api, model: modelId, pricing: modelPricingFromPiModel(model) };
}

export async function completeProviderEventStream(
  events: AsyncIterable<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  let providerResponse: Record<string, unknown> | undefined;
  const providerOutput = new Map<number, Record<string, unknown>>();
  for await (const event of events) {
    if (event.type === "provider_event" && isRecord(event.event)) {
      const raw = event.event;
      if (raw.type === "response.output_item.done" && isRecord(raw.item)) {
        const outputIndex = raw.output_index;
        if (typeof outputIndex !== "number" || !Number.isInteger(outputIndex) || outputIndex < 0) {
          throw new Error("Provider output item is missing a valid output index.");
        }
        providerOutput.set(outputIndex, raw.item);
      }
      if (
        (raw.type === "response.completed" || raw.type === "response.incomplete") &&
        isRecord(raw.response)
      ) {
        providerResponse = raw.response;
      }
      continue;
    }
    if (event.type === "done" && isRecord(event.message)) {
      if (providerResponse) {
        const terminalOutput = providerResponse.output;
        if ((!Array.isArray(terminalOutput) || terminalOutput.length === 0) && providerOutput.size > 0) {
          const entries = [...providerOutput.entries()].sort(([left], [right]) => left - right);
          if (entries.some(([index], position) => index !== position)) {
            throw new Error("Provider stream ended with non-contiguous output item indexes.");
          }
          providerResponse = { ...providerResponse, output: entries.map(([, item]) => item) };
        }
        return { ...event.message, providerResponse };
      }
      return event.message;
    }
    if (event.type === "error" && isRecord(event.error)) return event.error;
  }
  throw new Error("Provider stream ended without a terminal event.");
}

export async function streamInteractionModel(args: {
  model: string;
  request: InteractionRequest;
  apiKey: string;
  auth?: ResolvedProviderAuth;
  pricing?: ModelPricing | null;
  config?: ResolvedRouterModelConfig;
  endpoint?: ProviderEndpoint;
  sessionId?: string;
  selectedReasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  fetch?: ProviderFetch;
}): Promise<ProviderEventStream> {
  const model = modelAtEndpoint(buildModel(pi, args.model, args.pricing, args.config), args.endpoint);
  const source = providerIdentityFromModel(model);
  const costTap = reportsProviderCost(model) ? providerReportedCostTap(args.fetch) : undefined;
  const safeguards = forwardsAnthropicSafeguards(args.request, model)
    ? safeguardResultsTap(costTap?.fetch ?? args.fetch)
    : undefined;
  const events = pi.streamSimple(
    model,
    buildContext(args.request, source),
    buildOptions(
      args.request,
      args.auth ?? args.apiKey,
      args.model,
      model,
      pi,
      args.sessionId,
      args.selectedReasoningEffort,
      undefined,
      args.signal,
      safeguards?.fetch ?? costTap?.fetch ?? args.fetch,
    )
  );
  const withCacheWrites = eventsWithSubscriptionCacheWrites(
    safeguards ? eventsWithSafeguardResults(events, safeguards) : events,
    subscriptionUsageContext(args.model, model, source)
  );
  return {
    events: costTap ? eventsWithProviderReportedCost(withCacheWrites, costTap) : withCacheWrites,
    source,
  };
}

function modelAtEndpoint(
  model: Record<string, unknown>,
  endpoint: ProviderEndpoint | undefined,
): Record<string, unknown> {
  if (endpoint === undefined) return model;
  return {
    ...model,
    ...(endpoint.baseUrl ? { baseUrl: endpoint.baseUrl } : {}),
    ...(endpoint.headers
      ? { headers: { ...(isRecord(model.headers) ? model.headers : {}), ...endpoint.headers } }
      : {}),
  };
}

export function modelContextWindow(modelId: string): number | null {
  const provider = providerForModel(modelId);
  const nativeId = nativeModelId(modelId);
  const registered = resolveModelMetadata(pi, provider, modelId, nativeId);
  return contextWindowForModel(modelId, registered);
}

/**
 * Pi's catalog price for a canonical model served by `provider`, in USD per
 * million tokens. Null when Pi does not list the model.
 */
export function registeredModelPrice(
  modelId: string,
  provider: string = providerForModel(modelId),
): RouterModelPrice | null {
  const registered = resolveModelMetadata(pi, provider, modelId, nativeModelId(modelId));
  const cost = registered?.cost;
  if (!isRecord(cost) || typeof cost.input !== "number" || typeof cost.output !== "number") {
    return null;
  }
  return {
    input: cost.input,
    output: cost.output,
    cached_input: typeof cost.cacheRead === "number" ? cost.cacheRead : null,
    cache_write: typeof cost.cacheWrite === "number" ? cost.cacheWrite : null,
  };
}

export function modelMetadataLookup(
  configs?: Record<string, ResolvedRouterModelConfig>
): ModelMetadataLookup {
  return (modelId: string, pricing?: ModelPricing | null) => {
    const model = buildModel(pi, modelId, pricing, configs?.[modelId]);
    return {
      model,
      supportedThinkingLevels: supportedThinkingLevels(model, pi),
    };
  };
}

export function buildModel(
  pi: PiAi,
  modelId: string,
  pricing?: ModelPricing | null,
  config?: ResolvedRouterModelConfig
): Record<string, unknown> {
  const provider = config?.provider ?? providerForModel(modelId);
  const nativeId = config?.native_model_id ?? nativeModelId(modelId);
  const registered = resolveModelMetadata(pi, provider, modelId, nativeId);
  const id = registered?.id ?? (provider === "anthropic" ? nativeId.replace(/(?<=\d)\.(?=\d)/g, "-") : nativeId);
  const price = executionPricing(pricing, config);
  const configuredThinkingLevels = config?.supported_thinking_levels;
  // A null catalog value delegates to Pi's registry when it knows the model.
  // Custom OpenAI-compatible models are not necessarily registered, so keep
  // the public effort set permissive and let the provider validate the wire
  // value instead of silently treating an unknown model as off-only. A
  // built-in provider with its own thinking levels (Meta) serves ids newer
  // than the registry the same way, with only its key configured.
  const providerThinking = providerThinkingLevelOverrides(provider);
  const fallbackThinkingLevels =
    (config !== undefined || providerThinking !== undefined) &&
    configuredThinkingLevels == null &&
    registered === undefined
      ? REASONING_EFFORTS
      : undefined;
  const effectiveThinkingLevels = Array.isArray(configuredThinkingLevels)
    ? configuredThinkingLevels
    : fallbackThinkingLevels;
  const configuredThinking = effectiveThinkingLevels
    ? thinkingMetadata(effectiveThinkingLevels, registered ?? { thinkingLevelMap: providerThinking })
    : null;
  const defaultThinkingLevel = config?.default_thinking_level ?? undefined;
  const api = config?.api ?? registered?.api ?? defaultApi(provider);
  const baseUrl = config?.base_url ?? registered?.baseUrl ?? defaultBaseUrl(provider);
  if (!baseUrl) {
    throw new HttpError(502, `No base URL is configured for provider ${provider}.`, "provider_configuration_error");
  }
  const contextWindow = contextWindowForModel(modelId, registered, config) ?? 128000;
  const compat = responsesToolContract(api, runtimeCompat(provider, registered, modelId));
  return {
    ...(registered ?? {}),
    ...(compat !== undefined ? { compat } : {}),
    id,
    name: registered?.name ?? id,
    provider,
    api,
    baseUrl,
    reasoning: configuredThinking?.reasoning ?? registered?.reasoning ?? false,
    input: registered?.input ?? inputModalitiesOverride(modelId) ?? ["text"],
    cost: price ?? registered?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: config?.max_output_tokens ?? registered?.maxTokens ?? contextWindow,
    ...(defaultThinkingLevel !== undefined ? { defaultThinkingLevel } : {}),
    ...(configuredThinking ? { thinkingLevelMap: configuredThinking.thinkingLevelMap } : {}),
    ...(effectiveThinkingLevels
      ? { supportedThinkingLevels: [...effectiveThinkingLevels] }
      : {}),
    fastMode: config?.fast_mode ?? false,
    zeroDataRetention: config?.zdr ?? false,
  };
}

function thinkingMetadata(
  supportedLevels: readonly ReasoningEffort[],
  registered: Record<string, unknown> | undefined
): { reasoning: boolean; thinkingLevelMap: Record<string, string | null> } {
  const supported = new Set(supportedLevels);
  const registeredMap = isRecord(registered?.thinkingLevelMap)
    ? registered.thinkingLevelMap
    : {};
  const thinkingLevelMap: Record<string, string | null> = {};

  for (const level of REASONING_EFFORTS) {
    if (!supported.has(level)) {
      thinkingLevelMap[level] = null;
      continue;
    }
    const registeredValue = registeredMap[level];
    if (typeof registeredValue === "string") {
      thinkingLevelMap[level] = registeredValue;
    } else if (level === "xhigh" || level === "max") {
      // Pi requires extended levels to be explicitly mapped. The catalog
      // levels use the provider-native OpenAI spelling.
      thinkingLevelMap[level] = level;
    }
  }

  return {
    reasoning: supportedLevels.some((level) => level !== "off"),
    thinkingLevelMap,
  };
}

function resolveModelMetadata(
  pi: PiAi,
  provider: string,
  modelId: string,
  nativeId: string
): Record<string, unknown> | undefined {
  const registry = registryProvider(provider, modelId);
  return withThinkingLevelOverrides(
    provider,
    pi.getModel?.(registry, nativeId) ?? pi.getModel?.(registry, modelId),
  );
}

// Dari's "azure" provider has no Pi registry of its own. One Foundry resource
// serves OpenAI deployments through Pi's Azure OpenAI Responses registry and
// Claude deployments through the Anthropic registry, whose model metadata
// (input modalities, adaptive-thinking compat, thinking level maps) is the
// same on Foundry; the resolved config still owns api, base URL, and cost.
function registryProvider(provider: string, modelId: string): string {
  if (provider !== "azure") return provider;
  return providerForModel(modelId) === "anthropic" ? "anthropic" : "azure-openai-responses";
}

function contextWindowForModel(
  modelId: string,
  registered: Record<string, unknown> | undefined,
  config?: ResolvedRouterModelConfig
): number | null {
  const registeredWindow = typeof registered?.contextWindow === "number" ? registered.contextWindow : null;
  const configWindow = effectiveContextWindow(config, config?.allow_long_context === true);
  const override = contextWindowOverride(modelId);
  const configured = configWindow ?? registeredWindow;
  if (configWindow !== null || override === undefined) return configured;
  return Math.max(configured ?? 0, override);
}

// Pi 1.4 sends Responses tool definitions as conversation items, not the request's
// `tools` field, when a model supports mid-conversation system messages. The gateway
// keeps tools at the request level until that native tool-change path is validated.
const RESPONSES_APIS: ReadonlySet<string> = new Set(["openai-responses", "azure-openai-responses", "openai-codex-responses"]);

function responsesToolContract(api: unknown, compat: unknown): unknown {
  if (typeof api !== "string" || !RESPONSES_APIS.has(api)) return compat;
  if (!isRecord(compat) || compat.supportsMidConvoSystemMessages !== true) return compat;
  return { ...compat, supportsMidConvoSystemMessages: false };
}

function modelPricingFromConfig(config: ResolvedRouterModelConfig | undefined): ModelPricing | null {
  const configuredCost =
    config?.fast_mode && config.provider === "anthropic" && config.fast_mode_cost
      ? config.fast_mode_cost
      : config?.cost;
  if (!configuredCost || typeof configuredCost.input !== "number" || typeof configuredCost.output !== "number") return null;
  return {
    input: configuredCost.input,
    output: configuredCost.output,
    cacheRead: configuredCost.cached_input ?? configuredCost.input,
    cacheWrite: configuredCost.cache_write ?? configuredCost.input,
    ...(configuredCost.tiers?.length ? { tiers: configuredCost.tiers.map((tier) => ({
      inputTokensAbove: tier.input_tokens_above,
      input: tier.input,
      output: tier.output,
      cacheRead: tier.cached_input ?? tier.input,
      cacheWrite: tier.cache_write ?? tier.input,
    })) } : {}),
  };
}

function executionPricing(
  pricing: ModelPricing | null | undefined,
  config: ResolvedRouterModelConfig | undefined
): ModelPricing | null {
  if (
    config?.fast_mode &&
    config.provider === "openai" &&
    config.api === "openai-responses"
  ) {
    // The platform publishes fast prices for routing decisions and the UI,
    // while Pi multiplies the standard rates using the service tier actually
    // returned by OpenAI. Feeding Pi premium rates here would charge twice.
    return modelPricingFromConfig({ ...config, fast_mode: false });
  }
  return pricing ?? modelPricingFromConfig(config);
}

function defaultApi(provider: string): string {
  // Meta recommends Responses: its Chat Completions drops reasoning between turns.
  if (provider === "openai" || provider === "xai" || provider === "meta") return "openai-responses";
  if (provider === "anthropic") return "anthropic-messages";
  if (provider === "amazon-bedrock") return BEDROCK_API;
  if (provider === "azure") return "azure-openai-responses";
  return "openai-completions";
}
