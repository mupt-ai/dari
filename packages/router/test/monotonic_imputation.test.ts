import { expect, test } from "bun:test";

import {
  createThinkingLevelRatios,
  resolveRouterEvalScore,
  type EvalScoreForImputation,
} from "../src/eval_score_imputation.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "../src/types.js";

const modelId = "openai/target";
const row = (thinking_level: ReasoningEffort, score: number): EvalScoreForImputation =>
  ({ model_id: modelId, thinking_level, score });

function resolver(scores: EvalScoreForImputation[], calibration = scores) {
  const ratios = createThinkingLevelRatios([{ min_score: 0, max_score: 100, scores: calibration }]);
  return (thinkingLevel: ReasoningEffort) => resolveRouterEvalScore({
    scores, modelId, thinkingLevel, minScore: 0, maxScore: 100, impute: true, ratios,
  });
}

function calibrator(levels: Partial<Record<ReasoningEffort, number>>) {
  return Object.entries(levels).map(([level, score]) => ({
    model_id: "openai/calibrator", thinking_level: level as ReasoningEffort, score,
  }));
}

test("higher effort estimates never fall below measured lower effort", () => {
  const scores = [row("low", 80)];
  const resolve = resolver(scores, calibrator({ low: 80, medium: 60, high: 40 }));
  expect(resolve("medium")).toEqual({ score: 80, imputed: true });
  expect(resolve("high")).toEqual({ score: 80, imputed: true });
  expect(resolve("low")).toEqual({ score: 80, imputed: false });
  expect(scores).toEqual([row("low", 80)]);
});

test("lower effort estimates never exceed measured higher effort", () => {
  const resolve = resolver([row("high", 60)], calibrator({ low: 80, medium: 70, high: 60 }));
  expect(resolve("low")).toEqual({ score: 60, imputed: true });
  expect(resolve("medium")).toEqual({ score: 60, imputed: true });
  expect(resolve("high")).toEqual({ score: 60, imputed: false });
});

test("prefix maxima keep estimates ordered independently of requested candidates", () => {
  const resolve = resolver([row("low", 40)], calibrator({ low: 40, medium: 80, high: 60, xhigh: 70 }));
  expect(resolve("high")).toEqual({ score: 80, imputed: true });
  expect(resolve("medium")).toEqual({ score: 80, imputed: true });
  expect(resolve("xhigh")).toEqual({ score: 80, imputed: true });
});

test("earlier estimates are capped before propagating through measured levels", () => {
  const resolve = resolver([row("low", 40), row("high", 60)], calibrator({ low: 20, medium: 40, high: 10, max: 10 }));
  expect(resolve("medium")).toEqual({ score: 60, imputed: true });
  expect(resolve("high")).toEqual({ score: 60, imputed: false });
  expect(resolve("max")).toEqual({ score: 60, imputed: true });
});

test("measured regressions remain unchanged; impossible missing intervals stay blank", () => {
  const resolve = resolver([row("low", 90), row("high", 70)], calibrator({ low: 50, medium: 60, high: 70, max: 80 }));
  expect(resolve("low")).toEqual({ score: 90, imputed: false });
  expect(resolve("high")).toEqual({ score: 70, imputed: false });
  expect(resolve("medium")).toBeNull();
  expect(resolve("max")?.score).toBeGreaterThanOrEqual(90);
});

test("generic scores remain untouched and missing paths stay missing", () => {
  const generic = resolver([{ model_id: modelId, score: 55 }]);
  for (const level of REASONING_EFFORTS) expect(generic(level)).toEqual({ score: 55, imputed: false });
  expect(resolver([row("low", 80)])("high")).toBeNull();
});

test("predecessor estimates cannot undercut current measured lower effort", () => {
  const scores: EvalScoreForImputation[] = [
    { model_id: "openai/gpt-6.1-sol", thinking_level: "low", score: 93 },
    { model_id: "openai/gpt-6-sol", thinking_level: "high", score: 87 },
  ];
  expect(resolveRouterEvalScore({ scores, modelId: "openai/gpt-6.1-sol", thinkingLevel: "high", minScore: 0, maxScore: 100, impute: true }))
    .toEqual({ score: 93, imputed: true, sourceModelId: "openai/gpt-6-sol" });
});

test("all fillable effort pairs remain ordered without changing any measured row", () => {
  for (const values of [
    [20, 40, 60, 80, 90, 70, 50],
    [90, 80, 70, 60, 50, 40, 20],
  ]) {
    for (let mask = 1; mask < 1 << REASONING_EFFORTS.length; mask++) {
      const scores = REASONING_EFFORTS.flatMap((level, index) =>
        mask & (1 << index) ? [row(level, values[index]!)] : [],
      );
      const resolve = resolver(scores, calibrator({ off: 40, minimal: 30, low: 50, medium: 20, high: 60, xhigh: 45, max: 55 }));
      const resolved = REASONING_EFFORTS.map(resolve);
      for (const measured of scores) {
        expect(resolve(measured.thinking_level!)!).toEqual({ score: measured.score, imputed: false });
      }
      for (let left = 0; left < resolved.length; left++) {
        for (let right = left + 1; right < resolved.length; right++) {
          const a = resolved[left];
          const b = resolved[right];
          if (a && b && (a.imputed || b.imputed)) expect(a.score).toBeLessThanOrEqual(b.score);
        }
      }
    }
  }
});

test("zero-valued evidence remains valid", () => {
  const resolve = resolver([row("high", 0)], calibrator({ low: 40, medium: 50, high: 60 }));
  expect(resolve("high")).toEqual({ score: 0, imputed: false });
  // No raw estimate exists from an anchor at the score floor.
  expect(resolve("low")).toBeNull();
});
