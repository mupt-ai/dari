import {
  PREFIX_WARMTH_WINDOW_MS,
  providerMinCacheTokens,
  type PrefixHit,
  type RouterModelPrice,
} from "@mupt-ai/dari-router/policy-engine";

const TOKENS_PER_MTOK = 1_000_000;

export const BENCHMARK_REPLAY_ESTIMATOR_VERSION = "sticky-cache-v2";

export type BenchmarkReplayPriceSnapshot = {
  input: number;
  output: number;
  cached_input: number | null;
  cache_write: number | null;
};

export type BenchmarkReplayEstimate = {
  costUsd: number | null;
  rawCostUsd: number | null;
  model: string | null;
  price: BenchmarkReplayPriceSnapshot | null;
  estimatorVersion: typeof BENCHMARK_REPLAY_ESTIMATOR_VERSION;
  depth: number;
};

/**
 * Price one turn as if the router had stayed on its most expensive enabled
 * model for the whole conversation.
 *
 * The prior depth comes from synchronized prefix state, so this runs once
 * while the request is being reported instead of replaying conversation rows
 * during every Activity read.
 */
export function estimateBenchmarkReplay(args: {
  enabledModels: readonly string[];
  modelPrices: Readonly<Record<string, RouterModelPrice>>;
  /** Serving provider per canonical model; owner-namespace ids (deepseek-ai/…)
   * cannot self-identify their provider, so the resolved router supplies it. */
  executionProvider: (model: string) => string;
  priorHit?: PrefixHit;
  receivedAtMs: number;
  promptTokens: number;
  outputTokens: number;
  selectedModel?: string;
  selectedCostUsd?: number;
}): BenchmarkReplayEstimate {
  const promptTokens = nonnegativeInteger(args.promptTokens);
  const outputTokens = nonnegativeInteger(args.outputTokens);
  const priorDepth = priorBenchmarkDepth(args.priorHit);
  const depth = Math.max(priorDepth, promptTokens);
  const effectivePrices = Object.fromEntries(Object.entries(args.modelPrices).map(([model, base]) => {
    const tier = base.tiers?.filter((entry) => promptTokens > entry.input_tokens_above)
      .sort((left, right) => right.input_tokens_above - left.input_tokens_above)[0];
    return [model, tier ?? base];
  }));
  const benchmark = benchmarkPrice(args.enabledModels, effectivePrices);
  if (benchmark === null) {
    return {
      costUsd: null,
      rawCostUsd: null,
      model: null,
      price: null,
      estimatorVersion: BENCHMARK_REPLAY_ESTIMATOR_VERSION,
      depth,
    };
  }
  const { model, price } = benchmark;

  const updatedAtMs = args.priorHit
    ? Date.parse(args.priorHit.entry.updated_at)
    : Number.NaN;
  const isWarm =
    Number.isFinite(updatedAtMs) &&
    updatedAtMs >= args.receivedAtMs - PREFIX_WARMTH_WINDOW_MS;
  const warmTokens = isWarm ? Math.min(priorDepth, promptTokens) : 0;
  const freshTokens = promptTokens - warmTokens;
  const cachedRate = validOptionalRate(price.cached_input) ?? price.input;
  const cacheWriteRate = validOptionalRate(price.cache_write);
  const freshRate =
    cacheWriteRate !== null &&
    cacheWriteRate > 0 &&
    promptTokens >= providerMinCacheTokens(model, args.executionProvider(model))
      ? cacheWriteRate
      : price.input;

  const replayedCost =
    (warmTokens * cachedRate +
      freshTokens * freshRate +
      outputTokens * price.output) /
    TOKENS_PER_MTOK;
  const selectedCost = validOptionalRate(args.selectedCostUsd);

  return {
    costUsd:
      args.selectedModel === model && selectedCost !== null
        ? Math.min(replayedCost, selectedCost)
        : replayedCost,
    rawCostUsd: replayedCost,
    model,
    price: {
      input: price.input,
      output: price.output,
      cached_input: validOptionalRate(price.cached_input),
      cache_write: validOptionalRate(price.cache_write),
    },
    estimatorVersion: BENCHMARK_REPLAY_ESTIMATOR_VERSION,
    depth,
  };
}

function benchmarkPrice(
  enabledModels: readonly string[],
  modelPrices: Readonly<Record<string, RouterModelPrice>>,
): { model: string; price: RouterModelPrice } | null {
  let benchmark: { model: string; price: RouterModelPrice } | null = null;
  for (const model of enabledModels) {
    const price = modelPrices[model];
    if (!validPrice(price)) continue;
    if (
      benchmark === null ||
      price.output > benchmark.price.output ||
      (price.output === benchmark.price.output && price.input > benchmark.price.input) ||
      (price.output === benchmark.price.output &&
        price.input === benchmark.price.input &&
        model > benchmark.model)
    ) {
      benchmark = { model, price };
    }
  }
  return benchmark;
}

function priorBenchmarkDepth(hit: PrefixHit | undefined): number {
  if (!hit) return 0;
  const stored = hit.entry.benchmark_replay_depth;
  if (typeof stored === "number" && Number.isFinite(stored) && stored >= 0) {
    return Math.trunc(stored);
  }
  // Prefix entries written before benchmark depth existed still provide a
  // safe bootstrap point. The next entry carries the running maximum.
  return nonnegativeInteger(hit.entry.prompt_tokens);
}

function validPrice(price: RouterModelPrice | undefined): price is RouterModelPrice {
  return price !== undefined && validRate(price.input) && validRate(price.output);
}

function validRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validOptionalRate(value: unknown): number | null {
  return validRate(value) ? value : null;
}

function nonnegativeInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
