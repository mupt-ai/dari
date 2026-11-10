import type { ReasoningEffort, RoutingDecision } from "./types.js";
import type {
  RouterContinuationState,
  RouterProviderIdentity,
} from "./continuation_state.js";
import type { RouterFrameworkError } from "./framework_error.js";

export type { RouterContinuationState, RouterProviderIdentity } from "./continuation_state.js";

export type RouterProtocol = "openai_chat_completions" | "anthropic_messages";

export type RouterTextContent = {
  type: "text";
  text: string;
};

export type RouterImageContent = {
  type: "image";
  url: string;
  detail?: "auto" | "low" | "high";
};

export type RouterContent = RouterTextContent | RouterImageContent;

export type RouterMessageItem = {
  type: "message";
  role: "system" | "developer" | "user" | "assistant";
  content: RouterContent[];
};

export type RouterToolCallItem = {
  type: "tool_call";
  id: string;
  name: string;
  arguments: string | Record<string, unknown>;
};

export type RouterToolResultItem = {
  type: "tool_result";
  toolCallId: string;
  content: RouterContent[];
  isError?: boolean;
};

// Provider-hosted tools (for example OpenAI/Anthropic web search). These are
// replayable provider-native calls, not user-defined function tools.
export type RouterHostedToolCallStatus =
  | "in_progress"
  | "searching"
  | "completed"
  | "incomplete"
  | "failed";

export function isRouterHostedToolCallStatus(
  value: unknown,
): value is RouterHostedToolCallStatus {
  return value === "in_progress" || value === "searching" || value === "completed" ||
    value === "incomplete" || value === "failed";
}

export type RouterHostedToolCallItem = {
  type: "hosted_tool_call";
  id: string;
  tool: "web_search";
  providerType: "web_search_call";
  status?: RouterHostedToolCallStatus;
  payload: Record<string, unknown>;
  source?: RouterProviderIdentity;
};

// Prior-turn reasoning/thinking carried across turns. The framework does not
// translate encrypted blobs between providers; it carries them tagged with
// their source provider identity and executors drop/refuse cross-provider
// continuations (see compatibleContinuation).
export type RouterReasoningItem = {
  type: "reasoning";
  id?: string;
  summary?: string[];
  content: string[];
  source?: RouterProviderIdentity;
  continuation?: RouterContinuationState;
};

export type RouterInputItem =
  | RouterMessageItem
  | RouterToolCallItem
  | RouterToolResultItem
  | RouterReasoningItem
  | RouterHostedToolCallItem;

export type RouterTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  strict?: boolean;
};

export type RouterToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "tool"; name: string };

export type RouterResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      name: string;
      schema: Record<string, unknown>;
      description?: string;
      strict?: boolean;
    };

export type RouterRequest = {
  protocol: RouterProtocol;
  requestedModel: string;
  items: RouterInputItem[];
  tools: RouterTool[];
  toolChoice?: RouterToolChoice;
  parallelToolCalls?: boolean;
  generation: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stop?: string | string[];
  };
  reasoning?: {
    effort?: ReasoningEffort;
    enabled?: boolean;
    budgetTokens?: number;
  };
  responseFormat?: RouterResponseFormat;
  cacheKey?: string;
  stream: boolean;
  metadata?: Record<string, unknown>;
  user?: string;
};

export type RouterModelCapabilities = {
  imageInput?: boolean;
  toolUse?: boolean;
  structuredOutput?: boolean;
  streaming?: boolean;
};

export type RouterModel<Metadata = unknown> = {
  id: string;
  executor?: string;
  provider?: string;
  providerModelId?: string;
  api?: string;
  reasoningEfforts?: readonly ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
  capabilities?: RouterModelCapabilities;
  metadata?: Metadata;
};

export type RouterCandidate<Metadata = unknown> = {
  id: string;
  executor: string;
  provider: string;
  providerModelId?: string;
  api: string;
  reasoningEfforts: readonly ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
  capabilities: Required<RouterModelCapabilities>;
  metadata?: Metadata;
};

export type RoutingPolicyInput<Metadata = unknown> = {
  request: RouterRequest;
  candidates: readonly RouterCandidate<Metadata>[];
  signal: AbortSignal;
};

export type RoutingPolicyDecision = {
  model: string;
  reasoningEffort?: ReasoningEffort;
  reason?: string;
  // Turns the policy commits to this selection after the current one. When
  // set, createRouter serves the same model for subsequent requests sharing
  // the same cacheKey without calling the policy again.
  leaseTurnsRemaining?: number;
  details?: unknown;
};

export type RoutingPolicy<Metadata = unknown> =
  | ((input: RoutingPolicyInput<Metadata>) => RoutingPolicyDecision | Promise<RoutingPolicyDecision>)
  | {
      select(input: RoutingPolicyInput<Metadata>): RoutingPolicyDecision | Promise<RoutingPolicyDecision>;
    };

// Where a served decision came from. "fallback" replaces the primary's source
// after a successful executor fallback.
export type RouterDecisionSource =
  | "policy"
  | "explicit_model"
  | "strict_model"
  | "auxiliary"
  | "session_pin"
  | "lease_hold"
  | "prefetched_lease"
  | "speculative"
  | "fallback";

export type RouterSelection<Metadata = unknown> = {
  decision: RoutingDecision;
  candidates: readonly RouterCandidate<Metadata>[];
  source: RouterDecisionSource;
  policyDetails?: unknown;
};

export type RouterUsage = {
  // Non-cached input tokens. Cache reads/writes are separate counts, not
  // subsets of inputTokens; protocol serializers fold them per each wire
  // format's own semantics.
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
};

export type RouterFinishReason = "stop" | "length" | "tool_calls";

export type RouterOutputText = {
  type: "text";
  text: string;
};

export type RouterOutputToolCall = {
  type: "tool_call";
  id: string;
  name: string;
  arguments: string | Record<string, unknown>;
};

export type RouterOutputReasoning = {
  type: "reasoning";
  // Readable thinking text (plaintext summary or content). Empty for purely
  // redacted thinking, where only the encrypted continuation is available.
  text: string;
  redacted?: boolean;
  source?: RouterProviderIdentity;
  continuation?: RouterContinuationState;
};

export type RouterOutputHostedToolCall = {
  type: "hosted_tool_call";
  id: string;
  tool: "web_search";
  providerType: "web_search_call";
  status?: RouterHostedToolCallStatus;
  payload: Record<string, unknown>;
  source?: RouterProviderIdentity;
};

export type RouterOutputItem =
  | RouterOutputText
  | RouterOutputToolCall
  | RouterOutputReasoning
  | RouterOutputHostedToolCall;

export type RouterCompletion = {
  id?: string;
  createdAtMs?: number;
  content: RouterOutputItem[];
  finishReason: RouterFinishReason;
  usage?: RouterUsage;
};

export type RouterStreamEvent =
  | { type: "text_delta"; index: number; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; delta: string }
  | { type: "tool_call_end"; index: number }
  | { type: "reasoning_delta"; index: number; delta: string }
  // Hosted tool executions (provider-run web search) arrive complete rather
  // than incrementally: one event carries the full replayable item.
  | (RouterOutputHostedToolCall & { index: number })
  | {
      type: "reasoning_end";
      index: number;
      redacted?: boolean;
      // Provider identity and stable item id for signing plain (no-
      // continuation) reasoning with a portable envelope on replayable wire
      // formats.
      source?: RouterProviderIdentity;
      itemId?: string;
      continuation?: import("./continuation_state.js").ProviderContinuationState;
    }
  | { type: "finish"; finishReason: RouterFinishReason; usage?: RouterUsage };

export type RouterExecutorResult =
  | { type: "complete"; output: RouterCompletion }
  | { type: "stream"; events: AsyncIterable<RouterStreamEvent> };

export type RouterExecutorInput<Metadata = unknown> = {
  request: RouterRequest;
  model: RouterCandidate<Metadata>;
  decision: RoutingDecision;
  signal: AbortSignal;
};

export type RouterExecutor<Metadata = unknown> = {
  execute(
    input: RouterExecutorInput<Metadata>,
  ): RouterExecutorResult | Promise<RouterExecutorResult>;
};

export type CreateRouterOptions<Metadata = unknown> = {
  models: readonly RouterModel<Metadata>[];
  policy: RoutingPolicy<Metadata>;
  // Executor used by models that do not name one explicitly.
  executor?: RouterExecutor<Metadata>;
  // Named executors for models that need a per-model override.
  executors?: Readonly<Record<string, RouterExecutor<Metadata>>>;
  generateId?: () => string;
  // Pluggable lease store. When omitted, createRouter uses an in-memory
  // store with a 30-minute TTL. Inject a persistent store to share leases
  // across processes (e.g. the managed backend's DB-backed leases).
  leaseStore?: LeaseStore;
  // Lifecycle hooks for telemetry, billing, and logging. All hooks are
  // optional and fire-and-forget: createRouter never awaits them on the
  // hot path.
  hooks?: RouterHooks<Metadata>;
  // Fallback configuration. When the primary executor fails, createRouter
  // retries on a fallback model if one is available and eligible.
  fallback?: RouterFallbackConfig;
  // Speculative routing (default: false). For requests with a cacheKey, the
  // router serves the conversation's previous decision immediately and runs
  // the policy in the background; the policy's answer serves the next turn.
  // The first turn, and any turn whose previous model is ineligible, waits
  // for the policy. A failed background selection keeps the previous model.
  // Committed leases take precedence. The previous decision is kept in the
  // lease store under the key `speculation:<cacheKey>`.
  speculative?: boolean;
  // Strict routers serve only requests naming `dari/model/<id>`, never the
  // policy. Any router serves such a request as named.
  strict?: boolean;
  // Auxiliary requests (a harness's background work, such as titles or
  // summaries) are served outside conversation routing: when this returns a
  // decision, it is served without the policy, session pins, leases, or
  // speculation, and nothing is recorded for later turns.
  auxiliary?: (
    input: RoutingPolicyInput<Metadata>,
  ) => RoutingPolicyDecision | undefined | Promise<RoutingPolicyDecision | undefined>;
  // Session pinning: requests with a key route once and keep that model and
  // reasoning level for the session, bypassing leases and speculation. Pins
  // are kept in the lease store under `pin:<key>`.
  sessionPinKey?: (request: RouterRequest) => string | undefined;
  // Lease prefetch: when a committed lease has this many turns left, select
  // its successor in the background; the next turn after the lease ends
  // serves it without waiting for the policy. Kept under `pending:<cacheKey>`.
  leasePrefetchTurns?: number;
};

export type Router<Metadata = unknown> = {
  readonly models: readonly RouterCandidate<Metadata>[];
  // Authoritative serving selection. Applies and commits leases and fires
  // onSelection after a successful selection.
  select(request: RouterRequest, signal?: AbortSignal): Promise<RouterSelection<Metadata>>;
  // Stateless policy inspection. Does not read or mutate leases or fire hooks.
  evaluatePolicy(request: RouterRequest, signal?: AbortSignal): Promise<RouterSelection<Metadata>>;
  fetch(request: Request): Promise<Response>;
};

// A lease commitment: the router serves the same model for subsequent
// requests sharing the cacheKey without calling the policy again. Turns are
// the conversation's completed assistant turns, counted from the request's
// history, so a lease holds by conversation position: retries do not use a
// turn, and the position survives restarts and other router instances.
export type RouterLease = {
  model: string;
  reasoningEffort: ReasoningEffort;
  // The conversation turn the value was recorded at.
  startTurn: number;
  // A committed lease holds through turn startTurn + turnsRemaining; a
  // prefetched successor commits this many turns when adopted. Unused by
  // pins and speculative previous decisions.
  turnsRemaining: number;
  expiresAt: number;
};

// Pluggable lease storage. The default in-memory implementation has a
// 30-minute TTL; inject a persistent store for cross-process leases. Methods
// may be synchronous or return promises (DB-backed stores). Read-modify-write
// atomicity under concurrent requests is the store's responsibility. Every
// call is advisory: a store that throws or rejects never fails the request.
export interface LeaseStore {
  get(cacheKey: string): RouterLease | undefined | Promise<RouterLease | undefined>;
  set(cacheKey: string, lease: RouterLease): void | Promise<void>;
  delete(cacheKey: string): void | Promise<void>;
  // Remove all expired leases. Called on every cacheKey-bearing selection.
  pruneExpired(nowMs: number): void | Promise<void>;
}

// onSelection observes the policy's decision before execution. The other
// hooks receive the selection actually served: after a successful fallback
// its decision names the fallback model, states the fallback in its reason,
// and carries no leaseTurnsRemaining (the primary's lease was released).
export type RouterHookResult = void | Promise<void>;

export type RouterHooks<Metadata = unknown> = {
  // Fires after a successful selection (including lease short-circuits).
  onSelection?(
    selection: RouterSelection<Metadata>,
    request: RouterRequest,
  ): RouterHookResult;
  // Fires after a successful completion (non-streaming). For streaming
  // completions, use onStreamClose which fires when the stream finishes.
  onCompletion?(
    completion: RouterCompletion,
    selection: RouterSelection<Metadata>,
  ): RouterHookResult;
  // Fires when a stream finishes successfully or with an error. The
  // completion deliberately carries content: [] — the router does not buffer
  // streamed output; only finishReason and usage are populated.
  onStreamClose?(
    completion: RouterCompletion | null,
    selection: RouterSelection<Metadata>,
    error: RouterFrameworkError | null,
  ): RouterHookResult;
  // Fires when the executor or stream fails.
  onError?(
    error: RouterFrameworkError,
    selection: RouterSelection<Metadata>,
  ): RouterHookResult;
  // Fires when a background selection settles: a speculative turn's
  // selection for the next turn, or a lease's prefetched successor.
  onSpeculativeSelection?(
    selection: RouterSelection<Metadata>,
    request: RouterRequest,
  ): RouterHookResult;
};

// Executor-failure fallback for createRouter. Distinct from the phased API's
// RouteFallbackConfig, which defaults both flags ON; here everything defaults OFF.
export type RouterFallbackConfig = {
  // Whether fallback is enabled (default: false).
  enabled?: boolean;
  // Require the fallback model to be from a different provider (default: false).
  requiresDifferentProvider?: boolean;
};
