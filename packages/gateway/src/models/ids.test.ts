import { expect, test } from "bun:test";

import { requireCandidateModels } from "./ids.js";

test("validates candidate models", () => {
  expect(requireCandidateModels(["openai/gpt-4.1-mini", "openai/gpt-4.1-mini", "zai-org/GLM-5.2"])).toEqual([
    "openai/gpt-4.1-mini",
    "zai-org/GLM-5.2",
  ]);
  expect(() => requireCandidateModels([])).toThrow();
  expect(() => requireCandidateModels(["bad-model"])).toThrow();
});
