import {
  prepareCandidates,
  type ActiveLease,
  type PendingLease,
  type CandidateCostEstimate,
  type CandidateModelMetadata,
  type ChainHits,
  type PrefixHit,
  type ChatMessage,
  type HardCapability,
  type PreviousDecision,
  type PricingLookup,
  isReasoningEffort,
  type ReasoningEffort,
  type SelectorLeaseHistoryEntry,
  type StrategyCandidateResolution,
} from "@mupt-ai/dari-router/policy-engine";
import { randomUUID } from "node:crypto";

import { HttpError } from "../http/errors.js";
import { effectiveContextWindow } from "../models/context_limits.js";
import { keySourceForModel } from "../models/execution_provider.js";
import { requestHasDocument, requiredCapabilitiesFor } from "../interaction/capabilities.js";
import { providerIdentityFromModel } from "../interaction/provider_continuation_state.js";
import { isBackgroundRequest, type InteractionRequest, type ProviderIdentity } from "../interaction/types.js";
import { requireCandidateModels } from "../models/ids.js";
import { explicitModelId } from "../protocol/input/router_model.js";
import { modelMetadataLookup } from "../providers/pi.js";
import {
  modelSupportsDocumentInput,
  modelSupportsImageInput,
  modelSupportsHostedWebSearch,
  modelSupportsReasoningConfigurationUpdate,
  providerApiCanSerializeResponseFormat,
} from "../providers/model_capabilities.js";
import {
  selectorMessagesForInteraction,
  type SelectorImage,
} from "../strategies/selector_projection.js";
import type { ResolvedRouter } from "../types.js";
import {
  interactionPrefixContext,
  interactionPrefixLookupHashes,
  type InteractionPrefixContext,
} from "./interaction_fingerprint.js";
import { pricingLookupForRouter } from "./pricing.js";
import { providerPromptAccounting } from "./provider_prompt_accounting.js";
import { leaseHistoryFromPrefixHits } from "./lease_history.js";
import { interactionLeaseFenceDepth } from "./interaction_lease_depth.js";

export type ImageCapabilityPrunedModel = {
  model: string;
  reason: "image_input_unsupported";
};

export type RoutingContext = {
  // Target-independent request depth used only to fence asynchronous lease
  // writes. Provider cache lookback uses providerBlockDepthFor instead.
  leaseDepth: number;
  hits: ChainHits;
  reportingCostEstimates: CandidateCostEstimate[];
  previousDecision?: PreviousDecision;
  // Unexpired lease commitment recovered from this conversation's prefix
  // chain; the runtime serves it without consulting the selector.
  activeLease?: ActiveLease;
  // Next lease prefetched before expiry; adopted when no lease is active.
  pendingLease?: PendingLease;
  pricing: PricingLookup;
  conversationId: string;
  isNewConversation: boolean;
  // Depth of the identity hit that recovered the conversation id (strict or
  // loose tier, warm or merely recent); null for a fresh conversation.
  identityMatchDepth: number | null;
  identityHit?: PrefixHit;
  zdr: boolean;
  candidateResolution: StrategyCandidateResolution;
  // Models excluded before strategy resolution because the pending request
  // carries image content they cannot accept; absent when nothing was pruned.
  imageCapabilityPrunedModels?: ImageCapabilityPrunedModel[];
  prefix: InteractionPrefixContext;
  targetsByModel: ReadonlyMap<string, ProviderIdentity>;
  selectorMessages: ChatMessage[];
  // Images referenced by `<image N>` placeholders in selectorMessages; empty
  // unless the router opted into selector image input.
  selectorImages: SelectorImage[];
  // Absent when the router has lease context disabled: no reconstruction runs
  // and downstream selector inputs must stay in the pre-lease-context shape.
  leaseHistory?: SelectorLeaseHistoryEntry[];
  providerBlockDepthFor: (model: string) => number;
};

// Router resolution only needs lookup hashes. Model-specific chains are
// derived after resolve, when the enabled providers and APIs are known.
export function derivePrefixLookupHashes(
  routerId: string,
  interaction: InteractionRequest,
): string[] {
  try {
    return interactionPrefixLookupHashes(routerId, interaction);
  } catch (error) {
    console.error("prefix fingerprinting failed", error);
    return [];
  }
}

export async function buildRoutingContext(args: {
  routerId: string;
  interaction: InteractionRequest;
  credentials: ResolvedRouter;
  previousDecision?: PreviousDecision;
  explicitConversationId?: string;
  // Warmth freshness is measured from request arrival; callers without a
  // request clock (experiments) default to now.
  receivedAt?: Date;
}): Promise<RoutingContext> {
  const configuredCandidateModels = requireCandidateModels(
    args.credentials.enabled_models,
  );
  // With credits exhausted, route only among models a personal subscription
  // serves. The credit gate refuses routers with none.
  const fundedCandidateModels = args.credentials.credit_exhausted
    ? configuredCandidateModels.filter((model) => keySourceForModel(args.credentials, model) === "subscription")
    : configuredCandidateModels;
  const { messages: selectorMessages, images: selectorImages } =
    selectorMessagesForInteraction(args.interaction, {
      imageInput: args.credentials.selector_image_input_enabled === true,
    });
  const leaseDepth = interactionLeaseFenceDepth(args.interaction);
  const metadataLookup = modelMetadataLookup(args.credentials.model_configs);
  const targetsByModel = new Map<string, ProviderIdentity>();
  for (const model of configuredCandidateModels) {
    targetsByModel.set(
      model,
      providerIdentityFromModel(metadataLookup(model).model),
    );
  }
  const capabilityLookup = (modelId: string): CandidateModelMetadata => {
    const metadata = metadataLookup(modelId);
    return {
      provider: typeof metadata.model.provider === "string" ? metadata.model.provider : "",
      api: typeof metadata.model.api === "string" ? metadata.model.api : "",
      supportsImageInput: modelSupportsImageInput(metadata),
      supportsHostedWebSearch: modelSupportsHostedWebSearch(metadata),
      supportsReasoningConfigurationUpdate: modelSupportsReasoningConfigurationUpdate(metadata),
      supportsStructuredOutput: providerApiCanSerializeResponseFormat(metadata),
      supportedThinkingLevels: metadata.supportedThinkingLevels,
    };
  };
  // Image capability filtering (router setting, absent = ON) narrows the
  // candidate set before strategy resolution — an image-bearing conversation
  // must not route (or hold a lease) to a text-only model. Prefix chains and
  // provider accounting still cover every configured model.
  const imageFilter = resolveImageCapableCandidates({
    candidateModels: fundedCandidateModels.length > 0 ? fundedCandidateModels : configuredCandidateModels,
    requiredCapabilities: requiredCapabilitiesFor(args.interaction),
    enabled: args.credentials.image_capability_filtering !== false,
    supportsImageInput: (model) => capabilityLookup(model).supportsImageInput,
  });
  const documentCapableModels = documentCapableCandidates(
    imageFilter.candidateModels,
    requestHasDocument(args.interaction),
    (model) => modelSupportsDocumentInput(model, metadataLookup(model)),
  );
  const prefix = derivePrefixContext({
    routerId: args.routerId,
    interaction: args.interaction,
    targetsByModel,
  });
  const promptAccounting = providerPromptAccounting({
    request: args.interaction,
    prefix,
    targetsByModel,
  });
  const pricing = pricingLookupForRouter(args.credentials);
  // A validated harness identity is authoritative. Matching text from another
  // thread must not contribute cache warmth or selector continuity.
  const background = isBackgroundRequest(args.interaction);
  const prefixHits = (background ? [] : args.credentials.prefix_hits ?? []).filter(
    (hit) => args.explicitConversationId === undefined
      || hit.conversation_id === args.explicitConversationId,
  );
  const prepared = prepareCandidates({
    candidateModels: documentCapableModels,
    metadataLookup: capabilityLookup,
    requiredCapabilities: imageFilter.requiredCapabilities,
    requestedReasoningEffort: args.interaction.reasoning?.effort,
    thinkingEnabled: args.interaction.reasoning?.enabled === true,
    toolChoice: args.interaction.toolChoice,
    modelThinkingLevels: args.credentials.model_thinking_levels,
    strategy: args.credentials.routing_strategy === "custom" ? "custom" : "dari",
    customConfig: args.credentials.custom_config,
    modelPrices: args.credentials.model_prices ?? {},
    pricing,
    promptTokenLimitFor: (model) => effectiveContextWindow(
      args.credentials.model_configs?.[model],
      args.credentials.allow_long_context === true,
    ),
    requiresPromptEstimateFor: (model) => args.credentials.allow_long_context !== true
      && args.credentials.model_configs?.[model]?.standard_context_limit != null,
    averageOutputTokensByModel: Object.fromEntries(
      Object.entries(args.credentials.model_configs ?? {}).map(([model, config]) => [
        model,
        config.average_output_tokens ?? null,
      ]),
    ),
    promptAccounting,
    chainsByModel: prefix.chainByModel,
    // Resolve returns hits up to the platform's conversation lookback;
    // core narrows them to the warmth window for cost estimation and keeps the
    // rest for conversation identity and the previous decision.
    prefixHits,
    nowMs: (args.receivedAt ?? new Date()).getTime(),
    looseChain: prefix.looseChain,
    conversationId: args.explicitConversationId,
    toolChoiceFp: prefix.fingerprints.tool_choice_fp,
    responseFormatFp: prefix.fingerprints.response_format_fp,
    previousDecision: background ? undefined : args.previousDecision,
  });
  for (const warning of prepared.warnings) {
    console.error("cache cost estimation failed", warning.error);
  }

  const conversationId = args.explicitConversationId
    ?? prepared.conversationId
    ?? randomUUID();
  // A harness identity always produces an explicit conversation id, so it
  // cannot distinguish a brand-new session from a recovered one on its own.
  // Prefix lookup is already scoped to that id; no recovered conversation
  // therefore means this is its first observed turn.
  const isNewConversation = prepared.conversationId === null;
  // Lease context (router setting, absent = ON) feeds the selector the
  // original task and reconstructed lease history. Disabled routers skip the
  // reconstruction entirely so their selector inputs stay byte-identical to
  // the pre-lease-context behavior.
  const leaseHistory = !background && args.credentials.lease_context_enabled !== false
    ? leaseHistoryFromPrefixHits({
        prefixHits,
        conversationId,
        candidates: prepared.candidateResolution.candidates,
        messages: selectorMessages,
      })
    : undefined;
  return {
    leaseDepth,
    hits: prepared.hits,
    reportingCostEstimates: prepared.costEstimates,
    ...(prepared.previousDecision !== undefined
      ? { previousDecision: prepared.previousDecision }
      : {}),
    ...(prepared.activeLease !== undefined ? { activeLease: prepared.activeLease } : {}),
    ...(prepared.pendingLease !== undefined ? { pendingLease: prepared.pendingLease } : {}),
    pricing,
    conversationId,
    isNewConversation,
    identityMatchDepth: prepared.identityMatchDepth,
    ...(prepared.identityHit !== undefined
      ? { identityHit: prepared.identityHit }
      : {}),
    zdr: args.credentials.zdr === true,
    candidateResolution: prepared.candidateResolution,
    ...(imageFilter.prunedModels.length > 0
      ? { imageCapabilityPrunedModels: imageFilter.prunedModels }
      : {}),
    prefix,
    targetsByModel,
    selectorMessages,
    selectorImages,
    ...(leaseHistory !== undefined ? { leaseHistory } : {}),
    providerBlockDepthFor: promptAccounting.providerBlockDepthFor,
  };
}

// When the filter is disabled, "image_input" is also dropped from the hard
// capabilities so core preparation keeps today's pass-through behavior instead
// of re-applying the same exclusion. When enabled, the capability stays as a
// core-side invariant over the already-narrowed set.
function resolveImageCapableCandidates(args: {
  candidateModels: string[];
  requiredCapabilities: HardCapability[];
  enabled: boolean;
  supportsImageInput: (model: string) => boolean;
}): {
  candidateModels: string[];
  requiredCapabilities: HardCapability[];
  prunedModels: ImageCapabilityPrunedModel[];
} {
  if (!args.requiredCapabilities.includes("image_input")) {
    return {
      candidateModels: args.candidateModels,
      requiredCapabilities: args.requiredCapabilities,
      prunedModels: [],
    };
  }
  if (!args.enabled) {
    return {
      candidateModels: args.candidateModels,
      requiredCapabilities: args.requiredCapabilities.filter(
        (capability) => capability !== "image_input",
      ),
      prunedModels: [],
    };
  }
  const capable = args.candidateModels.filter(args.supportsImageInput);
  if (capable.length === 0) {
    throw new HttpError(
      400,
      "This conversation contains image input, but no enabled model on this router accepts images.",
      "no_image_capable_candidates",
    );
  }
  return {
    candidateModels: capable,
    requiredCapabilities: args.requiredCapabilities,
    prunedModels: args.candidateModels
      .filter((model) => !args.supportsImageInput(model))
      .map((model) => ({ model, reason: "image_input_unsupported" as const })),
  };
}

// A PDF can only be sent natively, so a conversation carrying one must not
// route (or hold a lease) to a model that cannot read it.
function documentCapableCandidates(
  candidateModels: string[],
  hasDocument: boolean,
  supportsDocumentInput: (model: string) => boolean,
): string[] {
  if (!hasDocument) return candidateModels;
  const capable = candidateModels.filter(supportsDocumentInput);
  if (capable.length === 0) {
    throw new HttpError(
      400,
      "This conversation contains a PDF document, but no enabled model on this router accepts PDF input.",
      "no_document_capable_candidates",
    );
  }
  return capable;
}

function derivePrefixContext(args: {
  routerId: string;
  interaction: InteractionRequest;
  targetsByModel: ReadonlyMap<string, ProviderIdentity>;
}): InteractionPrefixContext {
  try {
    return interactionPrefixContext(
      args.routerId,
      args.interaction,
      args.targetsByModel,
    );
  } catch (error) {
    console.error("prefix fingerprinting failed", error);
    return {
      chainByModel: new Map(
        [...args.targetsByModel].map(([model]) => [model, []]),
      ),
      itemIndexByHashByModel: new Map(
        [...args.targetsByModel].map(
          ([model]) => [model, new Map<string, number>()],
        ),
      ),
      looseChain: [],
      fingerprints: { tool_choice_fp: "", response_format_fp: "" },
    };
  }
}

// An explicit `dari/model/<id>` serves the requested thinking level when the
// model offers it and otherwise its default level, so the request itself drops
// an unsupported level before routing and provider validation see it. A strict
// router never substitutes, so it keeps the level and fails on it.
export function clampRequestedEffort(
  interaction: InteractionRequest,
  credentials: { strict?: boolean; model_thinking_levels?: Record<string, ReasoningEffort[]> },
  metadataLookup: ReturnType<typeof modelMetadataLookup>,
): InteractionRequest {
  const requested = interaction.reasoning?.effort;
  const modelId = explicitModelId(interaction.model);
  if (requested === undefined || modelId === null || credentials.strict === true) return interaction;
  const supported = metadataLookup(modelId).supportedThinkingLevels.filter(isReasoningEffort);
  const configured = credentials.model_thinking_levels?.[modelId] ?? supported;
  if (configured.includes(requested) && supported.includes(requested)) return interaction;
  // The effort implied thinking on and its effort-derived fields (baseEffort,
  // configuration updates) must not leak into the default. Keep only an explicit
  // thinking-off and any thinking budget.
  const { enabled, budgetTokens } = interaction.reasoning!;
  const reasoning = {
    ...(enabled === false ? { enabled } : {}),
    ...(budgetTokens === undefined ? {} : { budgetTokens }),
  };
  return { ...interaction, reasoning: Object.keys(reasoning).length === 0 ? undefined : reasoning };
}
