import { expect, test } from "bun:test";
import { codexModelsEtag, codexModelsResponse } from "./codex_models.js";
import type { ResolvedRouterModelConfig } from "../types.js";

const config: ResolvedRouterModelConfig = {
  provider: "openai", native_model_id: "test", api: "openai-responses",
  context_window: 1_050_000, standard_context_limit: 272_000,
  cost: { input: 1, output: 2 },
};

test("Codex direct models expose thinking choices without overriding router thinking", () => {
  const response = codexModelsResponse({
    enabled_models: ["test"],
    model_configs: { test: { ...config, supported_thinking_levels: ["off", "low", "high"], default_thinking_level: "high" } },
  }, () => false);
  const models = response.models as Array<Record<string, unknown>>;
  expect(models[0]!.supported_reasoning_levels).toEqual([]);
  expect(models[1]!.default_reasoning_level).toBe("high");
  expect(models[1]!.supported_reasoning_levels).toEqual([
    { effort: "none", description: "none thinking" },
    { effort: "low", description: "low thinking" },
    { effort: "high", description: "high thinking" },
  ]);
});

test("Codex advertises the largest usable candidate window", () => {
  const response = codexModelsResponse({
    enabled_models: ["bounded", "uncapped"],
    model_configs: {
      bounded: config,
      uncapped: { ...config, context_window: 1_000_000, standard_context_limit: null },
    },
  }, () => false);
  expect((response.models as Array<Record<string, unknown>>)[0]!.context_window).toBe(1_000_000);
});

test("a bounded-only Codex router stays in its standard-price range", () => {
  const response = codexModelsResponse({ enabled_models: ["bounded"], model_configs: { bounded: config } }, () => false);
  expect((response.models as Array<Record<string, unknown>>)[0]!.context_window).toBe(272_000);
});

test("Codex lists each enabled model as an explicit dari/model slug after dari/routing", () => {
  const response = codexModelsResponse(
    { enabled_models: ["bounded", "uncapped"], model_configs: { bounded: config, uncapped: { ...config, standard_context_limit: null } } },
    (model) => model === "uncapped",
  );
  const models = response.models as Array<Record<string, unknown>>;
  expect(models.map((model) => model.slug)).toEqual(["dari/routing", "dari/model/bounded", "dari/model/uncapped"]);
  expect(models[1]!.context_window).toBe(272_000);
  expect(models[1]!.input_modalities).toEqual(["text"]);
  expect(models[2]!.input_modalities).toEqual(["text", "image"]);
  expect(models[2]!.auto_review_model_override).toBe("dari/model/uncapped");
  expect(models[0]!.input_modalities).toEqual(["text", "image"]);
});

// Without the Autorouting plan, or on a self-hosted gateway without Dari Auto
// Routing, dari/routing would only serve the first model.
test("routers without autorouting list only their explicit models", () => {
  for (const off of [{ autorouting_enabled: false }, { routing_listed: false }]) {
    const response = codexModelsResponse(
      { enabled_models: ["bounded"], model_configs: { bounded: config }, ...off },
      () => false,
    );
    expect((response.models as Array<Record<string, unknown>>).map((model) => model.slug)).toEqual(["dari/model/bounded"]);
  }
});

test("Codex learns the router's native compaction protocol from the catalog", () => {
  expect(codexModelsResponse({ enabled_models: ["test"], model_configs: { test: config } }, () => false).remote_compaction)
    .toBe("unsupported");
  const router = { enabled_models: ["test"], model_configs: { test: config }, native_compaction: true };
  expect(codexModelsResponse(router, () => false, () => true).remote_compaction).toBe("v2");
  // No enabled model could read the compaction items Codex would send.
  expect(codexModelsResponse(router, () => false, () => false).remote_compaction).toBe("unsupported");
});

const levels = (model: Record<string, unknown>) =>
  (model.supported_reasoning_levels as Array<{ effort: string }>).map((level) => level.effort);

const gpt: ResolvedRouterModelConfig = {
  ...config, supported_thinking_levels: ["off", "low", "medium", "high", "xhigh", "max"], default_thinking_level: "medium",
};

test("a pinned model's menu offers only the thinking levels the router serves", () => {
  const response = codexModelsResponse({
    enabled_models: ["medium-only", "low-high", "unset"],
    model_configs: { "medium-only": gpt, "low-high": gpt, unset: gpt },
    model_thinking_levels: { "medium-only": ["medium"], "low-high": ["low", "high"] },
  }, () => false);
  const [, mediumOnly, lowHigh, unset] = response.models as Array<Record<string, unknown>>;
  expect(levels(mediumOnly!)).toEqual(["medium"]);
  expect(mediumOnly!.default_reasoning_level).toBe("medium");
  // The model default (medium) is not served, so the gateway serves the
  // router's first level instead, and the menu says so.
  expect(levels(lowHigh!)).toEqual(["low", "high"]);
  expect(lowHigh!.default_reasoning_level).toBe("low");
  // No router levels: every level the model supports is served.
  expect(levels(unset!)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  expect(unset!.default_reasoning_level).toBe("medium");
});

test("the menu keeps the model's level order and drops levels the model lacks", () => {
  const response = codexModelsResponse({
    enabled_models: ["test"],
    model_configs: { test: { ...gpt, supported_thinking_levels: ["low", "medium", "high"] } },
    model_thinking_levels: { test: ["max", "high", "low"] },
  }, () => false);
  const model = (response.models as Array<Record<string, unknown>>)[1]!;
  expect(levels(model)).toEqual(["low", "high"]);
  // The gateway's fallback is the first served level in the router's order.
  expect(model.default_reasoning_level).toBe("high");
});

test("a router level the model cannot serve leaves no choice and no default", () => {
  const response = codexModelsResponse({
    enabled_models: ["test"],
    model_configs: { test: { ...gpt, supported_thinking_levels: ["low", "high"] } },
    model_thinking_levels: { test: ["max"] },
  }, () => false);
  const model = (response.models as Array<Record<string, unknown>>)[1]!;
  expect(levels(model)).toEqual([]);
  expect(model.default_reasoning_level).toBeNull();
});

test("the Codex models etag changes when a pinned model's thinking levels change", () => {
  const router = { enabled_models: ["test"], model_configs: { test: gpt } };
  const medium = codexModelsEtag({ ...router, model_thinking_levels: { test: ["medium"] } });
  expect(codexModelsEtag({ ...router, model_thinking_levels: { test: ["medium"] } })).toBe(medium);
  expect(codexModelsEtag({ ...router, model_thinking_levels: { test: ["medium", "high"] } })).not.toBe(medium);
});
