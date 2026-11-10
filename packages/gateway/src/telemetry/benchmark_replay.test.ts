import { expect, test } from "bun:test";

import type { PrefixHit, RouterModelPrice } from "@mupt-ai/dari-router/policy-engine";

import {
  BENCHMARK_REPLAY_ESTIMATOR_VERSION,
  estimateBenchmarkReplay,
} from "./benchmark_replay.js";

const RECEIVED_AT_MS = Date.parse("2026-07-14T12:00:00Z");
const PRICES: Record<string, RouterModelPrice> = {
  "openai/gpt-4.1-mini": {
    input: 0.4,
    output: 1.6,
    cached_input: 0.1,
    cache_write: 0,
  },
  "anthropic/claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cached_input: 0.3,
    cache_write: 3.75,
  },
};

// Test models self-identify: openai/… serves on openai, anthropic/… on
// anthropic. Production callers resolve this from the router's bindings.
const EXECUTION_PROVIDERS: Record<string, string> = {
  "openai/gpt-4.1-mini": "openai",
  "anthropic/claude-sonnet-4-6": "anthropic",
};

function executionProvider(model: string): string {
  const provider = EXECUTION_PROVIDERS[model];
  if (!provider) throw new Error(`missing test execution provider for ${model}`);
  return provider;
}

function priorHit(args: {
  depth?: number;
  promptTokens: number;
  ageMs: number;
}): PrefixHit {
  return {
    depth: 2,
    entry: {
      hash: "a".repeat(64),
      conversation_id: "conversation-1",
      model: "openai/gpt-4.1-mini",
      next_model: null,
      next_reasoning_effort: null,
      message_depth: 2,
      prompt_tokens: args.promptTokens,
      ...(args.depth === undefined
        ? {}
        : { benchmark_replay_depth: args.depth }),
      input_tokens: args.promptTokens,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      tool_choice_fp: "tools",
      response_format_fp: "response",
      reason: null,
      updated_at: new Date(RECEIVED_AT_MS - args.ageMs).toISOString(),
    },
  };
}

test("prices a cold turn at the benchmark cache-write and output rates", () => {
  const estimate = estimateBenchmarkReplay({
    enabledModels: Object.keys(PRICES),
    modelPrices: PRICES,
    executionProvider,
    receivedAtMs: RECEIVED_AT_MS,
    promptTokens: 100_000,
    outputTokens: 10_000,
  });

  expect(estimate.costUsd).toBeCloseTo(0.525, 10);
  expect(estimate.rawCostUsd).toBeCloseTo(0.525, 10);
  expect(estimate.model).toBe("anthropic/claude-sonnet-4-6");
  expect(estimate.price).toEqual({
    input: 3,
    output: 15,
    cached_input: 0.3,
    cache_write: 3.75,
  });
  expect(estimate.estimatorVersion).toBe(BENCHMARK_REPLAY_ESTIMATOR_VERSION);
  expect(estimate.depth).toBe(100_000);
});

test("prices a warm continuation from synchronized benchmark depth", () => {
  const estimate = estimateBenchmarkReplay({
    enabledModels: Object.keys(PRICES),
    modelPrices: PRICES,
    executionProvider,
    priorHit: priorHit({ depth: 100_000, promptTokens: 100_000, ageMs: 60_000 }),
    receivedAtMs: RECEIVED_AT_MS,
    promptTokens: 110_000,
    outputTokens: 10_000,
  });

  expect(estimate.costUsd).toBeCloseTo(0.2175, 10);
  expect(estimate.depth).toBe(110_000);
});

test("restarts cold after the provider warmth window expires", () => {
  const estimate = estimateBenchmarkReplay({
    enabledModels: Object.keys(PRICES),
    modelPrices: PRICES,
    executionProvider,
    priorHit: priorHit({
      depth: 110_000,
      promptTokens: 110_000,
      ageMs: 6 * 60_000,
    }),
    receivedAtMs: RECEIVED_AT_MS,
    promptTokens: 120_000,
    outputTokens: 10_000,
  });

  expect(estimate.costUsd).toBeCloseTo(0.6, 10);
  expect(estimate.depth).toBe(120_000);
});

test("does not shrink the running benchmark depth", () => {
  const estimate = estimateBenchmarkReplay({
    enabledModels: Object.keys(PRICES),
    modelPrices: PRICES,
    executionProvider,
    priorHit: priorHit({ depth: 120_000, promptTokens: 100_000, ageMs: 1_000 }),
    receivedAtMs: RECEIVED_AT_MS,
    promptTokens: 100_000,
    outputTokens: 10_000,
  });

  expect(estimate.costUsd).toBeCloseTo(0.18, 10);
  expect(estimate.depth).toBe(120_000);
});

test("bootstraps depth from prefix entries written before the new field", () => {
  const estimate = estimateBenchmarkReplay({
    enabledModels: Object.keys(PRICES),
    modelPrices: PRICES,
    executionProvider,
    priorHit: priorHit({ promptTokens: 80_000, ageMs: 1_000 }),
    receivedAtMs: RECEIVED_AT_MS,
    promptTokens: 100_000,
    outputTokens: 10_000,
  });

  expect(estimate.costUsd).toBeCloseTo(0.249, 10);
  expect(estimate.depth).toBe(100_000);
});

test("does not estimate savings when the benchmark model actually cost less", () => {
  const estimate = estimateBenchmarkReplay({
    enabledModels: Object.keys(PRICES),
    modelPrices: PRICES,
    executionProvider,
    receivedAtMs: RECEIVED_AT_MS,
    promptTokens: 100_000,
    outputTokens: 10_000,
    selectedModel: "anthropic/claude-sonnet-4-6",
    selectedCostUsd: 0.45,
  });

  expect(estimate.costUsd).toBe(0.45);
  expect(estimate.depth).toBe(100_000);
});

test("preserves benchmark-model overspend against a sticky replay", () => {
  const estimate = estimateBenchmarkReplay({
    enabledModels: Object.keys(PRICES),
    modelPrices: PRICES,
    executionProvider,
    priorHit: priorHit({ depth: 100_000, promptTokens: 100_000, ageMs: 60_000 }),
    receivedAtMs: RECEIVED_AT_MS,
    promptTokens: 110_000,
    outputTokens: 10_000,
    selectedModel: "anthropic/claude-sonnet-4-6",
    selectedCostUsd: 0.45,
  });

  expect(estimate.costUsd).toBeCloseTo(0.2175, 10);
  expect(estimate.depth).toBe(110_000);
});

test("does not clamp another selected model's savings", () => {
  const estimate = estimateBenchmarkReplay({
    enabledModels: Object.keys(PRICES),
    modelPrices: PRICES,
    executionProvider,
    receivedAtMs: RECEIVED_AT_MS,
    promptTokens: 100_000,
    outputTokens: 10_000,
    selectedModel: "openai/gpt-4.1-mini",
    selectedCostUsd: 0.056,
  });

  expect(estimate.costUsd).toBeCloseTo(0.525, 10);
  expect(estimate.depth).toBe(100_000);
});

test("advances depth but omits cost when no enabled model has pricing", () => {
  const estimate = estimateBenchmarkReplay({
    enabledModels: ["missing/model"],
    modelPrices: {},
    executionProvider: () => "missing",
    priorHit: priorHit({ depth: 100, promptTokens: 100, ageMs: 1_000 }),
    receivedAtMs: RECEIVED_AT_MS,
    promptTokens: 150,
    outputTokens: 10,
  });

  expect(estimate).toEqual({
    costUsd: null,
    rawCostUsd: null,
    model: null,
    price: null,
    estimatorVersion: BENCHMARK_REPLAY_ESTIMATOR_VERSION,
    depth: 150,
  });
});

test("prices fresh tokens below the provider minimum at the input rate", () => {
  // Claude Sonnet 4-6 has a 1024-token cache minimum. A 500-token prompt
  // is too small, so fresh tokens bill at the input rate (3) rather than
  // the cache-write rate (3.75).
  const estimate = estimateBenchmarkReplay({
    enabledModels: Object.keys(PRICES),
    modelPrices: PRICES,
    executionProvider,
    receivedAtMs: RECEIVED_AT_MS,
    promptTokens: 500,
    outputTokens: 0,
  });

  expect(estimate.costUsd).toBeCloseTo(500 * 3 / 1_000_000, 10);
  expect(estimate.depth).toBe(500);
});

test("switches to cache-write rate at or above the provider minimum", () => {
  // 1024 is the minimum for Claude Sonnet 4-6. At this threshold fresh
  // tokens bill at the cache-write rate (3.75).
  const estimate = estimateBenchmarkReplay({
    enabledModels: Object.keys(PRICES),
    modelPrices: PRICES,
    executionProvider,
    receivedAtMs: RECEIVED_AT_MS,
    promptTokens: 1024,
    outputTokens: 0,
  });

  expect(estimate.costUsd).toBeCloseTo(1024 * 3.75 / 1_000_000, 10);
  expect(estimate.depth).toBe(1024);
});

test("preserves prior benchmark depth when observed usage is zero", () => {
  // A completed turn with no usable usage object still propagates the
  // running benchmark depth forward so the next turn does not reprice a
  // warm continuation as fully cold.
  const estimate = estimateBenchmarkReplay({
    enabledModels: Object.keys(PRICES),
    modelPrices: PRICES,
    executionProvider,
    priorHit: priorHit({ depth: 100_000, promptTokens: 100_000, ageMs: 1_000 }),
    receivedAtMs: RECEIVED_AT_MS,
    promptTokens: 0,
    outputTokens: 0,
  });

  expect(estimate.depth).toBe(100_000);
  expect(estimate.costUsd).toBe(0);
});
