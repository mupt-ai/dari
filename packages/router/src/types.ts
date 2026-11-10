export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Provider ids are the lowercase prefix of a `provider/native-model-id` model
// string, e.g. "openai" in "openai/gpt-5.6-luna".
export type Provider = string;

export type ChatMessage = {
  role: string;
  content?: string | Array<Record<string, unknown>> | null;
  tool_call_id?: string;
  tool_calls?: Array<Record<string, unknown>>;
  reasoning_content?: string;
  reasoning?: string;
  reasoning_text?: string;
  reasoning_details?: Array<Record<string, unknown>>;
};

export const REASONING_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORTS.some((effort) => effort === value);
}

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        schema: Record<string, unknown>;
        strict?: boolean;
        description?: string;
      };
    };

export type ChatCompletionRequest = {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  source_protocol?: "anthropic_messages" | "openai_chat" | "openai_responses";
  prompt_cache_key?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | Record<string, unknown>;
  parallel_tool_calls?: boolean;
  response_format?: ResponseFormat;
  reasoning_effort?: ReasoningEffort;
  metadata?: Record<string, unknown>;
  user?: string;
};

export type RoutingCandidate = {
  model: string;
  reasoningEffort: ReasoningEffort;
};

export function routingCandidateKey(candidate: RoutingCandidate): string {
  return `${candidate.model}\u0000${candidate.reasoningEffort}`;
}

export function sameRoutingCandidate(
  left: RoutingCandidate,
  right: RoutingCandidate,
): boolean {
  return left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}

export type RoutingDecision = {
  selectedModel: string;
  reasoningEffort: ReasoningEffort;
  reason: string;
  // Turns still committed to this selection after the current one, when a
  // lease-aware policy made (or is holding) a commitment. The serving layer
  // persists the countdown on the conversation's prefix chain.
  leaseTurnsRemaining?: number;
};

export type RouterEvalScore = {
  model_id: string;
  score: number;
  notes?: string | null;
  thinking_level?: ReasoningEffort | null;
  // Model API spend in USD for one task of this benchmark, when published.
  cost_per_task_usd?: number | null;
};

export type RouterEval = {
  id: string;
  name: string;
  description?: string | null;
  min_score: number;
  max_score: number;
  scores: RouterEvalScore[];
};

// One stored prefix entry for a conversation chain, as resolved by the
// host's prefix-hit storage. The core never persists these; it only consumes
// them as explicit input to cost estimation and conversation-identity
// recovery. Hosts may resolve entries past the cache-warmth window; `updated_at`
// is what separates the warm ones from the identity-only ones.
export type RouterPrefixHit = {
  hash: string;
  // Client-durable hash tier (no reasoning payloads, item ids, or
  // provider-specific canonicalization). Matches the host's loose chain for
  // conversation identity even when the client mutated its echo. Null on
  // entries stored before the loose tier existed.
  loose_hash?: string | null;
  conversation_id: string;
  model: string;
  // Execution provider that wrote this cache entry. Providerless legacy rows
  // are warm only when their model id itself carries the same provider prefix.
  provider?: string | null;
  // Selector recommendation to use for the next turn. The serving model
  // remains separate because it owns this prefix's provider-cache metadata.
  next_model?: string | null;
  next_reasoning_effort?: ReasoningEffort | null;
  message_depth: number;
  // Candidate-provider-visible block depth. Null/absent on entries written
  // before provider-aware prompt accounting was introduced.
  provider_block_depth?: number | null;
  // Depth of the provider input represented by prompt_tokens. The entry hash
  // may extend through provider output for conversation identity.
  prompt_anchor_depth?: number | null;
  prompt_tokens: number;
  // Running maximum prompt depth of the hypothetical sticky benchmark.
  // Hosts persist this with prefix state so future turns can price the
  // benchmark incrementally without replaying request history.
  benchmark_replay_depth?: number | null;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  tool_choice_fp: string;
  response_format_fp: string;
  // Effective reasoning bucket the serving request ran with ("off" groups
  // omitted/off payloads). Null on entries written before buckets existed.
  reasoning_bucket?: string | null;
  // Turns still committed to next_model/next_reasoning_effort by a lease-aware
  // policy. Positive while a lease holds; absent or null when routing decides
  // per turn.
  lease_turns_remaining?: number | null;
  // Next lease decided ahead of expiry (the serving-side analogue of
  // training's n-lag prefetch). Adopted when the active lease runs out, so the
  // expiry turn pays no decision latency.
  pending_lease_model?: string | null;
  pending_lease_reasoning_effort?: ReasoningEffort | null;
  pending_lease_turns?: number | null;
  pending_lease_reason?: string | null;
  pending_lease_output_text?: string | null;
  reason: string | null;
  updated_at: string;
};

export type RoutingStrategy = "dari" | "custom";

export type CustomRouterRule = {
  // Natural-language condition describing when this rule applies, e.g.
  // "planning and architecture" or "implementation".
  when: string;
  // The enabled model serving matching requests. Null means the router
  // chooses among that model's enabled thinking levels automatically.
  use: string;
  thinking_level?: ReasoningEffort | null;
};

export type CustomRouterConfig = {
  rules: CustomRouterRule[];
  default?: string | null;
  default_thinking_level?: ReasoningEffort | null;
};

export type RouterModelPrice = {
  input: number;
  output: number;
  cached_input?: number | null;
  cache_write?: number | null;
  tiers?: Array<{
    input_tokens_above: number;
    input: number;
    output: number;
    cached_input?: number | null;
    cache_write?: number | null;
  }>;
};

export type PrefixHit = {
  entry: RouterPrefixHit;
  depth: number;
};

export type ChainHits = {
  deepest?: PrefixHit;
  perModel: Map<string, PrefixHit>;
  // Deepest hit per model per reasoning bucket. Effort-keyed provider caches
  // keep one warm partition per effective effort (partitions coexist:
  // A -> B -> A reuses A's still-warm entry), so warm-prefix selection must
  // not let a deeper cross-bucket entry shadow a valid same-bucket one.
  // Entries written before buckets existed live under null.
  perModelBuckets: Map<string, Map<string | null, PrefixHit>>;
};

export type TurnCostProjection = {
  projected_turns: number;
  total_cost_usd: number;
};

export type FixedTurnCostEstimate = {
  output_tokens_per_turn: number;
  assumed_reasoning_effort: ReasoningEffort;
  // Cost of the first turn if this action's cache is cold: what switching to
  // it pays before its prompt prefix is warm. Projections are cumulative and
  // cannot isolate it.
  cold_start_usd: number;
  // Cumulative loop cost at each horizon in FIXED_TURN_COST_PROJECTED_TURNS,
  // ascending by turn count.
  projections: TurnCostProjection[];
};

export type CandidateCostEstimate = {
  model: string;
  reasoning_effort: ReasoningEffort;
  warm_tokens: number;
  est_prompt_tokens: number;
  est_input_cost_usd: number | null;
  output_cost_per_mtok: number | null;
  pricing_known: boolean;
  fixed_turn_cost_estimate: FixedTurnCostEstimate | null;
};

export type PreviousDecision = {
  model: string;
  reasoningEffort: ReasoningEffort;
  reason: string;
};

// Request capabilities that hard-constrain candidate eligibility.
export type HardCapability =
  | "image_input"
  | "structured_output"
  | "openai_hosted_web_search"
  | "reasoning_configuration_update";
