import { expect, test } from "bun:test";

import {
  deriveModelChainHits,
  estimateCandidateCosts,
  turnCostUsdAt,
  type PricingLookup,
} from "../src/cost.js";
import {
  ANTHROPIC_LOOKBACK_BLOCKS,
  CROSS_TOKENIZER_RATIO,
  openAiCachedPrefixTokens,
} from "../src/cache_behavior.js";
import {
  FIXED_TURN_CACHE_HIT_PROBABILITY,
  FIXED_TURN_COST_COMPARISON_TURNS,
  FIXED_TURN_COST_PROJECTED_TURNS,
  SELECTOR_LEASE_TURNS,
} from "../src/fixed_turn_cost_config.js";
import { routingCandidateKey } from "../src/types.js";
import type { ReasoningEffort, RouterPrefixHit } from "../src/types.js";

const TOOL_FP = "t".repeat(64);
const FORMAT_FP = "r".repeat(64);

const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "anthropic/claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "anthropic/claude-opus-4-6": { input: 30, output: 150, cacheRead: 3, cacheWrite: 37.5 },
  "anthropic/claude-fable-5": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  "openai/gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  "openai/gpt-5.6-sol": { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  "openai/gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  "zai-org/GLM-5.2": { input: 1.4, output: 4.4, cacheRead: 0.14, cacheWrite: 0 },
  "fireworks/deepseek-ai/DeepSeek-V4-Pro": { input: 0.435, output: 0.87, cacheRead: 0, cacheWrite: 0 },
  "meta/muse-spark-1.1": { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
};

const pricing: PricingLookup = (model) => PRICING[model] ?? null;

function modelProvider(model: string): string {
  if (model === "zai-org/GLM-5.2") return "fireworks";
  return model.slice(0, model.indexOf("/")).toLowerCase();
}

const OUTPUT_TOKENS: Record<ReasoningEffort, number> = {
  off: 1200,
  minimal: 1400,
  low: 1800,
  medium: 2500,
  high: 4000,
  xhigh: 6500,
  max: 10_000,
};

function hit(overrides: Partial<RouterPrefixHit> = {}): RouterPrefixHit {
  const model = overrides.model ?? "anthropic/claude-sonnet-4-6";
  return {
    hash: "h2",
    conversation_id: "c-1",
    model,
    provider: modelProvider(model),
    message_depth: 2,
    provider_block_depth: 2,
    prompt_tokens: 2000,
    input_tokens: 0,
    cache_read_tokens: 1500,
    cache_write_tokens: 500,
    tool_choice_fp: TOOL_FP,
    response_format_fp: FORMAT_FP,
    reason: "prior turn",
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function sharedChainHits(
  chain: string[],
  hits: RouterPrefixHit[]
) {
  const models = [...new Set(hits.map((entry) => entry.model))];
  return deriveModelChainHits(
    new Map(models.map((model) => [model, chain])),
    hits
  );
}

function estimates(args: {
  hits?: RouterPrefixHit[];
  chain?: string[];
  candidates?: string[];
  incomingProviderBlockCount?: number;
  incomingProviderBlockCountFor?: (model: string) => number;
  newTailChars?: number;
  toolChoiceFp?: string;
  responseFormatFp?: string;
  reasoningEffort?: ReasoningEffort;
  averageOutputTokensByModel?: Readonly<
    Record<string, Partial<Record<ReasoningEffort, number>> | null>
  >;
  executionProvider?: string;
}) {
  const models = args.candidates ?? ["anthropic/claude-sonnet-4-6", "openai/gpt-5.2"];
  const candidates = models.map((model) => ({
    model,
    reasoningEffort: args.reasoningEffort ?? "off",
  }));
  return estimateCandidateCosts({
    candidates,
    hits: sharedChainHits(args.chain ?? ["h1", "h2", "h3"], args.hits ?? [hit()]),
    incomingProviderBlockCountFor:
      args.incomingProviderBlockCountFor
      ?? (() => args.incomingProviderBlockCount ?? 3),
    promptEstimatesByCandidate: new Map(
      candidates.map((candidate) => [
        routingCandidateKey(candidate),
        {
          chars: args.newTailChars ?? 4000,
          reusesStoredPromptTokens: true,
        },
      ]),
    ),
    toolChoiceFp: args.toolChoiceFp ?? TOOL_FP,
    responseFormatFp: args.responseFormatFp ?? FORMAT_FP,
    pricing,
    averageOutputTokensByModel:
      args.averageOutputTokensByModel ??
      Object.fromEntries(models.map((model) => [model, OUTPUT_TOKENS])),
    modelProvider: args.executionProvider
      ? () => args.executionProvider!
      : modelProvider,
  });
}

function expectedOpenAiFixedTurnCost(args: {
  price: { input: number; output: number; cacheRead: number };
  estPromptTokens: number;
  warmTokens: number;
  outputTokens: number;
}): number {
  let expected = 0;
  for (let turn = 1; turn <= FIXED_TURN_COST_COMPARISON_TURNS; turn += 1) {
    const inputTokens = args.estPromptTokens + (turn - 1) * args.outputTokens;
    const outputCost = (args.outputTokens * args.price.output) / 1e6;
    if (turn === 1) {
      expected +=
        (args.warmTokens * args.price.cacheRead) / 1e6 +
        ((inputTokens - args.warmTokens) * args.price.input) / 1e6 +
        outputCost;
      continue;
    }
    const reusablePrefix = args.estPromptTokens + (turn - 2) * args.outputTokens;
    const cachedTokens = openAiCachedPrefixTokens(reusablePrefix);
    if (cachedTokens <= 0) {
      expected += (inputTokens * args.price.input) / 1e6 + outputCost;
      continue;
    }
    const hitCost =
      (cachedTokens * args.price.cacheRead) / 1e6 +
      ((inputTokens - cachedTokens) * args.price.input) / 1e6 +
      outputCost;
    const missCost = (inputTokens * args.price.input) / 1e6 + outputCost;
    const hitProbability = FIXED_TURN_CACHE_HIT_PROBABILITY.openai;
    expected += hitCost * hitProbability + missCost * (1 - hitProbability);
  }
  return expected;
}

test("fixed-turn estimates carry the first turn alone, below every projection", () => {
  const [sonnet, gpt] = estimates({});
  for (const candidate of [sonnet, gpt]) {
    const estimate = candidate.fixed_turn_cost_estimate;
    expect(estimate).not.toBeNull();
    expect(estimate!.cold_start_usd).toBeGreaterThan(0);
    // The first turn is one term of the cumulative loop, so it cannot exceed
    // the shortest projection, and the rest of the loop is what the
    // per-turn average spreads out.
    expect(estimate!.cold_start_usd).toBeLessThan(
      estimate!.projections[0]!.total_cost_usd,
    );
  }
});

test("warm anthropic candidate pays read on prefix and write on tail", () => {
  const [sonnet, gpt] = estimates({});
  // 4000 chars / 4 = 1000 new tokens; prefix 2000 warm.
  expect(sonnet.warm_tokens).toBe(2000);
  expect(sonnet.est_prompt_tokens).toBe(3000);
  expect(sonnet.est_input_cost_usd).toBeCloseTo((2000 * 0.3 + 1000 * 3.75) / 1e6, 10);

  // Foreign-model token counts are not evidence for this provider-visible
  // prompt. The cold candidate reserializes the full prompt as 1000 tokens,
  // then applies the cross-tokenizer safety margin.
  expect(gpt.warm_tokens).toBe(0);
  expect(gpt.est_prompt_tokens).toBe(1000 * CROSS_TOKENIZER_RATIO);
  expect(gpt.est_input_cost_usd).toBeCloseTo(
    (1000 * CROSS_TOKENIZER_RATIO * 1.75) / 1e6,
    10,
  );
  expect(gpt.output_cost_per_mtok).toBe(14);
});

test("anthropic fixed-turn full cache hits do not also pay standard input", () => {
  const [sonnet] = estimates({
    candidates: ["anthropic/claude-sonnet-4-6"],
    hits: [hit({ prompt_tokens: 2000 })],
    chain: ["h2"],
    newTailChars: 0,
    incomingProviderBlockCount: 2,
    reasoningEffort: "off",
  });

  const price = PRICING["anthropic/claude-sonnet-4-6"];
  const outputTokens = OUTPUT_TOKENS.off;
  let expected = 0;
  for (let turn = 1; turn <= FIXED_TURN_COST_COMPARISON_TURNS; turn += 1) {
    const inputTokens = 2000 + (turn - 1) * outputTokens;
    const outputCost = (outputTokens * price.output) / 1e6;
    if (turn === 1) {
      expected += (2000 * price.cacheRead) / 1e6 + outputCost;
      continue;
    }
    const cachedTokens = 2000 + (turn - 2) * outputTokens;
    const hitCost =
      (cachedTokens * price.cacheRead) / 1e6 +
      ((inputTokens - cachedTokens) * price.cacheWrite) / 1e6 +
      outputCost;
    const missCost = (inputTokens * price.cacheWrite) / 1e6 + outputCost;
    const hitProbability = FIXED_TURN_CACHE_HIT_PROBABILITY.anthropic;
    expected += hitCost * hitProbability + missCost * (1 - hitProbability);
  }

  expect(sonnet.est_input_cost_usd).toBeCloseTo((2000 * price.cacheRead) / 1e6, 10);
  expect(turnCostUsdAt(sonnet.fixed_turn_cost_estimate, FIXED_TURN_COST_COMPARISON_TURNS)).toBeCloseTo(expected, 10);
});

test("Bedrock candidates retain their canonical cost families", () => {
  const [openAi] = estimates({
    candidates: ["openai/gpt-5.6-sol"],
    hits: [],
    reasoningEffort: "medium",
    executionProvider: "amazon-bedrock",
  });
  const [anthropic] = estimates({
    candidates: ["anthropic/claude-sonnet-4-6"],
    hits: [],
    reasoningEffort: "medium",
    executionProvider: "amazon-bedrock",
  });

  expect(openAi).toMatchObject({
    pricing_known: true,
    output_cost_per_mtok: 20,
    fixed_turn_cost_estimate: {
      assumed_reasoning_effort: "medium",
      output_tokens_per_turn: OUTPUT_TOKENS.medium,
    },
  });
  expect(anthropic).toMatchObject({
    pricing_known: true,
    output_cost_per_mtok: 15,
    fixed_turn_cost_estimate: {
      assumed_reasoning_effort: "medium",
      output_tokens_per_turn: OUTPUT_TOKENS.medium,
    },
  });
});

test("fixed-turn estimates use reasoning output buckets and include output cost", () => {
  const [low] = estimates({
    candidates: ["openai/gpt-5.2"],
    hits: [hit({ model: "openai/gpt-5.2", prompt_tokens: 2006 })],
    reasoningEffort: "low",
  });
  const [high] = estimates({
    candidates: ["openai/gpt-5.2"],
    hits: [hit({ model: "openai/gpt-5.2", prompt_tokens: 2006 })],
    reasoningEffort: "high",
  });

  expect(low.fixed_turn_cost_estimate).toMatchObject({
    output_tokens_per_turn: 1800,
    assumed_reasoning_effort: "low",
  });
  expect(high.fixed_turn_cost_estimate).toMatchObject({
    output_tokens_per_turn: 4000,
    assumed_reasoning_effort: "high",
  });
  expect(turnCostUsdAt(high.fixed_turn_cost_estimate, FIXED_TURN_COST_COMPARISON_TURNS)).toBeGreaterThan(
    turnCostUsdAt(low.fixed_turn_cost_estimate, FIXED_TURN_COST_COMPARISON_TURNS) ?? 0
  );
  expect(turnCostUsdAt(low.fixed_turn_cost_estimate, FIXED_TURN_COST_COMPARISON_TURNS)).toBeGreaterThan(low.est_input_cost_usd ?? 0);
});

test("projects every configured loop horizon from one accumulation", () => {
  const [gpt] = estimates({
    candidates: ["openai/gpt-5.2"],
    hits: [hit({ model: "openai/gpt-5.2", prompt_tokens: 2006 })],
    reasoningEffort: "low",
  });
  const projections = gpt.fixed_turn_cost_estimate?.projections ?? [];

  expect(projections.map((projection) => projection.projected_turns)).toEqual([
    ...FIXED_TURN_COST_PROJECTED_TURNS,
  ]);
  // Each horizon is a prefix of the same loop, so cost rises with turns, and
  // it rises faster than linearly because every turn folds the previous
  // output back into the next request's input.
  const costs = projections.map((projection) => projection.total_cost_usd);
  for (let index = 1; index < costs.length; index += 1) {
    expect(costs[index]!).toBeGreaterThan(costs[index - 1]!);
  }
  // 30 turns costs a multiple of 10, superlinearly per turn as output folds
  // back into input, though less than the 10x a 10-to-100 jump showed.
  expect(costs[2]! / costs[1]!).toBeGreaterThan(3);
  expect(turnCostUsdAt(gpt.fixed_turn_cost_estimate, 5)).toBe(costs[0]);
  expect(turnCostUsdAt(gpt.fixed_turn_cost_estimate, 7)).toBeNull();
});

test("fixed-turn estimates use model-specific output-token averages", () => {
  const candidates = ["openai/gpt-5.2", "anthropic/claude-sonnet-4-6"];
  const [openAi, anthropic] = estimates({
    candidates,
    hits: [],
    reasoningEffort: "medium",
    averageOutputTokensByModel: {
      "openai/gpt-5.2": { medium: 900 },
      "anthropic/claude-sonnet-4-6": { medium: 3100 },
    },
  });

  expect(openAi.fixed_turn_cost_estimate?.output_tokens_per_turn).toBe(900);
  expect(anthropic.fixed_turn_cost_estimate?.output_tokens_per_turn).toBe(3100);
});

test("OpenAI subscription candidates retain projected loop costs", () => {
  const candidates = ["openai/gpt-5.6-sol", "openai/gpt-5.6-luna"];
  const results = estimates({
    candidates,
    hits: [],
    reasoningEffort: "xhigh",
    executionProvider: "openai-codex",
    averageOutputTokensByModel: {
      "openai/gpt-5.6-sol": { xhigh: 700 },
      "openai/gpt-5.6-luna": { xhigh: 530 },
    },
  });

  for (const estimate of results) {
    expect(estimate.fixed_turn_cost_estimate).toMatchObject({
      assumed_reasoning_effort: "xhigh",
    });
    expect(
      estimate.fixed_turn_cost_estimate?.projections.map(
        (projection) => projection.projected_turns,
      ),
    ).toEqual([...FIXED_TURN_COST_PROJECTED_TURNS]);
    for (const projection of estimate.fixed_turn_cost_estimate?.projections ?? []) {
      expect(projection.total_cost_usd).toBeGreaterThan(0);
    }
  }
});

test("fixed-turn estimates are omitted when a model has no output-token average", () => {
  const [estimate] = estimates({
    candidates: ["openai/gpt-5.2"],
    hits: [],
    reasoningEffort: "medium",
    averageOutputTokensByModel: {},
  });

  expect(estimate.fixed_turn_cost_estimate).toBeNull();
});

test("openai fixed-turn estimates cross the cache threshold after short prompts", () => {
  const [gpt] = estimates({
    candidates: ["openai/gpt-5.2"],
    hits: [],
    chain: ["h1"],
    newTailChars: 400, // 100 estimated tokens, below OpenAI's first cache chunk.
    reasoningEffort: "off",
  });

  const outputTokens = OUTPUT_TOKENS.off;
  expect(gpt.warm_tokens).toBe(0);
  expect(gpt.est_prompt_tokens).toBe(100);
  expect(openAiCachedPrefixTokens(100)).toBe(0);
  expect(openAiCachedPrefixTokens(100 + outputTokens)).toBe(1280);
  expect(gpt.fixed_turn_cost_estimate).toMatchObject({
    output_tokens_per_turn: outputTokens,
    assumed_reasoning_effort: "off",
  });
  expect(turnCostUsdAt(gpt.fixed_turn_cost_estimate, FIXED_TURN_COST_COMPARISON_TURNS)).toBeCloseTo(
    expectedOpenAiFixedTurnCost({
      price: PRICING["openai/gpt-5.2"],
      estPromptTokens: 100,
      warmTokens: 0,
      outputTokens,
    }),
    10
  );
});

test("fixed-turn estimates stay finite for very long prompts across cache providers", () => {
  const candidates = ["openai/gpt-5.2", "anthropic/claude-sonnet-4-6", "zai-org/GLM-5.2"];
  const results = estimates({
    candidates,
    hits: [],
    chain: ["h1"],
    newTailChars: 400_000, // 100k estimated tokens.
    reasoningEffort: "high",
  });

  for (const estimate of results) {
    expect(estimate.warm_tokens).toBe(0);
    expect(estimate.est_prompt_tokens).toBe(100_000);
    expect(estimate.fixed_turn_cost_estimate).toMatchObject({
      output_tokens_per_turn: OUTPUT_TOKENS.high,
      assumed_reasoning_effort: "high",
    });
    const loopCost = turnCostUsdAt(
      estimate.fixed_turn_cost_estimate,
      FIXED_TURN_COST_COMPARISON_TURNS,
    );
    expect(Number.isFinite(loopCost)).toBe(true);
    expect(loopCost ?? 0).toBeGreaterThan(estimate.est_input_cost_usd ?? 0);
  }

  const anthropic = results.find((item) => item.model === "anthropic/claude-sonnet-4-6");
  expect(anthropic?.est_input_cost_usd).toBeCloseTo((100_000 * PRICING["anthropic/claude-sonnet-4-6"].cacheWrite) / 1e6, 10);
});

test("fixed-turn estimates keep thinking-level variants distinct", () => {
  const candidates = [
    { model: "openai/gpt-5.2", reasoningEffort: "off" as const },
    { model: "openai/gpt-5.2", reasoningEffort: "high" as const },
  ];
  const estimated = estimateCandidateCosts({
    candidates,
    hits: sharedChainHits(["h1"], []),
    incomingProviderBlockCountFor: () => 1,
    promptEstimatesByCandidate: new Map(
      candidates.map((candidate) => [
        routingCandidateKey(candidate),
        { chars: 4000, reusesStoredPromptTokens: true },
      ]),
    ),
    toolChoiceFp: TOOL_FP,
    responseFormatFp: FORMAT_FP,
    pricing,
    averageOutputTokensByModel: { "openai/gpt-5.2": OUTPUT_TOKENS },
  });

  expect(estimated.map((item) => item.reasoning_effort)).toEqual(["off", "high"]);
  expect(estimated[0].fixed_turn_cost_estimate?.output_tokens_per_turn).toBe(
    OUTPUT_TOKENS.off,
  );
  expect(estimated[1].fixed_turn_cost_estimate?.output_tokens_per_turn).toBe(
    OUTPUT_TOKENS.high,
  );
});

test("fireworks fixed-turn estimates use cached-input pricing without write fees", () => {
  const [fireworks] = estimates({
    candidates: ["zai-org/GLM-5.2"],
    hits: [hit({ model: "zai-org/GLM-5.2", prompt_tokens: 2000 })],
    newTailChars: 4000,
    reasoningEffort: "off",
  });

  expect(fireworks.warm_tokens).toBe(2000);
  expect(fireworks.est_prompt_tokens).toBe(3000);
  expect(fireworks.est_input_cost_usd).toBeCloseTo((2000 * 0.14 + 1000 * 1.4) / 1e6, 10);
  expect(fireworks.fixed_turn_cost_estimate).toMatchObject({
    output_tokens_per_turn: 1200,
    assumed_reasoning_effort: "off",
  });
  expect(turnCostUsdAt(fireworks.fixed_turn_cost_estimate, FIXED_TURN_COST_COMPARISON_TURNS)).toBeGreaterThan(0);
});

test("meta fixed-turn estimates use the measured follow-up cache probability", () => {
  const model = "meta/muse-spark-1.1";
  const outputTokens = 1024;
  const [meta] = estimates({
    candidates: [model],
    hits: [],
    chain: ["h1"],
    newTailChars: 80_000,
    reasoningEffort: "minimal",
    averageOutputTokensByModel: { [model]: { minimal: outputTokens } },
  });

  const price = PRICING[model];
  const hitProbability = FIXED_TURN_CACHE_HIT_PROBABILITY.meta;
  let expected = 0;
  for (let turn = 1; turn <= FIXED_TURN_COST_COMPARISON_TURNS; turn += 1) {
    const inputTokens = 20_000 + (turn - 1) * outputTokens;
    const outputCost = (outputTokens * price.output) / 1e6;
    if (turn === 1) {
      expected += (inputTokens * price.input) / 1e6 + outputCost;
      continue;
    }
    const cachedTokens = 20_000 + (turn - 2) * outputTokens;
    const hitCost =
      (cachedTokens * price.cacheRead) / 1e6 +
      ((inputTokens - cachedTokens) * price.input) / 1e6 +
      outputCost;
    const missCost = (inputTokens * price.input) / 1e6 + outputCost;
    expected += hitCost * hitProbability + missCost * (1 - hitProbability);
  }

  expect(meta.fixed_turn_cost_estimate).toMatchObject({
    output_tokens_per_turn: outputTokens,
    assumed_reasoning_effort: "minimal",
  });
  expect(turnCostUsdAt(meta.fixed_turn_cost_estimate, FIXED_TURN_COST_COMPARISON_TURNS)).toBeCloseTo(expected, 10);
});

test("switch-back uses per-model deepest hits", () => {
  const sonnetTurn = hit({ hash: "h2", message_depth: 2, prompt_tokens: 2000 });
  const gptTurn = hit({
    hash: "h4",
    model: "openai/gpt-5.2",
    message_depth: 4,
    prompt_tokens: 2600,
  });
  const [sonnet, gpt] = estimates({
    hits: [sonnetTurn, gptTurn],
    chain: ["h1", "h2", "h3", "h4", "h5"],
    incomingProviderBlockCount: 5,
  });
  expect(gpt.warm_tokens).toBe(2560);
  // Sonnet's older prefix is still warm for the switch-back.
  expect(sonnet.warm_tokens).toBe(2000);
  // Its estimate starts at that prefix and includes Sonnet's own uncovered tail.
  expect(sonnet.est_prompt_tokens).toBe(3000);
});

test("effort-keyed candidates ignore warm prefixes from other reasoning buckets", () => {
  // Live validation: OpenAI reasoning models and Anthropic (via message-block
  // cache_control) partition provider caches by effective
  // reasoning effort. A prefix warmed under "off" is cold for "high".
  const hits = [
    hit({ prompt_tokens: 2000, reasoning_bucket: "off" }),
    hit({ model: "openai/gpt-5.2", prompt_tokens: 2000, reasoning_bucket: "off" }),
  ];
  const [sonnetHigh, gptHigh] = estimates({ hits, reasoningEffort: "high" });
  expect(sonnetHigh.warm_tokens).toBe(0);
  expect(gptHigh.warm_tokens).toBe(0);
  expect(sonnetHigh.est_prompt_tokens).toBe(1000);
  expect(gptHigh.est_prompt_tokens).toBe(1000 * CROSS_TOKENIZER_RATIO);

  const [sonnetOff, gptOff] = estimates({ hits, reasoningEffort: "off" });
  expect(sonnetOff.warm_tokens).toBe(2000);
  expect(gptOff.warm_tokens).toBe(1920);
});

test("switch-back reuses the candidate's own bucket entry (A -> B -> A)", () => {
  // Bucket partitions coexist: a deeper cross-bucket entry must not shadow
  // the candidate's still-warm same-bucket entry, and each effort selects
  // its own partition's depth.
  const hits = [
    hit({ hash: "h2", message_depth: 2, prompt_tokens: 2000, reasoning_bucket: "off" }),
    hit({ hash: "h4", message_depth: 4, prompt_tokens: 5000, reasoning_bucket: "high" }),
  ];
  const [offEstimate] = estimates({
    candidates: ["anthropic/claude-sonnet-4-6"],
    hits,
    chain: ["h1", "h2", "h3", "h4", "h5"],
    incomingProviderBlockCount: 5,
    reasoningEffort: "off",
  });
  const [highEstimate] = estimates({
    candidates: ["anthropic/claude-sonnet-4-6"],
    hits,
    chain: ["h1", "h2", "h3", "h4", "h5"],
    incomingProviderBlockCount: 5,
    reasoningEffort: "high",
  });
  expect(offEstimate.warm_tokens).toBe(2000);
  expect(highEstimate.warm_tokens).toBe(5000);
});

test("exact reasoning bucket beats deeper legacy bucketless entries", () => {
  // Legacy bucketless entries are fallback-only. Once a model has an explicit
  // same-bucket row, a deeper null-bucket row might have been written under a
  // different effort and must not shadow the active partition.
  const [highEstimate] = estimates({
    candidates: ["anthropic/claude-sonnet-4-6"],
    hits: [
      hit({ hash: "h2", message_depth: 2, prompt_tokens: 2000, reasoning_bucket: "high" }),
      hit({ hash: "h4", message_depth: 4, prompt_tokens: 5000, reasoning_bucket: null }),
    ],
    chain: ["h1", "h2", "h3", "h4", "h5"],
    incomingProviderBlockCount: 5,
    reasoningEffort: "high",
  });

  expect(highEstimate.warm_tokens).toBe(2000);
});

test("entries without a bucket stay warm for any effort", () => {
  // Rollout default: entries written before buckets existed carry null and
  // must not cool genuinely warm prefixes.
  const [sonnet] = estimates({
    candidates: ["anthropic/claude-sonnet-4-6"],
    hits: [hit({ prompt_tokens: 2000 })],
    reasoningEffort: "high",
  });
  expect(sonnet.warm_tokens).toBe(2000);
});

test("override lookups normalize the provider prefix like providerForModel", () => {
  // A mixed-case provider prefix routes as its provider, so scope and
  // thinking-level overrides must resolve the same way.
  const [glm] = estimates({
    candidates: ["Fireworks/zai-org/GLM-5.2"],
    hits: [hit({ model: "Fireworks/zai-org/GLM-5.2", prompt_tokens: 2000, reasoning_bucket: "off" })],
    reasoningEffort: "high",
  });
  // shared scope applies despite the casing: warm across buckets.
  expect(glm.warm_tokens).toBe(2000);
});

test("shared-scope models reuse one warm prefix across reasoning buckets", () => {
  // Fireworks caching ignored reasoning entirely in live validation.
  const [glm] = estimates({
    candidates: ["zai-org/GLM-5.2"],
    hits: [hit({ model: "zai-org/GLM-5.2", prompt_tokens: 2000, reasoning_bucket: "off" })],
    reasoningEffort: "high",
  });
  expect(glm.warm_tokens).toBe(2000);
});

test("cache warmth does not cross providers for the same canonical model", () => {
  const model = "zai-org/GLM-5.2";
  const candidate = { model, reasoningEffort: "medium" as const };
  const [estimate] = estimateCandidateCosts({
    candidates: [candidate],
    hits: sharedChainHits(["h1", "h2"], [hit({
      model,
      provider: "openrouter",
      prompt_tokens: 2000,
      reasoning_bucket: "medium",
    })]),
    incomingProviderBlockCountFor: () => 2,
    promptEstimatesByCandidate: new Map([[routingCandidateKey(candidate), {
      chars: 4000,
      reusesStoredPromptTokens: true,
    }]]),
    toolChoiceFp: TOOL_FP,
    responseFormatFp: FORMAT_FP,
    pricing,
    averageOutputTokensByModel: { [model]: OUTPUT_TOKENS },
    modelProvider: () => "fireworks",
  });

  expect(estimate.warm_tokens).toBe(0);
  expect(estimate.est_prompt_tokens).toBe(1000);
});

test("three-provider switch history keeps fixed-turn estimates provider-scoped", () => {
  const candidates = ["openai/gpt-5.2", "anthropic/claude-sonnet-4-6", "zai-org/GLM-5.2"];
  const results = estimates({
    candidates,
    hits: [
      hit({
        hash: "h2",
        model: "openai/gpt-5.2",
        message_depth: 2,
        prompt_tokens: 2048,
      }),
      hit({
        hash: "h4",
        model: "anthropic/claude-sonnet-4-6",
        message_depth: 4,
        prompt_tokens: 5000,
      }),
      hit({
        hash: "h6",
        model: "zai-org/GLM-5.2",
        message_depth: 6,
        prompt_tokens: 1200,
      }),
    ],
    chain: ["h1", "h2", "h3", "h4", "h5", "h6", "h7"],
    incomingProviderBlockCount: 7,
    newTailChars: 4000,
    reasoningEffort: "medium",
  });

  const byModel = new Map(results.map((item) => [item.model, item]));
  const openai = byModel.get("openai/gpt-5.2");
  const anthropic = byModel.get("anthropic/claude-sonnet-4-6");
  const fireworks = byModel.get("zai-org/GLM-5.2");

  expect(openai).toMatchObject({
    warm_tokens: 2048,
    est_prompt_tokens: 2048 + 1000,
  });
  expect(anthropic).toMatchObject({
    warm_tokens: 5000,
    est_prompt_tokens: 5000 + 1000,
  });
  expect(fireworks).toMatchObject({
    warm_tokens: 1200,
    est_prompt_tokens: 2200,
  });
  for (const estimate of results) {
    expect(estimate.fixed_turn_cost_estimate).toMatchObject({
            output_tokens_per_turn: OUTPUT_TOKENS.medium,
      assumed_reasoning_effort: "medium",
    });
  }
});

test("foreign-tokenizer history adds a margin to the provider's full prompt estimate", () => {
  const [glm] = estimates({
    candidates: ["zai-org/GLM-5.2"],
    hits: [
      hit({
        hash: "h2",
        model: "fireworks/deepseek-ai/DeepSeek-V4-Pro",
        message_depth: 2,
        prompt_tokens: 2000,
      }),
    ],
    chain: ["h1", "h2", "h3"],
    newTailChars: 4000,
    reasoningEffort: "off",
  });

  expect(glm.warm_tokens).toBe(0);
  expect(glm.est_prompt_tokens).toBe(1000 * CROSS_TOKENIZER_RATIO);
});

test("anthropic lookback cap cools stale switch-backs at exactly 20 blocks", () => {
  // Docs: 20 positions are checked counting the breakpoint itself, so an old
  // breakpoint exactly 20 blocks back misses and 19 back hits.
  const [stillWarm] = estimates({
    hits: [hit({ provider_block_depth: 2 })],
    incomingProviderBlockCount: 2 + ANTHROPIC_LOOKBACK_BLOCKS,
  });
  expect(stillWarm.warm_tokens).toBe(2000);

  const [cold] = estimates({
    hits: [hit({ provider_block_depth: 2 })],
    incomingProviderBlockCount: 2 + ANTHROPIC_LOOKBACK_BLOCKS + 1,
  });
  expect(cold.warm_tokens).toBe(0);
  expect(cold.est_input_cost_usd).toBeCloseTo((3000 * 3.75) / 1e6, 10);
});

test("anthropic lookback uses the candidate's provider-visible block depth", () => {
  const results = estimates({
    hits: [hit({ provider_block_depth: 2 })],
    incomingProviderBlockCount: 3,
    incomingProviderBlockCountFor: (model) =>
      model.startsWith("anthropic/")
        ? 2 + ANTHROPIC_LOOKBACK_BLOCKS + 1
        : 3,
  });
  const byModel = new Map(results.map((item) => [item.model, item]));

  expect(byModel.get("anthropic/claude-sonnet-4-6")?.warm_tokens).toBe(0);
});

test("anthropic lookback fails cold for legacy entries without provider depth", () => {
  const [result] = estimates({
    hits: [hit({ provider_block_depth: null })],
    incomingProviderBlockCount: 2 + ANTHROPIC_LOOKBACK_BLOCKS,
  });

  expect(result.warm_tokens).toBe(0);
});

test("openai warmth requires the 1024-token cache minimum", () => {
  const [gpt] = estimates({
    candidates: ["openai/gpt-5.2"],
    hits: [hit({ model: "openai/gpt-5.2", prompt_tokens: 500 })],
    newTailChars: 400, // 100 new tokens; est 600 < 1024
  });
  expect(gpt.warm_tokens).toBe(0);
});

test("openai warm tokens are rounded to provider cache increments", () => {
  const [gpt] = estimates({
    candidates: ["openai/gpt-5.2"],
    hits: [hit({ model: "openai/gpt-5.2", prompt_tokens: 2006 })],
    newTailChars: 4000,
  });
  expect(gpt.warm_tokens).toBe(1920);
  expect(gpt.est_prompt_tokens).toBe(3006);
  expect(gpt.est_input_cost_usd).toBeCloseTo((1920 * 0.175 + 1086 * 1.75) / 1e6, 10);
});

test("openai minimum gates on the candidate's own prefix, not the global estimate", () => {
  // Another model's deeper hit inflates the global prompt estimate past 1024,
  // but this candidate's own 500-token cached prefix is below OpenAI's
  // minimum and cannot be served from cache.
  const [gpt] = estimates({
    candidates: ["openai/gpt-5.2"],
    hits: [
      hit({ hash: "h3", message_depth: 3, prompt_tokens: 5000 }),
      hit({ hash: "h2", model: "openai/gpt-5.2", prompt_tokens: 500 }),
    ],
  });
  expect(gpt.est_prompt_tokens).toBeGreaterThan(1024);
  expect(gpt.warm_tokens).toBe(0);
});

test("cross-tokenizer switch-back never estimates prompt below warm prefix", () => {
  const [sonnet] = estimates({
    candidates: ["anthropic/claude-sonnet-4-6"],
    hits: [
      hit({
        hash: "h2",
        model: "anthropic/claude-sonnet-4-6",
        message_depth: 2,
        prompt_tokens: 5000,
      }),
      hit({
        hash: "h4",
        model: "openai/gpt-5.2",
        message_depth: 4,
        prompt_tokens: 1000,
      }),
    ],
    chain: ["h1", "h2", "h3", "h4", "h5"],
    newTailChars: 0,
  });

  expect(sonnet.warm_tokens).toBe(5000);
  expect(sonnet.est_prompt_tokens).toBe(5000);
  expect(sonnet.est_input_cost_usd).toBeCloseTo((5000 * 0.3) / 1e6, 10);
});

test("anthropic model-specific minimum gates cache read and write estimates", () => {
  const [shortOpus] = estimates({
    candidates: ["anthropic/claude-opus-4-6"],
    hits: [hit({ model: "anthropic/claude-opus-4-6", prompt_tokens: 3000 })],
    newTailChars: 0,
  });
  expect(shortOpus.warm_tokens).toBe(0);
  expect(shortOpus.est_input_cost_usd).toBeCloseTo((3000 * 30) / 1e6, 10);

  const [cacheableOpus] = estimates({
    candidates: ["anthropic/claude-opus-4-6"],
    hits: [],
    chain: ["h1"],
    newTailChars: 16_384, // 4096 estimated tokens.
  });
  expect(cacheableOpus.warm_tokens).toBe(0);
  expect(cacheableOpus.est_input_cost_usd).toBeCloseTo((4096 * 37.5) / 1e6, 10);
});

test("tool_choice flip cools anthropic but not openai-style candidates", () => {
  const flipped = estimates({
    hits: [
      hit(),
      hit({ hash: "h2", model: "openai/gpt-5.2", prompt_tokens: 2000 }),
    ],
    toolChoiceFp: "x".repeat(64),
  });
  const sonnet = flipped.find((e) => e.model === "anthropic/claude-sonnet-4-6");
  const gpt = flipped.find((e) => e.model === "openai/gpt-5.2");
  expect(sonnet?.warm_tokens).toBe(0);
  expect(gpt?.warm_tokens).toBe(1920);
});

test("response_format flip cools every candidate", () => {
  const flipped = estimates({
    hits: [
      hit(),
      hit({ hash: "h2", model: "openai/gpt-5.2", prompt_tokens: 2000 }),
    ],
    responseFormatFp: "x".repeat(64),
  });
  expect(flipped.every((e) => e.warm_tokens === 0)).toBe(true);
});

test("unknown pricing yields null cost and pricing_known false", () => {
  const [mystery] = estimates({ candidates: ["openai/gpt-unreleased"] });
  expect(mystery.pricing_known).toBe(false);
  expect(mystery.est_input_cost_usd).toBeNull();
  expect(mystery.output_cost_per_mtok).toBeNull();
  expect(mystery.fixed_turn_cost_estimate).toBeNull();
});

test("no hits estimates from raw characters", () => {
  const [sonnet] = estimates({
    hits: [],
    chain: ["h1"],
    newTailChars: 8000,
    candidates: ["anthropic/claude-sonnet-4-6"],
  });
  expect(sonnet.warm_tokens).toBe(0);
  expect(sonnet.est_prompt_tokens).toBe(2000);
});

test("hits not present in the incoming chain are ignored", () => {
  const derived = sharedChainHits(["h1", "h2"], [hit({ hash: "unrelated" })]);
  expect(derived.deepest).toBeUndefined();
  expect(derived.perModel.size).toBe(0);
});

test("provider-specific chains accept hits only for the model that wrote them", () => {
  const sonnet = "anthropic/claude-sonnet-4-6";
  const gpt = "openai/gpt-5.2";
  const derived = deriveModelChainHits(
    new Map([
      [sonnet, ["shared", "claude-state"]],
      [gpt, ["shared", "gpt-state"]],
    ]),
    [
      hit({ hash: "claude-state", model: sonnet }),
      hit({ hash: "claude-state", model: gpt }),
      hit({ hash: "gpt-state", model: gpt }),
    ]
  );

  expect(derived.perModel.get(sonnet)?.entry.hash).toBe("claude-state");
  expect(derived.perModel.get(gpt)?.entry.hash).toBe("gpt-state");
});

test("divergent provider chains price each candidate from its own prefix tail", () => {
  const sonnet = "anthropic/claude-sonnet-4-6";
  const gpt = "openai/gpt-5.2";
  const candidates = [sonnet, gpt].map((model) => ({
    model,
    reasoningEffort: "off" as const,
  }));
  const hits = deriveModelChainHits(
    new Map([
      [sonnet, ["s1", "s2", "s3", "s4"]],
      [gpt, ["g1", "g2", "g3", "g4"]],
    ]),
    [
      hit({ hash: "s2", model: sonnet, prompt_tokens: 2000 }),
      hit({ hash: "g4", model: gpt, prompt_tokens: 1000 }),
    ]
  );
  const estimates = estimateCandidateCosts({
    candidates,
    hits,
    incomingProviderBlockCountFor: () => 4,
    promptEstimatesByCandidate: new Map([
      [
        routingCandidateKey(candidates[0]),
        { chars: 1200, reusesStoredPromptTokens: true },
      ],
      [
        routingCandidateKey(candidates[1]),
        { chars: 0, reusesStoredPromptTokens: true },
      ],
    ]),
    toolChoiceFp: TOOL_FP,
    responseFormatFp: FORMAT_FP,
    pricing,
  });

  expect(estimates.find((estimate) => estimate.model === sonnet)?.est_prompt_tokens).toBe(2300);
  expect(estimates.find((estimate) => estimate.model === gpt)?.est_prompt_tokens).toBe(1000);
});

test("a cold OpenAI partition is priced at the write rate, not the input rate", () => {
  const candidate = { model: "openai/gpt-5.6-sol", reasoningEffort: "high" as ReasoningEffort };
  const [estimate] = estimateCandidateCosts({
    candidates: [candidate],
    hits: sharedChainHits(["h1"], []),
    incomingProviderBlockCountFor: () => 1,
    promptEstimatesByCandidate: new Map([[
      routingCandidateKey(candidate),
      { chars: 40_000, reusesStoredPromptTokens: true },
    ]]),
    toolChoiceFp: TOOL_FP,
    responseFormatFp: FORMAT_FP,
    pricing,
  });

  // Nothing is warm, so the whole prompt is written. Billing it as plain input
  // would understate the turn by the write premium (5.00 vs 4.00 per Mtok).
  expect(estimate.warm_tokens).toBe(0);
  const promptTokens = estimate.est_prompt_tokens;
  expect(promptTokens).toBeGreaterThan(1024);
  expect(estimate.est_input_cost_usd).toBeCloseTo((promptTokens * 5) / 1_000_000, 10);
  expect(estimate.est_input_cost_usd).toBeGreaterThan((promptTokens * 4) / 1_000_000);
});

test("a provider that does not bill writes still prices fresh tokens as input", () => {
  const candidate = { model: "zai-org/GLM-5.2", reasoningEffort: "high" as ReasoningEffort };
  const [estimate] = estimateCandidateCosts({
    candidates: [candidate],
    hits: sharedChainHits(["h1"], []),
    incomingProviderBlockCountFor: () => 1,
    promptEstimatesByCandidate: new Map([[
      routingCandidateKey(candidate),
      { chars: 40_000, reusesStoredPromptTokens: true },
    ]]),
    toolChoiceFp: TOOL_FP,
    responseFormatFp: FORMAT_FP,
    pricing,
  });

  expect(estimate.est_input_cost_usd).toBeCloseTo((estimate.est_prompt_tokens * 1.4) / 1_000_000, 10);
});

test("every selector lease length is a priced cost horizon", () => {
  // The serving menu is the code constant; the prompt prices actions at the
  // projected horizons, so the menu must never offer an unpriced commitment.
  for (const turns of SELECTOR_LEASE_TURNS) {
    expect(FIXED_TURN_COST_PROJECTED_TURNS).toContain(turns);
  }
});

function growthProjection(provider: string, promptGrowthTokensPerTurn?: number) {
  const model = "zai-org/GLM-5.2";
  const candidate = { model, reasoningEffort: "high" as const };
  const [estimate] = estimateCandidateCosts({
    candidates: [candidate],
    hits: { perModel: new Map(), perModelBuckets: new Map() },
    incomingProviderBlockCountFor: () => 1,
    promptEstimatesByCandidate: new Map([[routingCandidateKey(candidate), {
      chars: 40_000,
      reusesStoredPromptTokens: false,
    }]]),
    toolChoiceFp: TOOL_FP,
    responseFormatFp: FORMAT_FP,
    pricing,
    averageOutputTokensByModel: { [model]: { high: 200 } },
    modelProvider: () => provider,
    ...(promptGrowthTokensPerTurn === undefined ? {} : { promptGrowthTokensPerTurn }),
  });
  return (turns: number) => turnCostUsdAt(estimate.fixed_turn_cost_estimate, turns)!;
}

test("tool results the agent adds each turn grow the projected prompt beyond the reply", () => {
  const replyOnly = growthProjection("fireworks");
  const withToolResults = growthProjection("fireworks", 1000);
  for (const turns of FIXED_TURN_COST_PROJECTED_TURNS) {
    expect(withToolResults(turns)).toBeGreaterThan(replyOnly(turns));
  }
  // Growth never falls below the reply itself, which always lands in the next prompt.
  const belowReply = growthProjection("fireworks", 50);
  for (const turns of FIXED_TURN_COST_PROJECTED_TURNS) {
    expect(belowReply(turns)).toBeCloseTo(replyOnly(turns), 12);
  }
});

test("open-weight models behind Vercel AI Gateway are priced with prompt caching", () => {
  const gateway = growthProjection("vercel-ai-gateway", 1000);
  const fireworks = growthProjection("fireworks", 1000);
  const uncached = growthProjection("custom-provider", 1000);
  for (const turns of FIXED_TURN_COST_PROJECTED_TURNS) {
    expect(gateway(turns)).toBeCloseTo(fireworks(turns), 12);
    expect(gateway(turns)).toBeLessThan(uncached(turns));
  }
});
