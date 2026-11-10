import type {
  Provider,
  ReasoningEffort,
  RoutingStrategy,
} from "@mupt-ai/dari-router/policy-engine";
import type { HarnessConversationIdentity } from "../runtime/harness_identity/index.js";
import type { InteractionRequest, SourceProtocol } from "../interaction/types.js";
import type { SubscriptionUsageLimit } from "../providers/subscription_limits.js";
import type {
  ClientHarness,
  ProviderCredential,
  ProviderKeySource,
  ResolvedRouter,
} from "../types.js";

/**
 * Everything the gateway runtime needs from the deployment around it: router
 * configuration and credentials, durable routing state, accounting sinks, and
 * error reporting. The self-hosted gateway implements it with a local config
 * file and SQLite (`self_host/`); other deployments supply their own.
 *
 * Methods may throw. Call sites that must not fail a served request catch,
 * log, and continue.
 */
export type GatewayPlatform = {
  /**
   * Authenticate the request's key and return the router it may use, with
   * decrypted provider credentials and the prefix-cache evidence matching
   * `prefixHashes`. Throws HttpError(401) for an unknown key.
   */
  resolveRouter(request: ResolveRouterRequest): Promise<ResolvedRouter>;
  /**
   * Optional. Supply the credential for one enabled model of this request,
   * consulted after `resolveRouter` and before its provider keys (for the
   * self-hosted gateway, its environment keys), so an embedder can serve
   * per-tenant keys from its own store. Undefined keeps the resolved key. A
   * credential with `subscription` serves the model on that plan, even on a
   * strict router; a plan that cannot serve the model for this client (see
   * SubscriptionKind) is ignored.
   */
  resolveProviderCredential?(
    request: ProviderCredentialRequest,
  ): Promise<ProviderCredential | undefined>;
  /** Persist one completed turn's prefix entry and/or refresh a read entry. */
  writePrefixState(write: PrefixStateWrite): Promise<void>;
  /** Set or clear a conversation's prefetched routing lease. */
  writePendingLease(write: PendingLeaseWrite): Promise<void>;
  /** The pair a session pinned on a session-pinning router, or null. */
  readSessionPin(request: SessionPinKey): Promise<SessionPin | null>;
  /** Pin a session to a pair, replacing any earlier pin. */
  writeSessionPin(write: SessionPinKey & SessionPin): Promise<void>;
  /**
   * Hold an exhausted personal subscription until it resets. Resolves whether
   * another connected subscription for the same provider can serve a retry.
   */
  markSubscriptionUnavailable(hold: SubscriptionHold): Promise<boolean>;
  /**
   * Account one call served on a platform-managed provider key. Only reached
   * when `resolveRouter` reports a "managed" key source.
   */
  recordUsage(usage: Record<string, unknown>): Promise<void>;
  /** Receive the finished request's log row. Must not throw. */
  recordRequest(record: RequestRecord): void;
  captureRequestError(error: unknown, context: RequestErrorContext): void;
  captureOperationalError(error: unknown, context: OperationalErrorContext): void;
};

export type ResolveRouterRequest = {
  routerId: string;
  apiKey: string;
  prefixHashes?: string[];
  conversationId?: string;
  includePublicEvalCatalog?: boolean;
  clientHarness?: ClientHarness;
};

export type ProviderCredentialRequest = {
  provider: Provider;
  model: string;
  routerId: string;
  organizationId: string;
  // The gateway key the request authenticated with.
  apiKey: string;
  clientHarness?: ClientHarness;
};

export type PrefixStateWrite = {
  organization_id: string;
  router_id: string;
  received_at: string;
  zdr: boolean;
  prefix_entry: Record<string, unknown> | null;
  touched_prefix_hash: string | null;
};

export type PendingLeaseWrite = {
  router_id: string;
  conversation_id: string;
  // Conversation depth this write was decided at; writes decided shallower
  // than the last applied one are fenced out.
  decided_at_depth: number;
  pending_lease: {
    model: string;
    reasoning_effort: string;
    turns: number;
    reason: string;
    output_text: string | null;
  } | null;
};

// A main agent and each of its subagents have their own pin key.
export type SessionPinKey = {
  routerId: string;
  pinKey: string;
};

export type SessionPin = {
  model: string;
  reasoningEffort: ReasoningEffort;
};

export type SubscriptionHold = {
  userId: string;
  credentialId: string | undefined;
  limit: SubscriptionUsageLimit;
};

export type RequestRecord = {
  // The full request log row: routing decision, usage, costs, and (outside
  // ZDR) request and response content.
  row: Record<string, unknown>;
  // A content-free summary of the same request.
  summary: RequestSummary;
  distinctId: string;
  interaction: InteractionRequest;
  isNewConversation: boolean;
  zdr: boolean;
  harnessConversationIdentity?: HarnessConversationIdentity;
  // Parsed from the request's X-Dari-Tags header; empty when absent.
  tags: RequestTags;
  // The router's non-secret routing settings, for embedders that compare or
  // replay routing decisions.
  router: RequestRecordRouter;
  // The model and reasoning pairs this request could be routed to, after
  // capability, custom-rule, and cost pruning.
  candidates: Array<{ model: string; reasoningEffort: ReasoningEffort }>;
  // The session pin key this request routed under, when the router pins
  // sessions and the request was pinnable (not strict, explicit, or
  // background). Each harness subagent has its own key.
  sessionPinKey?: string;
};

export type RequestRecordRouter = {
  enabledModels: string[];
  // Each enabled model's selectable reasoning levels: the router's
  // configured levels, else the model's supported levels.
  thinkingLevels: Record<string, ReasoningEffort[]>;
  // The level a requested dari/model/<id> uses when the request sets none.
  defaultThinkingLevels: Record<string, ReasoningEffort>;
  strict: boolean;
  speculativeRouting: boolean;
  sessionPinning: boolean;
};

// Caller-supplied attribution labels (run, trial, setting), opaque to the
// gateway.
export type RequestTags = Record<string, string>;

export type RequestSummary = {
  request_id: string;
  organization_id: string;
  router_id: string;
  api_key_id: string | null;
  source_protocol: SourceProtocol;
  request_kind: "user_message" | "tool_continuation" | "other";
  status: "completed" | "provider_error" | "selector_error" | "aborted";
  error_code: string | null;
  stream: boolean;
  zdr: boolean;
  strategy: RoutingStrategy;
  selected_model: string | null;
  selected_provider: Provider | null;
  selected_reasoning_effort: ReasoningEffort | null;
  next_model: string | null;
  next_reasoning_effort: ReasoningEffort | null;
  provider_key_source: ProviderKeySource | null;
  message_count: number;
  tool_count: number;
  candidate_count: number;
  provider_attempt_count: number;
  prefix_match_depth: number | null;
  prefix_warm_tokens: number | null;
  selector_latency_ms: number | null;
  provider_latency_ms: number | null;
  total_latency_ms: number;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  // Provider-reported cost when the provider returns one (OpenRouter, Vercel
  // AI Gateway), otherwise priced from the model's rates when known.
  total_cost_usd: number | null;
  cost_source: "provider" | "pricing" | null;
  pricing_known: boolean | null;
};

export type RequestErrorContext = {
  request: Request;
  routerId: string;
  requestId?: string;
  sourceProtocol: SourceProtocol | "openai_models" | "anthropic_models";
  status: number;
};

export type OperationalErrorCode =
  | "background_drain_timeout"
  | "billing_usage_report_failed"
  | "routing_report_assembly_failed"
  | "routing_report_barrier_failed"
  | "server_force_stop_failed"
  | "session_pin_write_failed"
  | "stream_report_finalization_failed"
  | "subscription_unavailable_ingest_failed";

export type OperationalErrorContext = {
  code: OperationalErrorCode;
  requestId?: string;
  routerId?: string;
};

let bound: GatewayPlatform | null = null;

/** Bind the platform every request uses. The latest binding wins. */
export function bindGatewayPlatform(platform: GatewayPlatform): void {
  bound = platform;
}

export function gatewayPlatform(): GatewayPlatform {
  if (bound === null) {
    throw new Error("No gateway platform is bound; create the request handler first.");
  }
  return bound;
}
