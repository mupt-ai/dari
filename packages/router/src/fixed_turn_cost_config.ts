// Loop horizons every candidate is projected at, ascending. These match the
// lease lengths the selector can commit to, so every option is priced at
// exactly the horizon its action would hold for — the longer horizons are
// where cache behavior and output pricing separate models that look alike on
// a single turn.
export const FIXED_TURN_COST_PROJECTED_TURNS = [5, 10, 30] as const;

// Turn commitments the selector may choose between: how many turns the routed
// model keeps serving before the router reconsiders. Committing amortizes the
// cold start it pays on the first turn across the warm turns that follow.
export const SELECTOR_LEASE_TURNS = [5, 10, 30] as const;

// How many turns before a lease expires the next decision is prefetched, so
// the switch adds no latency. Training captures the policy's observation at
// the same point so its information set matches serving.
export const LEASE_DECISION_TURN_LAG = 2;

// The horizon used wherever a single scalar cost is needed rather than the
// whole curve, notably warm-incumbent pruning.
export const FIXED_TURN_COST_COMPARISON_TURNS = 10;

export const FIXED_TURN_CACHE_HIT_PROBABILITY = {
  openai: 0.95,
  anthropic: 0.99,
  fireworks: 0.88,
  // 48/50 follow-up requests hit in the July 2026 25-agent Pi benchmark.
  // First turns are excluded because fixed-turn turn one uses live warmth.
  meta: 0.96,
  // Provisional: 9/10 large-prefix follow-ups reused the user prefix in the
  // September 16, 2026 native Grok 4.6 probe (low effort, short intervals).
  xai: 0.90,
} as const;

// Tokens an agent turn adds to the next prompt (its reply plus the tool
// results it triggered) before a conversation has enough history to measure
// its own rate. October 2026 Sentry agent runs grew 600-2,000 tokens per turn,
// two to five times the reply alone.
export const DEFAULT_PROMPT_GROWTH_TOKENS_PER_TURN = 1000;

// Recorded turns a conversation needs before its own prompt growth replaces
// the default.
export const MIN_TURNS_FOR_OBSERVED_PROMPT_GROWTH = 3;
