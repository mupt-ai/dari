import { getSupportedThinkingLevels, type Api, type Model } from "@mupt-ai/pi-ai";
import {
  getBuiltinModelDataGeneratedAt,
  getBuiltinModels,
  getBuiltinProviders,
} from "@mupt-ai/pi-ai/providers/all";
import {
  REASONING_EFFORTS,
  isReasoningEffort,
  isRecord,
  type ReasoningEffort,
} from "@mupt-ai/dari-router/policy-engine";
import { HttpError } from "../http/errors.js";

// The models each provider can serve to a coding agent, with the limits,
// thinking levels, and list prices a caller needs to pick and price one.
// Gateways (OpenRouter, Vercel AI Gateway) are listed live from their public
// models endpoints; model providers come from the bundled Pi catalog.

export type CatalogModel = {
  // Canonical `provider/native-id`; request it as `dari/model/<id>`.
  id: string;
  provider: string;
  native_model_id: string;
  name: string;
  context_window: number | null;
  max_output_tokens: number | null;
  input_modalities: string[];
  // Accepted thinking levels; ["off"] for models that do not reason.
  thinking_levels: ReasoningEffort[];
  // List price in USD per million tokens; null when the source publishes
  // none, e.g. meta-routers whose price depends on the model they pick.
  price: CatalogModelPrice | null;
  // When the price was read: the fetch time for gateways, the catalog's
  // generation time for model providers.
  price_as_of: string;
};

export type CatalogModelPrice = {
  input: number;
  output: number;
  cached_input: number | null;
  cache_write: number | null;
  // Long-context rates, each applying to prompts above its token threshold.
  tiers: CatalogPriceTier[];
};

export type CatalogPriceTier = {
  input_tokens_above: number;
  input: number;
  output: number;
  cached_input: number | null;
  cache_write: number | null;
};

export type ModelCatalogOptions = {
  // Providers to list; defaults to DEFAULT_CATALOG_PROVIDERS. Any Pi built-in
  // provider id is accepted.
  providers?: readonly string[] | undefined;
  fetch?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
  signal?: AbortSignal | undefined;
};

export const DEFAULT_CATALOG_PROVIDERS: readonly string[] = [
  "openai",
  "anthropic",
  "meta",
  "xai",
  "fireworks",
  "openrouter",
  "vercel-ai-gateway",
];

type LiveListing = {
  url: string;
  models: (data: unknown[], asOf: string) => CatalogModel[];
};

const LIVE_LISTINGS: Record<string, LiveListing> = {
  openrouter: { url: "https://openrouter.ai/api/v1/models", models: openRouterModels },
  "vercel-ai-gateway": { url: "https://ai-gateway.vercel.sh/v1/models", models: vercelModels },
};

/** List the agent-capable models of each requested provider. */
export async function listModelCatalog(options: ModelCatalogOptions = {}): Promise<CatalogModel[]> {
  const providers = [...new Set(options.providers ?? DEFAULT_CATALOG_PROVIDERS)];
  const builtin = new Set<string>(getBuiltinProviders());
  for (const provider of providers) {
    if (LIVE_LISTINGS[provider] === undefined && !builtin.has(provider)) {
      throw new HttpError(400, `Unknown catalog provider '${provider}'.`, "unknown_provider", "provider");
    }
  }
  const lists = await Promise.all(providers.map(async (provider) => {
    const listing = LIVE_LISTINGS[provider];
    return listing === undefined
      ? piModels(provider)
      : listing.models(await fetchListing(listing.url, options), new Date().toISOString());
  }));
  return lists.flat();
}

async function fetchListing(url: string, options: ModelCatalogOptions): Promise<unknown[]> {
  let status: number | undefined;
  let body: unknown = null;
  // Network errors, aborts, and unparseable bodies are upstream failures
  // too: all of them surface as catalog_unavailable rather than a raw 500.
  try {
    const response = await (options.fetch ?? fetch)(url, {
      headers: { accept: "application/json" },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    status = response.status;
    body = response.ok ? await response.json() : null;
  } catch {
    // Leaves body null.
  }
  if (!isRecord(body) || !Array.isArray(body.data)) {
    const detail = status === undefined ? "could not be reached" : `returned no model list (HTTP ${status})`;
    throw new HttpError(502, `${url} ${detail}.`, "catalog_unavailable");
  }
  return body.data;
}

function piModels(provider: string): CatalogModel[] {
  const generatedAt = getBuiltinModelDataGeneratedAt();
  const asOf = generatedAt === undefined ? "" : new Date(generatedAt).toISOString();
  const models = getBuiltinModels(provider as never) as unknown as Model<Api>[];
  return models.map((model) => ({
    id: `${provider}/${model.id}`,
    provider,
    native_model_id: model.id,
    name: model.name,
    context_window: model.contextWindow,
    max_output_tokens: model.maxTokens,
    input_modalities: [...model.input],
    thinking_levels: orderedEfforts(getSupportedThinkingLevels(model)),
    price: piPrice(model.cost),
    price_as_of: asOf,
  }));
}

function piPrice(cost: Model<Api>["cost"]): CatalogModelPrice {
  return {
    input: cost.input,
    output: cost.output,
    cached_input: cost.cacheRead,
    cache_write: cost.cacheWrite,
    tiers: (cost.tiers ?? []).map((tier) => ({
      input_tokens_above: tier.inputTokensAbove,
      input: tier.input,
      output: tier.output,
      cached_input: tier.cacheRead,
      cache_write: tier.cacheWrite,
    })),
  };
}

// https://openrouter.ai/docs/api/api-reference/models/get-models
function openRouterModels(data: unknown[], asOf: string): CatalogModel[] {
  return data.filter(isRecord).flatMap((model) => {
    const architecture = isRecord(model.architecture) ? model.architecture : {};
    const parameters = stringList(model.supported_parameters);
    if (typeof model.id !== "string" || !parameters.includes("tools")) return [];
    if (!stringList(architecture.output_modalities).includes("text")) return [];
    const reasoning = isRecord(model.reasoning) ? model.reasoning : {};
    const topProvider = isRecord(model.top_provider) ? model.top_provider : {};
    return [{
      id: `openrouter/${model.id}`,
      provider: "openrouter",
      native_model_id: model.id,
      name: typeof model.name === "string" ? model.name : model.id,
      context_window: positiveInteger(model.context_length),
      max_output_tokens: positiveInteger(topProvider.max_completion_tokens),
      input_modalities: stringList(architecture.input_modalities),
      thinking_levels: gatewayThinkingLevels({
        reasons: parameters.includes("reasoning"),
        efforts: Array.isArray(reasoning.supported_efforts) ? stringList(reasoning.supported_efforts) : null,
        canDisable: reasoning.mandatory !== true,
      }),
      price: isRecord(model.pricing) ? openRouterPrice(model.pricing) : null,
      price_as_of: asOf,
    }];
  });
}

function openRouterPrice(pricing: Record<string, unknown>): CatalogModelPrice | null {
  const base = rates(pricing, "prompt", "completion");
  if (base === null) return null;
  // Overrides restate only the rates they change; time-of-day overrides are
  // not context tiers.
  const tiers = (Array.isArray(pricing.overrides) ? pricing.overrides : [])
    .filter(isRecord)
    .flatMap((override) => {
      const threshold = positiveInteger(override.min_prompt_tokens);
      if (threshold === null || "utc_days" in override || "utc_start" in override || "utc_end" in override) {
        return [];
      }
      const tier = rates({ ...pricing, ...override }, "prompt", "completion", override);
      return tier === null ? [] : [{ input_tokens_above: threshold, ...tier }];
    });
  return { ...base, tiers };
}

// https://vercel.com/docs/ai-gateway/models-and-providers
function vercelModels(data: unknown[], asOf: string): CatalogModel[] {
  return data.filter(isRecord).flatMap((model) => {
    const modalities = isRecord(model.modalities) ? model.modalities : {};
    const parameters = stringList(model.supported_parameters);
    if (typeof model.id !== "string" || model.type !== "language" || !parameters.includes("tools")) return [];
    if (!stringList(modalities.output).includes("text")) return [];
    const options = Array.isArray(model.reasoning_options) ? model.reasoning_options.filter(isRecord) : [];
    const effort = options.find((option) => option.type === "effort");
    return [{
      id: `vercel-ai-gateway/${model.id}`,
      provider: "vercel-ai-gateway",
      native_model_id: model.id,
      name: typeof model.name === "string" ? model.name : model.id,
      context_window: positiveInteger(model.context_window),
      max_output_tokens: positiveInteger(model.max_tokens),
      input_modalities: stringList(modalities.input),
      thinking_levels: gatewayThinkingLevels({
        reasons: parameters.includes("reasoning") || options.length > 0,
        efforts: effort === undefined ? null : stringList(effort.values),
        canDisable: options.length === 0 || options.some((option) => option.type === "toggle"),
      }),
      price: isRecord(model.pricing) ? vercelPrice(model.pricing) : null,
      price_as_of: asOf,
    }];
  });
}

function vercelPrice(pricing: Record<string, unknown>): CatalogModelPrice | null {
  const base = rates(pricing, "input", "output");
  if (base === null) return null;
  // Each rate lists its own {cost, min, max} ranges; a range covers prompts of
  // at least `min` tokens, so it is the tier above `min - 1`.
  const ranged = new Map<number, Record<string, unknown>>();
  for (const key of ["input", "output", "input_cache_read", "input_cache_write"]) {
    const ranges = Array.isArray(pricing[`${key}_tiers`]) ? pricing[`${key}_tiers`] as unknown[] : [];
    for (const range of ranges.filter(isRecord)) {
      const start = positiveInteger(range.min);
      if (start === null || range.cost == null) continue;
      ranged.set(start - 1, { ...ranged.get(start - 1), [key]: range.cost });
    }
  }
  const tiers = [...ranged.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([threshold, stated]) => {
      const tier = rates({ ...pricing, ...stated }, "input", "output", stated);
      return tier === null ? [] : [{ input_tokens_above: threshold, ...tier }];
    });
  return { ...base, tiers };
}

// Base rates from per-token strings. A tier inherits input and output from
// the base price but states its own cache rates, or has none.
function rates(
  pricing: Record<string, unknown>,
  inputKey: string,
  outputKey: string,
  cacheRates: Record<string, unknown> = pricing,
): Omit<CatalogPriceTier, "input_tokens_above"> | null {
  const input = perMillion(pricing[inputKey]);
  const output = perMillion(pricing[outputKey]);
  // Meta-routers with variable prices list negative rates.
  if (input === null || output === null) return null;
  return {
    input,
    output,
    cached_input: perMillion(cacheRates.input_cache_read),
    cache_write: perMillion(cacheRates.input_cache_write),
  };
}

// USD per token as a decimal string -> USD per million tokens. Shifting the
// exponent in the string keeps "0.000001" exactly 1.
function perMillion(value: unknown): number | null {
  const rate = typeof value === "string" ? Number(`${value.trim()}e6`)
    : typeof value === "number" ? value * 1_000_000
    : Number.NaN;
  return Number.isFinite(rate) && rate >= 0 ? rate : null;
}

// Gateways forward `reasoning.effort`; models that reason without a stated
// effort list take the standard low/medium/high levels.
function gatewayThinkingLevels(args: {
  reasons: boolean;
  efforts: string[] | null;
  canDisable: boolean;
}): ReasoningEffort[] {
  if (!args.reasons) return ["off"];
  const efforts = args.efforts ?? ["low", "medium", "high"];
  return orderedEfforts([
    ...efforts.map((effort) => effort === "none" ? "off" : effort),
    ...(args.canDisable ? ["off"] : []),
  ]);
}

function orderedEfforts(levels: readonly string[]): ReasoningEffort[] {
  const accepted = new Set(levels.filter(isReasoningEffort));
  return REASONING_EFFORTS.filter((effort) => accepted.has(effort));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
