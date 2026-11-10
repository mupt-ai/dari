// Reporting of served routing requests to the platform: the request record
// and the prefix-state write the next turn resolves. Most callers
// fire-and-forget; streams hold their terminal marker on the prefix-state
// write so the immediate next turn can see next_model. Reporting failures are
// always logged and swallowed.

import {
  selectPrefixHit,
  type CandidateCostEstimate,
  type CandidatePruningAudit,
  type ChainHits,
  type PrefixHit,
  type PricingLookup,
  type RoutingCandidate,
  type RoutingDecision,
  type RoutingStrategy,
} from "@mupt-ai/dari-router/policy-engine";
import type { ImageCapabilityPrunedModel } from "../context/routing_context.js";
import { HttpError, errorCode } from "../http/errors.js";
import { executionProviderForModel } from "../models/execution_provider.js";
import {
  isBackgroundRequest,
  type InteractionOutput,
  type InteractionRequest,
  type InteractionUsage,
  type ProviderIdentity,
} from "../interaction/types.js";
import { captureOperationalError } from "../observability/errors.js";
import { gatewayPlatform, type RequestRecordRouter, type RequestTags } from "../platform/platform.js";
import type {
  ProviderAttemptRecord,
  ProviderAttemptReport,
  FrozenProviderTerminal,
  ReportableProviderOutcome,
  ReportedProviderExecution,
} from "../runtime/runtime_reporter.js";
import {
  selectorTraceFromError,
  type SelectorRun,
  type SelectorTrace,
} from "../strategies/routing.js";
import type { ResolvedRouter } from "../types.js";
import type { HarnessConversationIdentity } from "../runtime/harness_identity/index.js";
import { trackBackgroundTelemetry } from "./background.js";
import { modelCost } from "./model_cost.js";
import {
  routingBillingProviderAttemptFacts,
  type FrozenRoutingBillingTerminal,
  type RoutingBillingFinalization,
  type RoutingBillingFinalizationPayload,
  type RoutingBillingProviderAttemptFacts,
  type RoutingBillingTerminalOutcome,
} from "./billing_finalization.js";
import { estimateBenchmarkReplay } from "./benchmark_replay.js";
import { extractInteractionObservability } from "./requests/interaction_observability.js";
import {
  costString,
  finiteNumber,
  isRecord,
  tokenCount,
} from "./ingest_values.js";
import {
  buildCompletedPrefixHit,
  leaseCountdownForPrefix,
  prefixEntryForIngest,
  reportPrefixState,
} from "./prefix_state.js";
import { subscriptionUsageLimitFromFailure } from "../providers/subscription_limits.js";
import { scrubSecrets } from "./scrub.js";
import { encodeRetainedInteractionRequest } from "./requests/retained_interaction_request.js";
import { toolResultObservations, toolSkillEvents } from "./tools/observations.js";

// The decision's candidate_pruning audit: core cache-aware pruning, extended
// with models excluded up front for missing hard capabilities (image input).
// Capability exclusions stand alone when core strategy resolution produced no
// pruning audit (custom routing without a usable config).
export type ReportedCandidatePruning =
  | (CandidatePruningAudit & {
      capability_pruned_models?: ImageCapabilityPrunedModel[];
    })
  | { capability_pruned_models: ImageCapabilityPrunedModel[] };

type ReportOutcome = {
  errorCode?: string;
  errorMessage?: string;
  providerLatencyMs?: number;
  providerExecution?: ReportedProviderExecution;
} & (
  | {
      status: "completed";
      interactionOutput: InteractionOutput;
      providerMessage: Record<string, unknown>;
      responseBody: Record<string, unknown>;
    }
  | {
      status: "provider_error";
      providerMessage?: Record<string, unknown>;
    }
  | {
      status: "selector_error";
    }
  | {
      status: "aborted";
      providerMessage: Record<string, unknown> | null;
      responseBody: Record<string, unknown> | null;
      billingOutcome: "customer_canceled" | "provider_failed";
      partialOutput?: InteractionOutput | null;
    }
);

type FrozenBillingRecord = {
  payload: RoutingBillingFinalizationPayload;
  benchmarkReplay: ReturnType<typeof estimateBenchmarkReplay>;
  terminal: FrozenRoutingBillingTerminal;
};

// Log pipelines commonly cap entries at 256 KB and split longer stdout lines
// into fragments; one guard keeps pathological provider errors
// (request-payload echoes) from mangling log entries.
const LOG_TEXT_MAX_CHARS = 64 * 1024;

// Upper bound on how long a response's terminal marker waits for the
// prefix-state write. The write is one small intra-region round trip
// (tens of milliseconds typical); the cap only matters when the platform is
// degraded, where closing the stream on time and letting the full report
// carry the entry is the right trade.
const PREFIX_STATE_WRITE_WAIT_MS = 1500;

function guardedLogText(text: string): string {
  const scrubbed = scrubSecrets(text);
  return scrubbed.length > LOG_TEXT_MAX_CHARS
    ? `${scrubbed.slice(0, LOG_TEXT_MAX_CHARS)}…[truncated]`
    : scrubbed;
}

function errorText(error: unknown): string | null {
  if (error instanceof Error && error.message) return error.message;
  return null;
}

export class RequestReporter {
  private selectorRun: SelectorRun | null = null;
  private selectorTrace: SelectorTrace | null = null;
  private adoptedSelectorOutput: {
    outputText: string | null;
    reason: string;
    candidates: readonly { model: string; reasoningEffort: string }[];
  } | null = null;
  private selectorOutputAccepted = false;
  private decision: RoutingDecision | null = null;
  private nextDecision: RoutingDecision | null = null;
  private providerAttempts: ProviderAttemptReport[] = [];
  private billingProviderAttempts: RoutingBillingProviderAttemptFacts[] = [];
  private decisionDetails: Record<string, unknown> = {};
  private reported = false;
  private terminal: FrozenProviderTerminal | null = null;
  private prefixStatePromise: Promise<unknown> | null = null;

  constructor(
    private readonly args: {
      requestId: string;
      clientRequestId: string | null;
      tags: RequestTags;
      credentials: ResolvedRouter;
      routerId: string;
      interaction: InteractionRequest;
      harnessConversationIdentity?: HarnessConversationIdentity;
      leaseDepth: number;
      providerBlockDepthFor: (model: string) => number;
      zdr: boolean;
      strategy: RoutingStrategy;
      receivedAt: Date;
      startedMs: number;
      conversationId: string;
      isNewConversation: boolean;
      agentSessionId?: string;
      // Depth of the identity hit that recovered conversationId; null when
      // this turn started a fresh conversation.
      identityMatchDepth: number | null;
      identityHit?: PrefixHit;
      hits: ChainHits;
      costEstimates: CandidateCostEstimate[];
      // The model and reasoning pairs this request could be routed to.
      candidates: readonly RoutingCandidate[];
      // The session pin this request routed under, when the router pins.
      sessionPinKey?: string;
      // Cache-aware selector-candidate pruning outcome, plus any pre-strategy
      // capability exclusions. Null when custom routing configuration cannot
      // produce candidates.
      pruning: ReportedCandidatePruning | null;
      pricing: PricingLookup | null;
      chainByModel: ReadonlyMap<string, string[]>;
      // The request's loose (client-durable) chain for the entry's loose
      // hash tier.
      looseChain: readonly string[];
      targetsByModel: ReadonlyMap<string, ProviderIdentity>;
      fingerprints: { tool_choice_fp: string; response_format_fp: string };
      billingFinalization: RoutingBillingFinalization;
    }
  ) {}

  attachSelectorRun(run: SelectorRun): void {
    this.selectorRun = run;
    this.selectorTrace = run;
    this.selectorOutputAccepted = true;
    this.decision = run.decision;
    this.nextDecision = run.decision;
  }

  attachSpeculativeSelectorRun(run: SelectorRun, servingDecision: RoutingDecision): void {
    this.selectorRun = run;
    this.selectorTrace = run;
    this.selectorOutputAccepted = true;
    this.decision = servingDecision;
    this.nextDecision = run.decision;
  }

  // Speculative execution can begin before a selector run; its serving
  // decision drives selected-model attribution, prefix entries, and errors.
  attachDecision(decision: RoutingDecision): void {
    this.decision = decision;
    this.nextDecision = decision;
  }

  attachServingDecision(decision: RoutingDecision): void {
    this.decision = decision;
  }

  recordProviderAttempt(attempt: ProviderAttemptRecord): void {
    const { execution, message, billingOutcome, ...audit } = attempt;
    this.providerAttempts.push(audit);
    this.billingProviderAttempts.push(this.billingFacts(attempt));
  }

  modelCost(attempt?: ProviderAttemptRecord): number | null {
    return modelCost(attempt ? [...this.billingProviderAttempts, this.billingFacts(attempt)] : this.billingProviderAttempts);
  }

  private billingFacts({ execution, message, attempt, billingOutcome }: ProviderAttemptRecord): RoutingBillingProviderAttemptFacts {
    return routingBillingProviderAttemptFacts({
      provider: execution.provider, model: execution.model,
      providerKeySource: execution.providerKeySource, attempt, outcome: billingOutcome,
      providerMessage: message, usage: isRecord(message.usage) ? message.usage : null,
      providerPricingKnown: this.pricingKnown(execution.model),
    });
  }

  // Strategy-specific audit data (e.g. custom-rule drops and cache-aware
  // pruning) merged into the logged decision_details next to the strategy.
  attachAdoptedSelectorOutput(adopted: {
    outputText: string | null;
    reason: string;
    candidates: readonly { model: string; reasoningEffort: string }[];
  }): void {
    this.adoptedSelectorOutput = adopted;
  }

  attachDecisionDetails(details: Record<string, unknown>): void {
    this.decisionDetails = { ...this.decisionDetails, ...details };
  }

  // Resolves once this turn's prefix-state write has settled (committed,
  // failed, or timed out). Stream serializers hold the response's terminal
  // marker on this so the immediate next turn always resolves the entry;
  // the cap bounds the worst-case close delay, and the full report remains
  // the fallback writer whenever the fast write loses.
  waitForPrefixEntryWrite(): Promise<void> {
    const pending = this.prefixStatePromise;
    if (!pending) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), PREFIX_STATE_WRITE_WAIT_MS);
      void pending.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );
    });
  }

  freezeProviderTerminal(args: ReportableProviderOutcome): FrozenProviderTerminal {
    return this.freezeTerminal(reportOutcome(args));
  }

  reportSelectorFailure(error: unknown): void {
    this.attachFailedSelectorTrace(error);
  }

  // Catch-all for errors that escape the request handler after resolution
  // (missing provider key, thrown provider calls). send() is idempotent, so
  // paths that already reported are unaffected.
  freezeFailure(error: unknown): FrozenProviderTerminal {
    this.attachFailedSelectorTrace(error);
    if (this.terminal !== null) return this.terminal;
    const code = errorCode(error, "internal_error");
    return this.freezeTerminal({
      status: this.decision ? "provider_error" : "selector_error",
      errorCode: code,
      errorMessage: errorText(error) ?? undefined,
    });
  }

  private attachFailedSelectorTrace(error: unknown): void {
    const selectorTrace = selectorTraceFromError(error);
    if (!selectorTrace) return;
    this.selectorTrace = selectorTrace;
    this.selectorOutputAccepted = false;
  }

  private pricingKnown(model: string): boolean {
    try {
      return this.args.pricing?.(model) != null;
    } catch {
      return false;
    }
  }

  private freezeTerminal(outcome: ReportOutcome): FrozenProviderTerminal {
    if (this.terminal !== null) return this.terminal;
    const billing = this.registerBilling(outcome);
    const terminal: FrozenProviderTerminal = {
      report: () => this.send(outcome, billing),
    };
    this.terminal = terminal;
    return terminal;
  }

  private registerBilling(outcome: ReportOutcome): FrozenBillingRecord {
    const providerMessage = providerMessageForOutcome(outcome);
    const terminalUsage = outcome.status === "completed"
      ? outcome.interactionOutput.usage
      : isRecord(providerMessage?.usage)
        ? providerMessage.usage
        : null;
    const benchmarkReplay = estimateBenchmarkReplay({
      enabledModels: this.args.credentials.enabled_models,
      modelPrices: this.args.credentials.model_prices ?? {},
      executionProvider: (model) =>
        executionProviderForModel(this.args.credentials, model),
      priorHit: this.args.identityHit,
      receivedAtMs: this.args.receivedAt.getTime(),
      promptTokens:
        (tokenCount(terminalUsage?.input) ?? 0) +
        (tokenCount(terminalUsage?.cacheRead) ?? 0) +
        (tokenCount(terminalUsage?.cacheWrite) ?? 0),
      outputTokens: tokenCount(terminalUsage?.output) ?? 0,
    });
    const terminal = this.args.billingFinalization.freeze(
      billingTerminalOutcome(outcome),
      this.billingProviderAttempts,
      terminalUsage === null ? null : benchmarkReplay.costUsd,
    );
    return {
      payload: terminal.readPayload(),
      benchmarkReplay,
      terminal,
    };
  }

  private send(outcome: ReportOutcome, billing: FrozenBillingRecord): void {
    if (this.reported) return;
    this.reported = true;
    try {
      const a = this.args;
      const scrubbedError = outcome.errorMessage ? guardedLogText(outcome.errorMessage) : null;
      if (outcome.status !== "completed" && outcome.status !== "aborted") {
        // Provider errors can echo request content; logs are outside the
        // ingest boundary's ZDR scrub, so only the code is logged.
        console.error(
          "routing request failed",
          JSON.stringify({
            request_id: a.requestId,
            router_id: a.routerId,
            status: outcome.status,
            error_code: outcome.errorCode ?? null,
          })
        );
      }
      const run = this.selectorRun;
      const selectorTrace = this.selectorTrace;
      const decision = this.decision;
      const selectedModel = outcome.providerExecution?.model ?? decision?.selectedModel ?? null;
      const reasoningBucket = decision?.reasoningEffort ?? null;
      const nextModel = this.nextDecision?.selectedModel ?? selectedModel;
      const nextReasoningEffort = this.nextDecision?.reasoningEffort ?? reasoningBucket;
      const selectedProvider = outcome.providerExecution?.provider ?? (selectedModel
        ? executionProviderForModel(a.credentials, selectedModel)
        : null);
      const keySource = outcome.providerExecution?.providerKeySource ?? (selectedModel && selectedProvider
        ? (a.credentials.provider_key_sources?.[selectedProvider] ?? "user")
        : null);
      const selectedEstimate = a.costEstimates.find(
        (item) =>
          item.model === selectedModel &&
          item.reasoning_effort === reasoningBucket,
      );
      const completedOutput = outcome.status === "completed"
        ? outcome.interactionOutput
        : null;
      const responseBody = outcome.status === "completed"
        ? outcome.responseBody
        : outcome.status === "aborted"
          ? outcome.responseBody ?? null
          : null;
      const providerMessage = providerMessageForOutcome(outcome);
      const usage = completedOutput?.usage ?? (
        isRecord(providerMessage?.usage) ? providerMessage.usage : null
      );
      const stopReason = completedOutput?.stopReason ?? (
        typeof providerMessage?.stopReason === "string"
          ? providerMessage.stopReason
          : null
      );
      const pricingKnown = selectedModel ? this.pricingKnown(selectedModel) : null;
      const costSource = usage?.costSource === "provider"
        ? "provider"
        : pricingKnown === true ? "pricing" : null;
      const observability = extractInteractionObservability(a.interaction);
      const inputTokens = tokenCount(usage?.input) ?? 0;
      const retainedClientRequest = encodeRetainedInteractionRequest(
        a.interaction,
      );
      const cacheReadTokens = tokenCount(usage?.cacheRead) ?? 0;
      const cacheWriteTokens = tokenCount(usage?.cacheWrite) ?? 0;
      const outputTokens = tokenCount(usage?.output) ?? 0;
      const { benchmarkReplay, payload: billingPayload } = billing;
      const selectedChain = selectedModel ? a.chainByModel.get(selectedModel) : undefined;
      const selectedTarget = selectedModel
        ? a.targetsByModel.get(selectedModel)
        : undefined;
      // An interrupted turn writes its delivered partial too, so a follow-up
      // that echoes the partial text matches this turn instead of the last.
      const prefixOutput = completedOutput ?? (
        outcome.status === "aborted" ? outcome.partialOutput ?? null : null
      );
      const backgroundRequest = isBackgroundRequest(a.interaction);
      const completedPrefix =
        !backgroundRequest && prefixOutput &&
        selectedModel &&
        selectedChain &&
        selectedTarget
          ? buildCompletedPrefixHit({
              request: a.interaction,
              output: prefixOutput,
              model: selectedModel,
              nextModel,
              nextReasoningEffort,
              reasoningBucket,
              // The strategy stamps remaining = turns - 1 assuming the
              // granting turn served the leased pair. A speculative switch
              // serves the previous pair instead, so the commitment has not
              // started: credit the turn back.
              leaseTurnsRemaining: leaseCountdownForPrefix({
                served: decision ?? null,
                next: this.nextDecision,
              }),
              reason: this.nextDecision?.reason ?? decision?.reason ?? null,
              chain: selectedChain,
              looseChain: a.looseChain,
              target: selectedTarget,
              conversationId: a.conversationId,
              leaseDepth: a.leaseDepth,
              providerBlockDepth:
                a.providerBlockDepthFor(selectedModel),
              fingerprints: a.fingerprints,
              usage: prefixOutput.usage,
              benchmarkReplayDepth: benchmarkReplay.depth,
            })
          : null;
      const prefixEntry = completedPrefix === null
        ? null
        : prefixEntryForIngest(completedPrefix);

      // Touch the SELECTED model's hit whose provider cache was just read (on
      // a switch-back it is shallower than the global deepest hit), so its
      // freshness clock restarts. For effort-keyed models that is the entry
      // in the serving reasoning bucket; a cross-effort turn read no existing
      // entry, and refreshing another bucket's entry would keep a partition
      // alive that the provider never touched.
      const touchedHash =
        !backgroundRequest && outcome.status === "completed" && selectedModel && cacheReadTokens > 0
          ? (selectPrefixHit(a.hits, selectedModel, reasoningBucket ?? "off")?.entry.hash ?? null)
          : null;

      // Fast-path prefix-state write, committed before the response's
      // terminal marker is released (waitForPrefixEntryWrite): the next
      // turn — even one arriving milliseconds after stream close — always
      // resolves this turn's conversation id and next-model prediction.
      // The full report below re-applies the same state idempotently, so a
      // lost or timed-out fast write only degrades to the old ordering.
      if (prefixEntry !== null || touchedHash !== null) {
        this.prefixStatePromise = reportPrefixState({
          organization_id: a.credentials.organization_id,
          router_id: a.routerId,
          received_at: a.receivedAt.toISOString(),
          zdr: a.zdr,
          prefix_entry: prefixEntry,
          touched_prefix_hash: touchedHash,
        });
        trackBackgroundTelemetry(this.prefixStatePromise);
      }

      const ingestPayload = {
        request_id: this.args.requestId,
        client_request_id: a.clientRequestId,
        organization_id: a.credentials.organization_id,
        router_id: a.routerId,
        api_key_id: a.credentials.api_key_id,
        attributed_user_id: a.credentials.attributed_user_id,
        source_protocol: a.interaction.sourceProtocol,
        request_kind: observability.requestKind,
        received_at: a.receivedAt.toISOString(),
        completed_at: billingPayload.finalized_at,
        billing_terminal_outcome: billingPayload.terminal_outcome,
        billing_provider_attempts: billingPayload.provider_attempts,
        stream: a.interaction.stream,
        zdr: a.zdr,
        status: outcome.status,
        error_code: outcome.errorCode ?? null,
        error_message: scrubbedError,
        conversation_id: a.conversationId,
        agent_session_id: a.agentSessionId ?? null,
        prefix_match_depth: a.identityMatchDepth ?? a.hits.deepest?.depth ?? null,
        prefix_warm_tokens: selectedEstimate?.warm_tokens ?? null,
        message_count: observability.messageCount,
        has_tools: observability.hasTools,
        request_metadata: observability.metadata,
        selected_model: selectedModel,
        selected_provider: selectedProvider,
        provider_key_source: keySource,
        selector_latency_ms: selectorTrace?.latencyMs ?? null,
        provider_latency_ms: outcome.providerLatencyMs ?? null,
        total_latency_ms: Date.now() - a.startedMs,
        client_request_json: retainedClientRequest.json,
        client_request_format: retainedClientRequest.format,
        client_response_json:
          responseBody ? JSON.stringify(responseBody) : null,
        selector: selectorTrace
          ? selectorIngest({
              trace: selectorTrace,
              reason: run?.decision.reason ?? null,
              outputAccepted: this.selectorOutputAccepted,
              pricingKnown: this.pricingKnown(selectorTrace.selectorModel),
            })
          : this.adoptedSelectorOutput
            ? {
                selector_model: "grpo-policy",
                candidate_models: this.adoptedSelectorOutput.candidates.map(
                  (candidate) => ({
                    model: candidate.model,
                    thinking_level: candidate.reasoningEffort,
                  }),
                ),
                reason: this.adoptedSelectorOutput.reason,
                output_text: this.adoptedSelectorOutput.outputText,
              }
            : null,
        decision_details: {
          strategy: a.strategy,
          selected_reasoning_effort: reasoningBucket,
          next_reasoning_effort: nextReasoningEffort,
          ...(this.providerAttempts.length > 0
            ? { provider_attempts: this.providerAttempts }
            : {}),
          ...this.decisionDetails,
          ...(a.pruning ? { candidate_pruning: a.pruning } : {}),
        },
        // Model/provider/key source and latency live at the top level (they
        // apply to failures with no provider call too).
        provider_call:
          selectedModel && selectedProvider && (completedOutput || providerMessage)
            ? {
                stop_reason: stopReason,
                usage: usageIngest(usage, pricingKnown === true),
              }
            : null,
        benchmark_replay_cost_usd: billingPayload.benchmark_replay_cost_usd,
        benchmark_replay_raw_cost_usd:
          usage === null ? null : costString(benchmarkReplay.rawCostUsd),
        benchmark_model_id: benchmarkReplay.model,
        benchmark_estimator_version: benchmarkReplay.estimatorVersion,
        benchmark_input_rate_usd_per_mtok:
          costString(benchmarkReplay.price?.input ?? null),
        benchmark_cached_input_rate_usd_per_mtok:
          costString(benchmarkReplay.price?.cached_input ?? null),
        benchmark_cache_write_rate_usd_per_mtok:
          costString(benchmarkReplay.price?.cache_write ?? null),
        benchmark_output_rate_usd_per_mtok:
          costString(benchmarkReplay.price?.output ?? null),
        tool_skill_events: toolSkillEvents({
          routerId: a.routerId,
          request: a.interaction,
          output: completedOutput ?? undefined,
          harnessConversationIdentity: a.harnessConversationIdentity,
          zdr: a.zdr,
        }),
        tool_result_observations: toolResultObservations({
          routerId: a.routerId,
          request: a.interaction,
          zdr: a.zdr,
        }),
        prefix_entry: prefixEntry,
        touched_prefix_hash: touchedHash,
      };

      gatewayPlatform().recordRequest({
        router: requestRecordRouter(a.credentials),
        candidates: a.candidates.map(({ model, reasoningEffort }) => ({ model, reasoningEffort })),
        ...(a.sessionPinKey === undefined ? {} : { sessionPinKey: a.sessionPinKey }),
        row: ingestPayload,
        summary: {
          request_id: a.requestId,
          organization_id: a.credentials.organization_id,
          router_id: a.routerId,
          api_key_id: a.credentials.api_key_id,
          source_protocol: a.interaction.sourceProtocol,
          request_kind: observability.requestKind,
          status: outcome.status,
          error_code: outcome.errorCode ?? null,
          stream: a.interaction.stream,
          zdr: a.zdr,
          strategy: a.strategy,
          selected_model: selectedModel,
          selected_provider: selectedProvider,
          selected_reasoning_effort: reasoningBucket,
          next_model: nextModel,
          next_reasoning_effort: nextReasoningEffort,
          provider_key_source: keySource,
          message_count: observability.messageCount,
          tool_count: observability.metadata.declared_tool_counts.total,
          candidate_count: a.costEstimates.length,
          provider_attempt_count: this.providerAttempts.length,
          prefix_match_depth: a.identityMatchDepth ?? a.hits.deepest?.depth ?? null,
          prefix_warm_tokens: selectedEstimate?.warm_tokens ?? null,
          selector_latency_ms: selectorTrace?.latencyMs ?? null,
          provider_latency_ms: outcome.providerLatencyMs ?? null,
          total_latency_ms: Date.now() - a.startedMs,
          input_tokens: tokenCount(usage?.input),
          cache_read_tokens: tokenCount(usage?.cacheRead),
          cache_write_tokens: tokenCount(usage?.cacheWrite),
          output_tokens: tokenCount(usage?.output),
          total_tokens: tokenCount(usage?.totalTokens),
          total_cost_usd: costSource === null || !isRecord(usage?.cost)
            ? null
            : finiteNumber(usage.cost.total),
          cost_source: costSource,
          pricing_known: pricingKnown,
        },
        distinctId:
          a.credentials.attributed_user_id ??
          a.credentials.api_key_id ??
          a.credentials.organization_id,
        interaction: a.interaction,
        isNewConversation: a.isNewConversation,
        zdr: a.zdr,
        harnessConversationIdentity: a.harnessConversationIdentity,
        tags: a.tags,
      });
    } catch (error) {
      console.error("routing report assembly failed", error);
      captureOperationalError(error, {
        code: "routing_report_assembly_failed",
        requestId: this.args.requestId,
        routerId: this.args.routerId,
      });
    }
  }
}

function billingTerminalOutcome(outcome: ReportOutcome): RoutingBillingTerminalOutcome {
  if (outcome.status === "completed") return "completed";
  if (outcome.status === "aborted") {
    return outcome.billingOutcome;
  }
  return "provider_failed";
}

function providerMessageForOutcome(
  outcome: ReportOutcome,
): Record<string, unknown> | null {
  return outcome.status === "selector_error"
    ? null
    : outcome.providerMessage ?? null;
}

function reportOutcome(args: ReportableProviderOutcome): ReportOutcome {
  if (args.status === "customer_canceled") {
    return {
      status: "aborted",
      errorCode: "client_disconnected",
      providerLatencyMs: args.providerLatencyMs,
      providerExecution: args.execution,
      providerMessage: args.message,
      responseBody: args.responseBody,
      billingOutcome: "customer_canceled",
      partialOutput: args.partialOutput ?? null,
    };
  }
  if (args.status === "provider_error") {
    return {
      status: "provider_error",
      errorCode: subscriptionUsageLimitFromFailure(args.message) === null
        ? "provider_execution_failed"
        : "subscription_usage_limit",
      errorMessage:
        typeof args.message.errorMessage === "string"
          ? args.message.errorMessage
          : undefined,
      providerMessage: args.message,
      providerLatencyMs: args.providerLatencyMs,
      providerExecution: args.execution,
    };
  }
  return {
    status: "completed",
    interactionOutput: args.output,
    providerMessage: args.message,
    responseBody: args.responseBody,
    providerLatencyMs: args.providerLatencyMs,
    providerExecution: args.execution,
  };
}

function selectorIngest(args: {
  trace: SelectorTrace;
  reason: string | null;
  outputAccepted: boolean;
  pricingKnown: boolean;
}): Record<string, unknown> {
  const { trace } = args;
  return {
    selector_model: trace.selectorModel,
    candidate_models: trace.selectorInput.candidate_pairs.map((candidate) => ({
      model: candidate.model,
      thinking_level: candidate.thinking_level,
    })),
    evals: trace.selectorInput.imported_evals.flatMap((card) => {
      const id = card.id;
      const name = card.name;
      return typeof id === "string" && typeof name === "string" ? [{ id, name }] : [];
    }),
    cost_estimates: trace.selectorInput.cost_estimates,
    previous_model: trace.selectorInput.previous_decision?.model ?? null,
    reason: args.reason,
    prompt_json: JSON.stringify(trace.selectorRequest),
    output_text: selectorOutputText(trace, args.outputAccepted),
    usage: usageIngest(trace.usage, args.pricingKnown),
  };
}

function selectorOutputText(trace: SelectorTrace, accepted: boolean): string {
  const rejected = trace.rejectedOutputTexts ?? [];
  if (rejected.length === 0) return trace.outputText;
  return JSON.stringify({
    schema_version: 1,
    kind: "selector_output_attempts",
    attempts: [
      ...rejected.map((outputText) => ({
        outcome: "rejected",
        output_text: outputText,
      })),
      {
        outcome: accepted ? "accepted" : "rejected",
        output_text: trace.outputText,
      },
    ],
  });
}

// Normalized usage -> RoutingUsageIngest. Costs ride along as strings so the
// backend's Decimal columns parse them exactly; pricing_known=false marks
// catalog-missing models whose normalized cost would otherwise read as $0.
function usageIngest(
  usage: InteractionUsage | Record<string, unknown> | null,
  pricingKnown: boolean
): Record<string, unknown> | null {
  if (!usage) return null;
  const cost = isRecord(usage.cost) ? usage.cost : {};
  return {
    input_tokens: tokenCount(usage.input),
    cache_read_tokens: tokenCount(usage.cacheRead),
    cache_write_tokens: tokenCount(usage.cacheWrite),
    output_tokens: tokenCount(usage.output),
    total_tokens: tokenCount(usage.totalTokens),
    input_cost_usd: pricingKnown ? costString(cost.input) : null,
    cache_read_cost_usd: pricingKnown ? costString(cost.cacheRead) : null,
    cache_write_cost_usd: pricingKnown ? costString(cost.cacheWrite) : null,
    output_cost_usd: pricingKnown ? costString(cost.output) : null,
    total_cost_usd: pricingKnown ? costString(cost.total) : null,
    pricing_known: pricingKnown,
  };
}

function requestRecordRouter(router: ResolvedRouter): RequestRecordRouter {
  return {
    enabledModels: [...router.enabled_models],
    thinkingLevels: Object.fromEntries(
      router.enabled_models.map((model) => [
        model,
        [
          ...(router.model_thinking_levels?.[model]
            ?? router.model_configs?.[model]?.supported_thinking_levels
            ?? []),
        ],
      ]),
    ),
    defaultThinkingLevels: Object.fromEntries(
      router.enabled_models.flatMap((model) => {
        const level = router.model_configs?.[model]?.default_thinking_level;
        return level ? [[model, level]] : [];
      }),
    ),
    strict: router.strict === true,
    speculativeRouting: router.speculative_routing === true,
    sessionPinning: router.session_pinning === true,
  };
}
