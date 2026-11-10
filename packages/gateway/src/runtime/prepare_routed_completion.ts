import type { CandidatePruningAudit } from "@mupt-ai/dari-router/policy-engine";

import { interactionConversationPrefix } from "../context/interaction_fingerprint.js";
import { clampRequestedEffort } from "../context/routing_context.js";
import { modelMetadataLookup } from "../providers/pi.js";
import {
  buildRoutingContext,
  derivePrefixLookupHashes,
  type ImageCapabilityPrunedModel,
  type RoutingContext,
} from "../context/routing_context.js";
import { isBackgroundRequest, type InteractionRequest } from "../interaction/types.js";
import { executionProviderForModel } from "../models/execution_provider.js";
import { codexModelConfig, subscriptionServes } from "../models/subscriptions.js";
import { explicitModelId } from "../protocol/input/router_model.js";
import { gatewayPlatform, type RequestTags, type SessionPin } from "../platform/platform.js";
import { resolveRouter } from "../strategies/routing.js";
import { RequestReporter, type ReportedCandidatePruning } from "../telemetry/report.js";
import { RoutingBillingFinalization } from "../telemetry/billing_finalization.js";
import type { ClientHarness, ProviderCredential, ResolvedRouter } from "../types.js";
import { requestTags } from "./request_tags.js";
import { strictProviderAccess } from "./strict_provider_access.js";
import type { RoutedRuntimeReporter } from "./runtime_reporter.js";
import type { RoutedProtocol } from "./routed_protocol.js";
import {
  scopedHarnessAgentId,
  scopedHarnessConversationId,
  scopedHarnessSessionId,
  type HarnessConversationIdentity,
} from "./harness_identity/index.js";

export type PreparedRoutedCompletion = {
  requestId: string;
  routerId: string;
  receivedAt: Date;
  interaction: InteractionRequest;
  protocol: RoutedProtocol;
  credentials: ResolvedRouter;
  billable: boolean;
  tags: RequestTags;
  harnessConversationIdentity?: HarnessConversationIdentity;
  routing: RoutingContext;
  // Present when this request is served by session pinning: the session's
  // pin key and the pair it pinned, null before its first routed turn.
  sessionPin?: { key: string; pin: SessionPin | null };
  reporter: RoutedRuntimeReporter;
};

export async function prepareRoutedCompletion(args: {
  routerId: string;
  apiKey: string;
  interaction: InteractionRequest;
  protocol: RoutedProtocol;
  receivedAt: Date;
  startedMs: number;
  requestId: string;
  clientRequestId: string | null;
  tagsHeader: string | null;
  clientHarness?: ClientHarness;
  harnessConversationIdentity?: HarnessConversationIdentity;
}): Promise<PreparedRoutedCompletion> {
  const tags = requestTags(args.tagsHeader);
  // Eval relevance draws from the public catalog, which resolve only returns
  // on request.
  const resolveRequest = {
    routerId: args.routerId,
    apiKey: args.apiKey,
    includePublicEvalCatalog: true,
  };
  // Direct /v1 callers are authenticated by API key, so their canonical
  // organization router is not known until this resolve completes. Fingerprint
  // the stable public alias here; prefix lookup remains tenant-safe because the
  // platform scopes every hash query to the resolved canonical router.
  const prefixFingerprintRouterId = args.routerId;
  const background = isBackgroundRequest(args.interaction);
  const prefixHashes = background ? [] : derivePrefixLookupHashes(
    prefixFingerprintRouterId,
    args.interaction,
  );
  let credentials = await resolveRouter({
    ...resolveRequest,
    prefixHashes,
    clientHarness: args.clientHarness,
  });
  const canonicalRouterId = credentials.router_id;
  const organizationId = credentials.organization_id;
  const billingFinalization = new RoutingBillingFinalization({
    requestId: args.requestId,
    organizationId,
  });
  const harnessScope = {
    organizationId: credentials.organization_id,
    routerId: credentials.router_id,
    apiKeyId: credentials.api_key_id,
    attributedUserId: credentials.attributed_user_id,
  };
  const agentSessionId = args.harnessConversationIdentity === undefined
    ? undefined
    : scopedHarnessSessionId({
        // Subagent qualifiers scope a conversation, not the session it belongs to.
        identity: { ...args.harnessConversationIdentity, qualifiers: undefined },
        sourceProtocol: args.interaction.sourceProtocol,
        scope: harnessScope,
      });
  const harnessConversationId = args.harnessConversationIdentity === undefined
    ? undefined
    : scopedHarnessConversationId({
        identity: args.harnessConversationIdentity,
        sourceProtocol: args.interaction.sourceProtocol,
        scope: harnessScope,
        conversationPrefix: args.interaction.agentContext === undefined
          ? interactionConversationPrefix(args.interaction)
          : JSON.stringify([
              args.interaction.agentContext.requestClass,
              interactionConversationPrefix(args.interaction),
            ]),
      });
  if (!background && harnessConversationId !== undefined) {
    // Hash matches may contain only older history after a client rewrites its
    // tail. Always resolve the trusted conversation too so lease recovery sees
    // its latest serving row, not just whichever old prefixes still match.
    // Unrelated work under the same harness session has a different id.
    const conversationCredentials = await resolveRouter({
      ...resolveRequest,
      prefixHashes,
      conversationId: harnessConversationId,
      clientHarness: args.clientHarness,
    });
    if (
      conversationCredentials.organization_id !== organizationId ||
      conversationCredentials.router_id !== canonicalRouterId
    ) {
      throw new Error("Repeated router resolution changed request ownership.");
    }
    credentials = conversationCredentials;
  }
  const access = strictProviderAccess(credentials, args.interaction);
  credentials = access.credentials;
  args = {
    ...args,
    interaction: clampRequestedEffort(
      access.interaction,
      credentials,
      modelMetadataLookup(credentials.model_configs),
    ),
  };
  credentials = await withProviderCredentials(credentials, args.apiKey, args.clientHarness);
  const billable = true;
  const routing = await buildRoutingContext({
    routerId: prefixFingerprintRouterId,
    interaction: args.interaction,
    credentials,
    explicitConversationId: harnessConversationId,
    receivedAt: args.receivedAt,
  });
  const candidateResolution = routing.candidateResolution;
  let sessionPin: PreparedRoutedCompletion["sessionPin"];
  if (
    credentials.session_pinning === true &&
    credentials.strict !== true &&
    !background &&
    explicitModelId(args.interaction.model) === null
  ) {
    // Harness identity keys the main agent and each subagent separately and
    // survives compaction. Claude Code names its subagents only with gateway
    // hint headers; without them, and for callers with no harness identity,
    // each conversation is pinned on its own.
    const identity = args.harnessConversationIdentity;
    const unclassifiedClaudeCode = identity?.kind === "claude_code_session"
      && args.interaction.agentContext?.requestClass === "unknown";
    const key = identity === undefined || unclassifiedClaudeCode
      ? routing.conversationId
      : scopedHarnessAgentId({
          identity,
          sourceProtocol: args.interaction.sourceProtocol,
          scope: harnessScope,
        });
    const pin = await gatewayPlatform().readSessionPin({ routerId: canonicalRouterId, pinKey: key });
    sessionPin = { key, pin };
  }
  const reporter = new RequestReporter({
    requestId: args.requestId,
    clientRequestId: args.clientRequestId,
    tags,
    credentials,
    routerId: canonicalRouterId,
    interaction: args.interaction,
    harnessConversationIdentity: args.harnessConversationIdentity,
    leaseDepth: routing.leaseDepth,
    providerBlockDepthFor: routing.providerBlockDepthFor,
    zdr: routing.zdr,
    strategy: candidateResolution.strategy,
    receivedAt: args.receivedAt,
    startedMs: args.startedMs,
    conversationId: routing.conversationId,
    isNewConversation: routing.isNewConversation,
    agentSessionId,
    identityMatchDepth: routing.identityMatchDepth,
    identityHit: routing.identityHit,
    hits: routing.hits,
    costEstimates: routing.reportingCostEstimates,
    candidates: candidateResolution.candidates,
    sessionPinKey: sessionPin?.key,
    pruning: reportedPruning(
      candidateResolution.pruning,
      routing.imageCapabilityPrunedModels,
    ),
    pricing: routing.pricing,
    chainByModel: routing.prefix.chainByModel,
    looseChain: routing.prefix.looseChain,
    targetsByModel: routing.targetsByModel,
    fingerprints: routing.prefix.fingerprints,
    billingFinalization,
  });

  return {
    requestId: args.requestId,
    routerId: canonicalRouterId,
    receivedAt: args.receivedAt,
    interaction: args.interaction,
    protocol: args.protocol,
    credentials,
    billable,
    tags,
    harnessConversationIdentity: args.harnessConversationIdentity,
    routing,
    ...(sessionPin === undefined ? {} : { sessionPin }),
    reporter,
  };
}

// Ask the platform for each enabled model's credential up front, so provider
// execution stays synchronous.
async function withProviderCredentials(
  credentials: ResolvedRouter,
  apiKey: string,
  clientHarness: ClientHarness | undefined,
): Promise<ResolvedRouter> {
  const platform = gatewayPlatform();
  if (platform.resolveProviderCredential === undefined) return credentials;
  const resolved = await Promise.all(
    credentials.enabled_models.map(async (model) => [
      model,
      await platform.resolveProviderCredential!({
        provider: executionProviderForModel(credentials, model),
        model,
        routerId: credentials.router_id,
        organizationId: credentials.organization_id,
        apiKey,
        ...(clientHarness ? { clientHarness } : {}),
      }),
    ] as const),
  );
  const provider_credentials: Record<string, ProviderCredential> = {};
  const model_configs = { ...credentials.model_configs };
  for (const [model, credential] of resolved) {
    if (!credential?.apiKey.trim()) continue;
    const plan = credential.subscription;
    if (plan !== undefined && !subscriptionServes(plan, model, clientHarness)) continue;
    provider_credentials[model] = credential;
    if (plan === "openai_codex") {
      // Keep the catalog's limits and thinking levels; only the serving
      // endpoint changes.
      model_configs[model] = {
        ...model_configs[model],
        ...codexModelConfig(model, credentials.model_prices?.[model] ?? null),
      };
    }
  }
  return { ...credentials, provider_credentials, model_configs };
}

// Core's cache-aware pruning audit, extended with the context layer's image
// capability exclusions. The exclusions survive on their own when custom
// routing produced no core audit (missing config), so the error path keeps
// its candidate_pruning trail.
function reportedPruning(
  core: CandidatePruningAudit | null,
  imagePruned: ImageCapabilityPrunedModel[] | undefined,
): ReportedCandidatePruning | null {
  if (imagePruned === undefined) return core;
  const capability = { capability_pruned_models: imagePruned };
  return core === null ? capability : { ...core, ...capability };
}
