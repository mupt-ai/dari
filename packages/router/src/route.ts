// Deterministic route preparation and finalization. These compositions call
// the same phase functions Dari's hosted runtime executes; hosts with
// interleaved effects (speculative execution, telemetry) may call the phases
// directly instead.

import { resolveCompatibleCandidates, type CandidateMetadataLookup } from "./compatibility.js";
import { conversationBlockCount, conversationMessages } from "./fingerprint.js";
import {
  deepestIdentityHit,
  deriveModelChainHits,
  estimateCandidateCosts,
  selectPromptAnchor,
  type CandidatePromptEstimate,
  type PricingLookup,
} from "./cost.js";
import { prefixHitMatchesProvider, warmPrefixHits } from "./cache_behavior.js";
import { reasoningCacheScope, type ReasoningCacheScopeLookup } from "./cache_scope.js";
import { RouterCoreError } from "./errors.js";
import {
  DEFAULT_PROMPT_GROWTH_TOKENS_PER_TURN,
  MIN_TURNS_FOR_OBSERVED_PROMPT_GROWTH,
} from "./fixed_turn_cost_config.js";
import {
  activeLeaseFromHit,
  compatiblePreviousDecision,
  pendingLeaseFromHit,
  previousDecisionFromHit,
  type ActiveLease,
  type PendingLease,
} from "./previous_decision.js";
import {
  resolveStrategyCandidates,
  type StrategyCandidateResolution,
} from "./candidate_resolution.js";
import { selectorSafeMessages } from "./selector_input.js";
import { buildSizedSelectorRequest, type BuiltSelectorRequest } from "./selector_request.js";
import { parseSelectorDecision, validateSelectorDecisions } from "./selector_parse.js";
import { routingCandidateKey } from "./types.js";
import type {
  CandidateCostEstimate,
  ChainHits,
  ChatCompletionRequest,
  ChatMessage,
  CustomRouterConfig,
  HardCapability,
  PrefixHit,
  PreviousDecision,
  ReasoningEffort,
  RouterEval,
  RouterModelPrice,
  RouterPrefixHit,
  RoutingDecision,
  RoutingStrategy,
} from "./types.js";

export type RoutePreparationWarning = {
  phase: "cost_estimation";
  error: unknown;
};

export type CandidatePromptAnchor = {
  hash: string;
  depth: number;
};

// Candidate preparation consumes explicit prompt-accounting facts instead of
// inferring them from the selector's lossy message projection. Hosts may use
// provider-visible IR semantics; prepareRoute supplies simple Chat accounting
// for public Chat-shaped callers.
export type CandidatePromptAccounting = {
  anchorSemantics: "matched_prefix" | "stored_input";
  providerBlockDepthFor: (model: string) => number;
  // Return the full candidate-visible prompt when no anchor is supplied, or
  // the suffix after a same-model anchor when one is supplied. Foreign-model
  // token counts are never a valid baseline for this candidate's prompt.
  promptEstimateFor: (
    model: string,
    anchor?: CandidatePromptAnchor,
  ) => CandidatePromptEstimate;
};

export type LegacyTailCharsFor = (
  model: string,
  hash: string,
) => number | undefined;

type CandidatePreparationSharedInput = {
  candidateModels: string[];
  metadataLookup: CandidateMetadataLookup;
  requiredCapabilities: readonly HardCapability[];
  requestedReasoningEffort?: ReasoningEffort;
  thinkingEnabled?: boolean;
  toolChoice?: unknown;
  modelThinkingLevels?: Readonly<Record<string, ReasoningEffort[]>>;
  strategy: RoutingStrategy;
  customConfig?: CustomRouterConfig | null;
  modelPrices?: Record<string, RouterModelPrice>;
  pricing: PricingLookup;
  promptTokenLimitFor?: (model: string) => number | null;
  requiresPromptEstimateFor?: (model: string) => boolean;
  averageOutputTokensByModel?: Readonly<
    Record<string, Partial<Record<ReasoningEffort, number>> | null>
  >;
  // Per-candidate-model prefix-hash chains for the incoming conversation, as
  // computed by the host's fingerprinting (see fingerprint.ts / prefixChain).
  chainsByModel: ReadonlyMap<string, string[]>;
  // Prefix entries resolved by the host's prefix-hit storage: every entry
  // inside the host's conversation lookback, warm or not. Which of them are
  // still warm is decided here against nowMs, so a host never has to encode
  // the provider cache-warmth window itself.
  prefixHits?: RouterPrefixHit[];
  // The instant this request arrived, in epoch milliseconds. This package
  // reads no clock, and prefix warmth is measured from here.
  nowMs: number;
  // The request's loose chain (client-durable canonicalization), as computed
  // by the host's fingerprinting. Identity-only; never used for warmth.
  looseChain?: readonly string[];
  // A trusted harness conversation id can recover continuity when its client
  // changes the request head (for example, Claude Code changes its tool set).
  // This fallback is identity-only and never contributes cache warmth.
  conversationId?: string;
  toolChoiceFp: string;
  responseFormatFp: string;
  previousDecision?: PreviousDecision;
  cacheScope?: ReasoningCacheScopeLookup;
};

// Rich hosts provide provider-visible accounting. Existing Chat-shaped hosts
// provide messages and may override same-model suffix sizing. These modes are
// mutually exclusive so preparation never silently ignores one representation.
export type CandidatePreparationInput = CandidatePreparationSharedInput & (
  | {
      promptAccounting: CandidatePromptAccounting;
      messages?: never;
      tailCharsFor?: never;
    }
  | {
      promptAccounting?: undefined;
      messages: ChatMessage[];
      tailCharsFor?: LegacyTailCharsFor;
    }
);

export type CandidatePreparation = {
  hits: ChainHits;
  // Conversation id recovered from the deepest identity hit (strict or
  // loose tier, warm or merely recent); null for a fresh conversation
  // (hosts typically substitute a new random id).
  conversationId: string | null;
  // Depth of that identity hit, for host reporting. Null when no hit.
  identityMatchDepth: number | null;
  // The same matched entry, exposed so hosts can carry synchronized
  // conversation-level state forward without repeating identity matching.
  identityHit?: PrefixHit;
  previousDecision?: PreviousDecision;
  // Unexpired lease recovered from the identity hit, when its target is still
  // a compatible candidate. The host may serve it without consulting the
  // selector.
  activeLease?: ActiveLease;
  // Next lease prefetched before expiry; adopted when activeLease is absent.
  pendingLease?: PendingLease;
  // Pre-strategy estimates for every compatible candidate, kept for
  // reporting/audit even when pruning later narrows the candidate set.
  costEstimates: CandidateCostEstimate[];
  candidateResolution: StrategyCandidateResolution;
  warnings: RoutePreparationWarning[];
};

// Deterministic candidate preparation: eligibility, cache-aware cost
// estimates, previous-decision resolution, and strategy resolution/pruning.
// Cost estimation is best-effort: a failure there surfaces as a warning and
// leaves estimates empty rather than failing the route.
export function prepareCandidates(input: CandidatePreparationInput): CandidatePreparation {
  return prepareCandidatesWithAccounting(
    input,
    resolvePromptAccounting(input),
  );
}

// Prompt tokens the conversation gains per recorded turn, from its own prefix
// rows: replies and tool results both land in the next prompt. Too short a
// history falls back to the default rate.
export function conversationPromptGrowth(
  hits: RouterPrefixHit[] | undefined,
  conversationId: string | null,
): number {
  const promptTokensByDepth = new Map<number, number>();
  for (const entry of hits ?? []) {
    if (conversationId === null || entry.conversation_id !== conversationId) continue;
    const known = promptTokensByDepth.get(entry.message_depth) ?? 0;
    promptTokensByDepth.set(entry.message_depth, Math.max(known, entry.prompt_tokens));
  }
  if (promptTokensByDepth.size < MIN_TURNS_FOR_OBSERVED_PROMPT_GROWTH) {
    return DEFAULT_PROMPT_GROWTH_TOKENS_PER_TURN;
  }
  const ordered = [...promptTokensByDepth].sort(([left], [right]) => left - right);
  const first = ordered[0]![1];
  const last = ordered[ordered.length - 1]![1];
  return Math.max(0, (last - first) / (ordered.length - 1));
}

function newestConversationHit(
  hits: RouterPrefixHit[] | undefined,
  conversationId: string | undefined,
): PrefixHit | undefined {
  if (conversationId === undefined) return undefined;
  let newest: RouterPrefixHit | undefined;
  let newestUpdatedAtMs = Number.NEGATIVE_INFINITY;
  let newestDepth = Number.NEGATIVE_INFINITY;
  for (const entry of hits ?? []) {
    if (entry.conversation_id !== conversationId) continue;
    const parsedUpdatedAtMs = Date.parse(entry.updated_at);
    const updatedAtMs = Number.isFinite(parsedUpdatedAtMs)
      ? parsedUpdatedAtMs
      : Number.NEGATIVE_INFINITY;
    // A warm cache read bumps updated_at on a shallower row without
    // rewriting its lease fields, and that touch shares the serving turn's
    // clock with the turn's own write, so at equal freshness the deeper row
    // is the row that carries the latest serving decision.
    if (
      newest === undefined ||
      updatedAtMs > newestUpdatedAtMs ||
      (updatedAtMs === newestUpdatedAtMs && entry.message_depth > newestDepth)
    ) {
      newest = entry;
      newestUpdatedAtMs = updatedAtMs;
      newestDepth = entry.message_depth;
    }
  }
  return newest === undefined ? undefined : { entry: newest, depth: 0 };
}

function prepareCandidatesWithAccounting(
  input: CandidatePreparationSharedInput,
  promptAccounting: CandidatePromptAccounting,
): CandidatePreparation {
  const compatible = resolveCompatibleCandidates({
    requiredCapabilities: input.requiredCapabilities,
    requestedReasoningEffort: input.requestedReasoningEffort,
    thinkingEnabled: input.thinkingEnabled,
    toolChoice: input.toolChoice,
    candidateModels: input.candidateModels,
    metadataLookup: input.metadataLookup,
    modelThinkingLevels: input.modelThinkingLevels,
  });
  const warnings: RoutePreparationWarning[] = [];
  const cacheScope = input.cacheScope ?? ((model: string) =>
    reasoningCacheScope(model, input.metadataLookup(model).provider));

  let hits: ChainHits = { perModel: new Map(), perModelBuckets: new Map() };
  let costEstimates: CandidateCostEstimate[] = [];
  let previousDecision = compatiblePreviousDecision(
    input.previousDecision,
    compatible.candidates,
  );
  let conversationId: string | null = null;
  let identityMatchDepth: number | null = null;
  let activeLease: ActiveLease | undefined;
  let pendingLease: PendingLease | undefined;
  let identityHit: PrefixHit | undefined;

  try {
    // Warmth: strict chains over hits still inside the warmth window — cost
    // estimation and the freshness touch must reflect what the provider cache
    // can actually re-read. Identity: either tier over every recent hit — a
    // stale or loose-only match still names the same conversation.
    const providersByCandidate = new Map(
      compatible.candidates.map(({ model }) => [model, input.metadataLookup(model).provider]),
    );
    const providerCompatibleWarmHits = warmPrefixHits(input.prefixHits, input.nowMs)
      .filter((hit) => {
        const provider = providersByCandidate.get(hit.model);
        return provider !== undefined && prefixHitMatchesProvider(hit, provider);
      });
    hits = deriveModelChainHits(
      input.chainsByModel,
      providerCompatibleWarmHits,
    );
    identityHit = deepestIdentityHit(
      input.chainsByModel,
      input.looseChain,
      input.prefixHits,
    ) ?? newestConversationHit(input.prefixHits, input.conversationId);
    if (identityHit) {
      conversationId = identityHit.entry.conversation_id;
      identityMatchDepth = identityHit.depth > 0 ? identityHit.depth : null;
      // Prefix matches measure shared history, not the latest routing state.
      // A client can rewrite its tail and still match an older, expired lease.
      // Only a trusted conversation id lets us use newer nonmatching rows.
      const stateHit = input.conversationId === conversationId
        ? newestConversationHit(input.prefixHits, conversationId) ?? identityHit
        : identityHit;
      previousDecision ??= previousDecisionFromHit(
        stateHit.entry,
        compatible.candidates,
      );
      activeLease = activeLeaseFromHit(stateHit.entry, compatible.candidates);
      // The prefetch write lands on whatever rows existed when the policy
      // finished, and later turns append rows without it, so the pending
      // lease is recovered from any recent row of this conversation — but
      // only when the previous lease ran to completion. The final hold turn
      // writes a zero countdown; a fallback-served turn writes none, and its
      // broken commitment must not be resurrected by a stale prefetch.
      if (stateHit.entry.lease_turns_remaining === 0) {
        const matchConversationId = identityHit.entry.conversation_id;
        const conversationHits = (input.prefixHits ?? [])
          .filter((hit) => hit.conversation_id === matchConversationId)
          .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
        for (const hit of conversationHits) {
          pendingLease = pendingLeaseFromHit(hit, compatible.candidates);
          if (pendingLease !== undefined) break;
        }
      }
    }

    const promptEstimatesByCandidate = new Map(
      compatible.candidates.map((candidate) => {
        const anchor = selectPromptAnchor(
          hits,
          candidate.model,
          candidate.reasoningEffort,
          cacheScope,
        );
        const candidateAnchor = promptAnchorFor({
          accounting: promptAccounting,
          // Stored prompt tokens include the previous response-format schema.
          anchor:
            anchor?.entry.response_format_fp === input.responseFormatFp
              ? anchor
              : undefined,
          chain: input.chainsByModel.get(candidate.model),
        });
        return [
          routingCandidateKey(candidate),
          promptAccounting.promptEstimateFor(
            candidate.model,
            candidateAnchor,
          ),
        ];
      }),
    );
    costEstimates = estimateCandidateCosts({
      candidates: compatible.candidates,
      hits,
      incomingProviderBlockCountFor: promptAccounting.providerBlockDepthFor,
      promptEstimatesByCandidate,
      toolChoiceFp: input.toolChoiceFp,
      responseFormatFp: input.responseFormatFp,
      pricing: input.pricing,
      averageOutputTokensByModel: input.averageOutputTokensByModel,
      cacheScope,
      modelProvider: (model) => input.metadataLookup(model).provider,
      promptGrowthTokensPerTurn: conversationPromptGrowth(input.prefixHits, conversationId),
    });
  } catch (error) {
    warnings.push({ phase: "cost_estimation", error });
  }

  if (input.promptTokenLimitFor !== undefined) {
    const estimates = new Map(costEstimates.map((estimate) => [
      routingCandidateKey({ model: estimate.model, reasoningEffort: estimate.reasoning_effort }),
      estimate.est_prompt_tokens,
    ]));
    compatible.candidates = compatible.candidates.filter((candidate) => {
      const limit = input.promptTokenLimitFor!(candidate.model);
      const tokens = estimates.get(routingCandidateKey(candidate));
      return limit === null || (tokens === undefined
        ? input.requiresPromptEstimateFor?.(candidate.model) === false
        : tokens <= limit);
    });
    if (compatible.candidates.length === 0) {
      throw new RouterCoreError(
        "invalid_request",
        "The prompt exceeds the standard-price context range of all compatible models. Shorten or compact the conversation.",
        "context_length_exceeded",
      );
    }
    previousDecision = compatiblePreviousDecision(previousDecision, compatible.candidates);
    const keys = new Set(compatible.candidates.map(routingCandidateKey));
    if (activeLease && !keys.has(routingCandidateKey(activeLease))) activeLease = undefined;
    if (pendingLease && !keys.has(routingCandidateKey(pendingLease))) pendingLease = undefined;
    costEstimates = costEstimates.filter((estimate) => keys.has(routingCandidateKey({
      model: estimate.model,
      reasoningEffort: estimate.reasoning_effort,
    })));
  }

  const candidateResolution = resolveStrategyCandidates({
    strategy: input.strategy,
    candidates: compatible.candidates,
    costEstimates,
    previousDecision,
    customConfig: input.customConfig,
    modelPrices: input.modelPrices ?? {},
  });

  return {
    hits,
    conversationId,
    identityMatchDepth,
    ...(identityHit !== undefined ? { identityHit } : {}),
    ...(previousDecision !== undefined ? { previousDecision } : {}),
    ...(activeLease !== undefined ? { activeLease } : {}),
    ...(pendingLease !== undefined ? { pendingLease } : {}),
    costEstimates,
    candidateResolution,
    warnings,
  };
}

// Resolved fallback posture for the phased prepareRoute API. Distinct from
// createRouter's RouterFallbackConfig: here both flags default ON.
export type RouteFallbackConfig = {
  enabled: boolean;
  requiresDifferentProvider: boolean;
};

type RouteAccountingInput =
  | {
      promptAccounting: CandidatePromptAccounting;
      tailCharsFor?: never;
    }
  | {
      promptAccounting?: undefined;
      tailCharsFor?: LegacyTailCharsFor;
    };

export type RouteInput = CandidatePreparationSharedInput & RouteAccountingInput & {
  // Full request message list, system messages included.
  messages: ChatMessage[];
  evals?: RouterEval[];
  selectorModel: string;
  // Selector context budget in characters (typically the selector model's
  // context window in tokens times CHARS_PER_TOKEN).
  selectorContextWindowChars: number;
  modelFallbackEnabled?: boolean;
  fallbackRequiresDifferentProvider?: boolean;
};

export type PreparedRoute = CandidatePreparation & {
  modelProvider: (model: string) => string;
  fallbackConfig: RouteFallbackConfig;
  // Null when the custom strategy is selected but no custom rule
  // configuration resolved; hosts surface their own error for that state.
  selectorPreparation: BuiltSelectorRequest | null;
};

export function prepareRoute(input: RouteInput): PreparedRoute {
  const preparation = prepareCandidatesWithAccounting(
    input,
    input.promptAccounting
      ?? chatPromptAccounting(input.messages, input.tailCharsFor),
  );
  const resolution = preparation.candidateResolution;
  const fallbackConfig: RouteFallbackConfig = {
    enabled: input.modelFallbackEnabled !== false,
    requiresDifferentProvider: input.fallbackRequiresDifferentProvider !== false,
  };
  const custom = resolution.strategy === "custom" ? resolution.custom : undefined;
  const modelProvider = (model: string) => input.metadataLookup(model).provider;
  if (custom === null) {
    return { ...preparation, modelProvider, fallbackConfig, selectorPreparation: null };
  }
  const selectorPreparation = buildSizedSelectorRequest({
    candidates: resolution.candidates,
    evals: input.evals ?? [],
    ...(preparation.previousDecision !== undefined
      ? { previousDecision: preparation.previousDecision }
      : {}),
    costEstimates: resolution.costEstimates,
    ...(custom ? { customRules: custom.rules, defaultTarget: custom.defaultTarget } : {}),
    selectorModel: input.selectorModel,
    contextWindowChars: input.selectorContextWindowChars,
    messages: selectorSafeMessages(input.messages),
    modelFallbackEnabled: fallbackConfig.enabled,
    fallbackRequiresDifferentProvider: fallbackConfig.requiresDifferentProvider,
  });
  return { ...preparation, modelProvider, fallbackConfig, selectorPreparation };
}

export type RouteResult = {
  decision: RoutingDecision;
  fallbackDecision?: RoutingDecision;
  outputText: string;
};

// Parses and validates the selector's raw output against the prepared
// candidate set and fallback policy.
export function finalizeRoute(
  prepared: Pick<PreparedRoute, "candidateResolution" | "fallbackConfig" | "modelProvider">,
  selectorOutputText: string,
): RouteResult {
  const parsed = parseSelectorDecision(selectorOutputText);
  validateSelectorDecisions({
    decision: parsed.decision,
    ...(parsed.fallbackDecision !== undefined
      ? { fallbackDecision: parsed.fallbackDecision }
      : {}),
    candidates: prepared.candidateResolution.candidates,
    modelFallbackEnabled: prepared.fallbackConfig.enabled,
    fallbackRequiresDifferentProvider: prepared.fallbackConfig.requiresDifferentProvider,
    providerForModel: prepared.modelProvider,
  });
  return {
    decision: parsed.decision,
    ...(parsed.fallbackDecision !== undefined
      ? { fallbackDecision: parsed.fallbackDecision }
      : {}),
    outputText: selectorOutputText,
  };
}

// The only effect in the pipeline: executing the selector request against
// some model. Implementations receive a complete chat-completions-shaped
// request and return the model's raw output text. Credentials, transport,
// and retries are entirely the implementation's concern.
export type Selector = {
  select(request: ChatCompletionRequest, signal?: AbortSignal): Promise<string>;
};

export async function route(
  input: RouteInput,
  selector: Selector,
): Promise<RouteResult & { prepared: PreparedRoute }> {
  const prepared = prepareRoute(input);
  if (prepared.selectorPreparation === null) {
    throw new RouterCoreError(
      "configuration",
      "Router custom rule configuration is missing.",
      "custom_config_missing",
    );
  }
  const outputText = await selector.select(prepared.selectorPreparation.selectorRequest);
  return { ...finalizeRoute(prepared, outputText), prepared };
}

export function chatPromptAccounting(
  messages: ChatMessage[],
  tailCharsFor?: LegacyTailCharsFor,
): CandidatePromptAccounting {
  const conversation = conversationMessages({ messages });
  const blockDepth = conversationBlockCount({ messages });
  return {
    anchorSemantics: "matched_prefix",
    providerBlockDepthFor: () => blockDepth,
    promptEstimateFor: (model, anchor) => {
      if (anchor) {
        const exact = tailCharsFor?.(model, anchor.hash);
        if (exact !== undefined) {
          return { chars: exact, reusesStoredPromptTokens: true };
        }
      }
      return {
        chars: JSON.stringify(
          anchor ? conversation.slice(anchor.depth) : messages,
        ).length,
        reusesStoredPromptTokens: anchor !== undefined,
      };
    },
  };
}

function promptAnchorFor(args: {
  accounting: CandidatePromptAccounting;
  anchor: ReturnType<typeof selectPromptAnchor>;
  chain: readonly string[] | undefined;
}): CandidatePromptAnchor | undefined {
  if (!args.anchor) return undefined;
  const depth =
    args.accounting.anchorSemantics === "stored_input"
      ? args.anchor.entry.prompt_anchor_depth
      : args.anchor.depth;
  if (
    depth === undefined
    || depth === null
    || depth <= 0
  ) {
    return undefined;
  }
  const hash = args.chain?.[depth - 1];
  return hash === undefined ? undefined : { hash, depth };
}

function resolvePromptAccounting(
  input: CandidatePreparationInput,
): CandidatePromptAccounting {
  if (input.promptAccounting) return input.promptAccounting;
  if (input.messages) {
    return chatPromptAccounting(input.messages, input.tailCharsFor);
  }
  throw new RouterCoreError(
    "invalid_request",
    "Candidate preparation requires promptAccounting or messages",
    "prompt_accounting_required",
  );
}
