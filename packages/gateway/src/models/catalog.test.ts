import { expect, test } from "bun:test";

import { createRequestHandler } from "../http/handler.js";
import { createPrioritySelectorBackend } from "../strategies/priority_selector.js";
import { testPlatform } from "../test_support/platform.js";
import type { ResolvedRouter } from "../types.js";
import { listModelCatalog, type CatalogModel } from "./catalog.js";
import { OPENROUTER_MODELS, VERCEL_MODELS } from "./catalog.fixtures.js";

const LISTINGS: Record<string, unknown> = {
  "https://openrouter.ai/api/v1/models": OPENROUTER_MODELS,
  "https://ai-gateway.vercel.sh/v1/models": VERCEL_MODELS,
};

const fixtureFetch = async (url: string) =>
  LISTINGS[url] === undefined ? new Response("missing", { status: 404 }) : Response.json(LISTINGS[url]);

async function gatewayModels(provider: string): Promise<Map<string, CatalogModel>> {
  const models = await listModelCatalog({ providers: [provider], fetch: fixtureFetch });
  return new Map(models.map((model) => [model.id, model]));
}

test("OpenRouter lists tool-capable text models with per-million prices and context tiers", async () => {
  const models = await gatewayModels("openrouter");
  expect([...models.keys()]).toEqual([
    "openrouter/openai/gpt-6.1-terra",
    "openrouter/anthropic/claude-sonnet-5.5",
    "openrouter/openrouter/auto",
    "openrouter/deepseek/deepseek-v4.1-flash-1017",
  ]);
  expect(models.get("openrouter/openai/gpt-6.1-terra")).toMatchObject({
    provider: "openrouter",
    native_model_id: "openai/gpt-6.1-terra",
    context_window: 1_050_000,
    max_output_tokens: 128_000,
    input_modalities: ["file", "image", "text"],
    thinking_levels: ["off", "low", "medium", "high", "xhigh", "max"],
    price: {
      input: 1,
      output: 5,
      cached_input: 0.05,
      cache_write: 1.25,
      tiers: [{ input_tokens_above: 272_000, input: 2, output: 7.5, cached_input: 0.1, cache_write: 2.5 }],
    },
  });
  // Mandatory reasoning cannot be turned off.
  expect(models.get("openrouter/anthropic/claude-sonnet-5.5")!.thinking_levels)
    .toEqual(["low", "medium", "high", "xhigh", "max"]);
  // Meta-routers list negative, model-dependent prices.
  expect(models.get("openrouter/openrouter/auto")!.price).toBeNull();
  // Time-of-day overrides are not context tiers.
  expect(models.get("openrouter/deepseek/deepseek-v4.1-flash-1017")!.price!.tiers).toEqual([]);
});

test("Vercel AI Gateway lists tool-capable language models with ranged tiers", async () => {
  const models = await gatewayModels("vercel-ai-gateway");
  expect([...models.keys()]).toEqual([
    "vercel-ai-gateway/alibaba/qwen3-max-thinking",
    "vercel-ai-gateway/alibaba/qwen-3-14b",
    "vercel-ai-gateway/alibaba/qwen3.5-plus",
  ]);
  expect(models.get("vercel-ai-gateway/alibaba/qwen3-max-thinking")).toMatchObject({
    context_window: 256_000,
    max_output_tokens: 65_536,
    // Budget-only reasoning without a toggle: standard efforts, never off.
    thinking_levels: ["low", "medium", "high"],
    price: {
      input: 1.2,
      output: 6,
      cached_input: 0.24,
      cache_write: null,
      tiers: [
        { input_tokens_above: 32_000, input: 2.4, output: 12, cached_input: 0.48, cache_write: null },
        { input_tokens_above: 128_000, input: 3, output: 15, cached_input: 0.6, cache_write: null },
      ],
    },
  });
  expect(models.get("vercel-ai-gateway/alibaba/qwen-3-14b")!.thinking_levels).toEqual(["off", "low", "medium", "high"]);
  expect(models.get("vercel-ai-gateway/alibaba/qwen3.5-plus")).toMatchObject({
    thinking_levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    price: {
      input: 0.4,
      cache_write: 0.5,
      tiers: [{ input_tokens_above: 256_000, input: 0.5, output: 3, cached_input: 0.05, cache_write: 0.625 }],
    },
  });
});

test("model providers come from the bundled catalog without fetching", async () => {
  const models = await listModelCatalog({
    providers: ["meta"],
    fetch: async () => {
      throw new Error("unexpected fetch");
    },
  });
  expect(models.find((model) => model.id === "meta/muse-spark-1.3")).toMatchObject({
    provider: "meta",
    native_model_id: "muse-spark-1.3",
    name: "Muse Spark 1.3",
    context_window: 1_048_576,
    max_output_tokens: 131_072,
    thinking_levels: ["minimal", "low", "medium", "high", "xhigh", "max"],
    price: { input: 1.25, output: 4.25, cached_input: 0.15 },
  });
  expect(Number.isNaN(Date.parse(models[0]!.price_as_of))).toBe(false);
});

test("unknown providers and failed listings are errors", async () => {
  await expect(listModelCatalog({ providers: ["nope"] })).rejects.toMatchObject({ code: "unknown_provider" });
  await expect(listModelCatalog({
    providers: ["openrouter"],
    fetch: async () => new Response("down", { status: 503 }),
  })).rejects.toMatchObject({ status: 502, code: "catalog_unavailable" });
  for (const failingFetch of [
    async () => { throw new TypeError("fetch failed"); },
    async () => new Response("<html>not json</html>", { status: 200 }),
    async () => { throw new DOMException("The operation was aborted.", "AbortError"); },
  ]) {
    await expect(listModelCatalog({ providers: ["openrouter"], fetch: failingFetch }))
      .rejects.toMatchObject({ status: 502, code: "catalog_unavailable" });
  }
});

test("GET /v1/models?detail=1 returns the catalog to an authenticated caller", async () => {
  const handler = createRequestHandler({
    platform: testPlatform({
      async resolveRouter({ apiKey }) {
        if (apiKey !== "gw-key") throw new Error("bad key");
        const router: ResolvedRouter = {
          router_id: "default",
          organization_id: "org",
          api_key_id: null,
          attributed_user_id: null,
          enabled_models: [],
          provider_keys: {},
        };
        return router;
      },
    }),
    selectorBackend: createPrioritySelectorBackend(),
  });
  const get = (query: string) => handler(new Request(`http://gateway.test/v1/models?${query}`, {
    headers: { authorization: "Bearer gw-key" },
  }));

  const response = await get("detail=1&provider=meta");
  expect(response.status).toBe(200);
  const body = await response.json() as { object: string; data: CatalogModel[] };
  expect(body.object).toBe("list");
  expect(body.data.every((model) => model.provider === "meta")).toBe(true);
  expect(body.data.map((model) => model.id)).toContain("meta/muse-wonder-1.0");

  expect((await get("detail=1&provider=nope")).status).toBe(400);
});
