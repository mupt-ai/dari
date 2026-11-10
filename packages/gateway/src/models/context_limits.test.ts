import { expect, test } from "bun:test";
import { effectiveContextWindow } from "./context_limits.js";
import type { ResolvedRouterModelConfig } from "../types.js";

const config: ResolvedRouterModelConfig = {
  provider: "openai",
  native_model_id: "gpt-6-astra",
  api: "openai-responses",
  context_window: 1_050_000,
  cost: { input: 10, output: 50, cached_input: 1, cache_write: 12.5 },
};

test("standard-price caps apply only to tiered models", () => {
  expect(effectiveContextWindow(config)).toBe(1_050_000);
  expect(effectiveContextWindow({ ...config, standard_context_limit: 272_000 })).toBe(272_000);
  expect(effectiveContextWindow({ ...config, context_window: 128_000, standard_context_limit: 272_000 })).toBe(128_000);
  expect(effectiveContextWindow(undefined)).toBeNull();
  expect(effectiveContextWindow({ ...config, standard_context_limit: 272_000 }, true)).toBe(1_050_000);
});
