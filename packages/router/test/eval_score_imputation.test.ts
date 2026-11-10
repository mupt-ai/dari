import { expect, test } from "bun:test";

import {
  createTaskCostRatios,
  createThinkingLevelRatios,
  resolveRouterEvalScore,
  resolveRouterEvalTaskCost,
} from "../src/eval_score_imputation.js";
import type { RouterEval } from "../src/types.js";

function evalCard(
  id: string,
  scores: RouterEval["scores"],
  minScore = 0,
  maxScore = 100,
): RouterEval {
  return {
    id,
    name: id,
    min_score: minScore,
    max_score: maxScore,
    scores,
  };
}

test("resolves exact and generic rows before imputation", () => {
  const scores = [
    { model_id: "openai/exact", thinking_level: "high" as const, score: 84 },
    { model_id: "anthropic/generic", thinking_level: null, score: 91 },
  ];
  const common = { scores, minScore: 0, maxScore: 100 };

  expect(
    resolveRouterEvalScore({
      ...common,
      modelId: "openai/exact",
      thinkingLevel: "high",
      impute: true,
    }),
  ).toEqual({ score: 84, imputed: false });
  expect(
    resolveRouterEvalScore({
      ...common,
      modelId: "anthropic/generic",
      thinkingLevel: "low",
      impute: true,
    }),
  ).toEqual({ score: 91, imputed: false });
});

test("borrows only a named predecessor when the current generation has no measured score", () => {
  const scores = [
    { model_id: "anthropic/claude-opus-5", thinking_level: "high" as const, score: 73 },
    { model_id: "anthropic/claude-opus-5-5", thinking_level: "low" as const, score: 82 },
  ];
  const common = { scores, minScore: 0, maxScore: 100, impute: true };
  expect(resolveRouterEvalScore({
    ...common, modelId: "anthropic/claude-opus-5-5", thinkingLevel: "high",
  })).toEqual({ score: 82, imputed: true, sourceModelId: "anthropic/claude-opus-5" });
  expect(resolveRouterEvalScore({
    ...common, modelId: "anthropic/claude-sonnet-5", thinkingLevel: "high",
  })).toBeNull();
  expect(resolveRouterEvalScore({
    ...common, modelId: "anthropic/claude-opus-5-5", thinkingLevel: "low",
  })).toEqual({ score: 82, imputed: false });
  expect(resolveRouterEvalScore({
    scores: scores.slice(0, 1), minScore: 0, maxScore: 100,
    modelId: "anthropic/claude-opus-5-5", thinkingLevel: "high", impute: false,
  })).toBeNull();
  expect(resolveRouterEvalScore({
    scores: scores.slice(0, 1), minScore: 0, maxScore: 100,
    modelId: "anthropic/claude-opus-5-5", thinkingLevel: "high", impute: true,
  })).toEqual({ score: 73, imputed: true, sourceModelId: "anthropic/claude-opus-5" });
});

test("uses GPT-6 Sol scores for GPT-6.1 Sol only when its score is missing", () => {
  const scores = [
    { model_id: "openai/gpt-6-sol", thinking_level: "high" as const, score: 87 },
    { model_id: "openai/gpt-6-sol", thinking_level: null, score: 79 },
    { model_id: "openai/gpt-6.1-sol", thinking_level: "low" as const, score: 93 },
  ];
  const common = { scores, minScore: 0, maxScore: 100, impute: true };

  expect(resolveRouterEvalScore({
    ...common, modelId: "openai/gpt-6.1-sol", thinkingLevel: "high",
  })).toEqual({
    score: 93,
    imputed: true,
    sourceModelId: "openai/gpt-6-sol",
  });
  expect(resolveRouterEvalScore({
    ...common, modelId: "openai/gpt-6.1-sol", thinkingLevel: "medium",
  })).toEqual({
    score: 93,
    imputed: true,
    sourceModelId: "openai/gpt-6-sol",
  });
  expect(resolveRouterEvalScore({
    ...common, modelId: "openai/gpt-6.1-sol", thinkingLevel: "low",
  })).toEqual({ score: 93, imputed: false });
  expect(resolveRouterEvalScore({
    scores: scores.slice(0, 2), minScore: 0, maxScore: 100,
    modelId: "openai/gpt-6.1-sol", thinkingLevel: "high", impute: false,
  })).toBeNull();
});

test("uses only the model owner's graph for score and task-cost estimates", () => {
  const reference = evalCard("reference", [
    { model_id: "openai/calibrator", thinking_level: "low", score: 20, cost_per_task_usd: 1 },
    { model_id: "openai/calibrator", thinking_level: "high", score: 40, cost_per_task_usd: 2 },
    { model_id: "anthropic/calibrator", thinking_level: "low", score: 40, cost_per_task_usd: 2 },
    { model_id: "anthropic/calibrator", thinking_level: "high", score: 20, cost_per_task_usd: 1 },
  ]);
  const ratios = createThinkingLevelRatios([reference]);
  const costRatios = createTaskCostRatios([reference]);
  for (const [owner, score, cost] of [["openai", 80, 6], ["anthropic", 40, 1.5]] as const) {
    const modelId = `${owner}/target`;
    const scores = [{ model_id: modelId, thinking_level: "low" as const, score: 40, cost_per_task_usd: 3 }];
    expect(resolveRouterEvalScore({ scores, modelId, thinkingLevel: "high", minScore: 0, maxScore: 100, impute: true, ratios }))
      .toEqual({ score, imputed: true });
    expect(resolveRouterEvalTaskCost({ scores, modelId, thinkingLevel: "high", impute: true, ratios: costRatios }))
      .toBe(cost);
  }
  for (const modelId of ["unknown/target", "unqualified"]) {
    const scores = [{ model_id: modelId, thinking_level: "low" as const, score: 40, cost_per_task_usd: 3 }];
    expect(resolveRouterEvalScore({ scores, modelId, thinkingLevel: "high", minScore: 0, maxScore: 100, impute: true, ratios })).toBeNull();
    expect(resolveRouterEvalTaskCost({ scores, modelId, thinkingLevel: "high", impute: true, ratios: costRatios })).toBeNull();
  }
});

test("row preparation ignores generic, invalid, and unqualified calibration rows", () => {
  const ratios = createThinkingLevelRatios([
    evalCard("invalid-range", [
      { model_id: "openai/a", thinking_level: "low", score: 20 },
      { model_id: "openai/a", thinking_level: "high", score: 80 },
    ], 100, 100),
    evalCard("reference", [
      { model_id: "OpenAI/a", thinking_level: "low", score: 20 },
      { model_id: "OpenAI/a", thinking_level: "low", score: 90 },
      { model_id: "OpenAI/a", thinking_level: "high", score: 40 },
      { model_id: "openai/generic", thinking_level: null, score: 100 },
      { model_id: "openai/generic", thinking_level: "low", score: 20 },
      { model_id: "openai/invalid", thinking_level: "low", score: 20 },
      { model_id: "openai/invalid", thinking_level: "high", score: Number.NaN },
      { model_id: "unqualified", thinking_level: "low", score: 20 },
      { model_id: "unqualified", thinking_level: "high", score: 80 },
    ]),
  ]);
  expect([...ratios.keys()]).toEqual(["openai"]);
  expect(resolveRouterEvalScore({
    scores: [{ model_id: "openai/target", thinking_level: "low", score: 30 }],
    modelId: "openai/target", thinkingLevel: "high", minScore: 0, maxScore: 100,
    impute: true, ratios,
  })).toEqual({ score: 60, imputed: true });
});

test("cannot bridge a missing owner edge through another provider", () => {
  const reference = evalCard("reference", [
    { model_id: "openai/a", thinking_level: "low", score: 20 },
    { model_id: "openai/a", thinking_level: "medium", score: 40 },
    { model_id: "anthropic/b", thinking_level: "medium", score: 40 },
    { model_id: "anthropic/b", thinking_level: "high", score: 60 },
  ]);
  expect(resolveRouterEvalScore({
    scores: [{ model_id: "openai/target", thinking_level: "low", score: 30 }],
    modelId: "openai/target", thinkingLevel: "high", minScore: 0, maxScore: 100,
    impute: true, ratios: createThinkingLevelRatios([reference]),
  })).toBeNull();
});

test("predecessor level estimates use only the predecessor owner's graph", () => {
  const scores = [{ model_id: "openai/gpt-6-sol", thinking_level: "low" as const, score: 30 }];
  const common = { scores, modelId: "openai/gpt-6.1-sol", thinkingLevel: "high" as const, minScore: 0, maxScore: 100, impute: true };
  const reference = (owner: string) => evalCard("reference", [
    { model_id: `${owner}/calibrator`, thinking_level: "low", score: 20 },
    { model_id: `${owner}/calibrator`, thinking_level: "high", score: 40 },
  ]);
  expect(resolveRouterEvalScore({ ...common, ratios: createThinkingLevelRatios([reference("anthropic")]) })).toBeNull();
  expect(resolveRouterEvalScore({ ...common, ratios: createThinkingLevelRatios([reference("openai")]) }))
    .toEqual({ score: 60, imputed: true, sourceModelId: "openai/gpt-6-sol" });
});

test("uses ratios learned from every supplied calibration eval", () => {
  const target = evalCard("target", [
    { model_id: "openai/target", thinking_level: "low", score: 40 },
  ]);
  const reference = evalCard("reference", [
    { model_id: "openai/calibrator", thinking_level: "low", score: 20 },
    { model_id: "openai/calibrator", thinking_level: "medium", score: 40 },
  ]);

  expect(
    resolveRouterEvalScore({
      scores: target.scores,
      modelId: "openai/target",
      thinkingLevel: "medium",
      minScore: target.min_score,
      maxScore: target.max_score,
      impute: true,
      ratios: createThinkingLevelRatios([target, reference]),
    }),
  ).toEqual({ score: 80, imputed: true });
});

test("chains pairwise ratios through intermediate thinking levels", () => {
  const designArena = evalCard(
    "designarena",
    [{
      model_id: "openai/gpt-5.6-sol",
      thinking_level: "medium",
      score: 1351,
    }],
    0,
    3000,
  );
  const mediumToMax = evalCard("medium-to-max", [
    { model_id: "openai/a", thinking_level: "medium", score: 50 },
    { model_id: "openai/a", thinking_level: "max", score: 60 },
  ]);
  const maxToXhigh = evalCard("max-to-xhigh", [
    { model_id: "openai/b", thinking_level: "max", score: 40 },
    { model_id: "openai/b", thinking_level: "xhigh", score: 44 },
  ]);

  expect(
    resolveRouterEvalScore({
      scores: designArena.scores,
      modelId: "openai/gpt-5.6-sol",
      thinkingLevel: "xhigh",
      minScore: designArena.min_score,
      maxScore: designArena.max_score,
      impute: true,
      ratios: createThinkingLevelRatios([
        designArena,
        mediumToMax,
        maxToXhigh,
      ]),
    }),
  ).toEqual({ score: 1783.32, imputed: true });
});

test("prefers a direct ratio over transitive calibration paths", () => {
  const target = evalCard("target", [
    { model_id: "openai/target", thinking_level: "medium", score: 50 },
  ]);
  const mediumToMax = evalCard("medium-to-max", [
    { model_id: "openai/a", thinking_level: "medium", score: 25 },
    { model_id: "openai/a", thinking_level: "max", score: 50 },
  ]);
  const maxToXhigh = evalCard("max-to-xhigh", [
    { model_id: "openai/b", thinking_level: "max", score: 25 },
    { model_id: "openai/b", thinking_level: "xhigh", score: 50 },
  ]);
  const direct = evalCard("direct", [
    { model_id: "openai/c", thinking_level: "medium", score: 50 },
    { model_id: "openai/c", thinking_level: "xhigh", score: 60 },
  ]);

  expect(
    resolveRouterEvalScore({
      scores: target.scores,
      modelId: "openai/target",
      thinkingLevel: "xhigh",
      minScore: target.min_score,
      maxScore: target.max_score,
      impute: true,
      ratios: createThinkingLevelRatios([
        target,
        mediumToMax,
        maxToXhigh,
        direct,
      ]),
    }),
  ).toEqual({ score: 60, imputed: true });
});

test("normalizes negative and differently-sized calibration scales", () => {
  const target = evalCard(
    "target",
    [{ model_id: "openai/target", thinking_level: "low", score: -20 }],
    -100,
    100,
  );
  const reference = evalCard(
    "reference",
    [
      { model_id: "openai/calibrator", thinking_level: "low", score: 20 },
      { model_id: "openai/calibrator", thinking_level: "medium", score: 40 },
    ],
    0,
    100,
  );

  expect(
    resolveRouterEvalScore({
      scores: target.scores,
      modelId: "openai/target",
      thinkingLevel: "medium",
      minScore: target.min_score,
      maxScore: target.max_score,
      impute: true,
      ratios: createThinkingLevelRatios([target, reference]),
    }),
  ).toEqual({ score: 60, imputed: true });
});

test("rejects estimates beyond a bounded scorecard", () => {
  const target = evalCard("target", [
    { model_id: "openai/target", thinking_level: "low", score: 40 },
  ]);
  const reference = evalCard("reference", [
    { model_id: "openai/calibrator", thinking_level: "low", score: 20 },
    { model_id: "openai/calibrator", thinking_level: "medium", score: 60 },
  ]);

  expect(
    resolveRouterEvalScore({
      scores: target.scores,
      modelId: "openai/target",
      thinkingLevel: "medium",
      minScore: target.min_score,
      maxScore: target.max_score,
      impute: true,
      ratios: createThinkingLevelRatios([target, reference]),
    }),
  ).toBeNull();
});

test("scales a model's priced level by cost ratios and never borrows a predecessor's cost", () => {
  const ratios = createTaskCostRatios([
    evalCard("calibration", [
      { model_id: "zai-org/calibrator", thinking_level: "low", score: 50, cost_per_task_usd: 0.5 },
      { model_id: "zai-org/calibrator", thinking_level: "high", score: 60, cost_per_task_usd: 2 },
    ]),
  ]);
  const scores = [
    { model_id: "zai-org/GLM-5.3", thinking_level: "low" as const, score: 40, cost_per_task_usd: 1 },
    { model_id: "openai/gpt-6-sol", thinking_level: "high" as const, score: 80, cost_per_task_usd: 2 },
  ];
  const common = { scores, impute: true, ratios };

  expect(resolveRouterEvalTaskCost({ ...common, modelId: "zai-org/GLM-5.3", thinkingLevel: "low" })).toBe(1);
  expect(resolveRouterEvalTaskCost({ ...common, modelId: "zai-org/GLM-5.3", thinkingLevel: "high" })).toBe(4);
  expect(resolveRouterEvalTaskCost({ ...common, modelId: "openai/gpt-6.1-sol", thinkingLevel: "high" })).toBeNull();
  expect(resolveRouterEvalTaskCost({ ...common, impute: false, modelId: "zai-org/GLM-5.3", thinkingLevel: "high" }))
    .toBeNull();
});
