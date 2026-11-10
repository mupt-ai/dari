import { expect, test } from "bun:test";
import { codexModelsResponse } from "./codex_models.js";
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

test("routers without autorouting list only their explicit models", () => {
  const response = codexModelsResponse(
    { enabled_models: ["bounded"], model_configs: { bounded: config }, autorouting_enabled: false },
    () => false,
  );
  expect((response.models as Array<Record<string, unknown>>).map((model) => model.slug)).toEqual(["dari/model/bounded"]);
});
