import { expect, test } from "bun:test";

import {
  buildThinkingLevelGraphs,
  thinkingLevelRatio,
  type ThinkingLevelObservation,
} from "../src/thinking_level_graph.js";
import type { ReasoningEffort } from "../src/types.js";

function observation(
  provider: string,
  levels: Partial<Record<ReasoningEffort, number>>,
): ThinkingLevelObservation {
  return { provider, levels: new Map(Object.entries(levels) as [ReasoningEffort, number][]) };
}

test("averages directed edges within each provider, not across providers", () => {
  const graphs = buildThinkingLevelGraphs([
    observation("openai", { low: 20, high: 40 }),
    observation("openai", { low: 40, high: 60 }),
    observation("anthropic", { low: 40, high: 20 }),
  ]);
  expect(thinkingLevelRatio(graphs, "openai", "low", "high")).toBe(1.75);
  expect(thinkingLevelRatio(graphs, "anthropic", "low", "high")).toBe(0.5);
  expect(thinkingLevelRatio(graphs, "openai", "high", "low")).toBeCloseTo(7 / 12);
  expect(thinkingLevelRatio(graphs, "unknown", "low", "high")).toBeUndefined();
});

test("does not pair levels from separate observations", () => {
  const graphs = buildThinkingLevelGraphs([
    observation("openai", { low: 20 }),
    observation("openai", { high: 40 }),
  ]);
  expect(thinkingLevelRatio(graphs, "openai", "low", "high")).toBeUndefined();
});

test("chains provider-local edges and never bridges through another provider", () => {
  const graphs = buildThinkingLevelGraphs([
    observation("openai", { low: 20, medium: 40 }),
    observation("openai", { medium: 40, high: 60 }),
    observation("anthropic", { high: 60, max: 90 }),
  ]);
  expect(thinkingLevelRatio(graphs, "openai", "low", "high")).toBe(3);
  expect(thinkingLevelRatio(graphs, "openai", "low", "max")).toBeUndefined();
});

test("a direct edge beats longer paths", () => {
  const graphs = buildThinkingLevelGraphs([
    observation("openai", { low: 20, medium: 40 }),
    observation("openai", { medium: 40, high: 80 }),
    observation("openai", { low: 20, high: 30 }),
  ]);
  expect(thinkingLevelRatio(graphs, "openai", "low", "high")).toBe(1.5);
});

test("averages all shortest path products, ignoring cycles and longer paths", () => {
  const graphs = buildThinkingLevelGraphs([
    observation("openai", { low: 10, medium: 20 }),
    observation("openai", { medium: 10, high: 30 }),
    observation("openai", { low: 10, xhigh: 40 }),
    observation("openai", { xhigh: 10, high: 50 }),
    observation("openai", { medium: 10, max: 20 }),
    observation("openai", { max: 10, high: 90 }),
  ]);
  expect(thinkingLevelRatio(graphs, "openai", "low", "high")).toBe((6 + 20) / 2);
  expect(thinkingLevelRatio(graphs, "openai", "low", "off")).toBeUndefined();
});

test("counts every shortest path when branches merge before the target", () => {
  const graphs = buildThinkingLevelGraphs([
    observation("openai", { low: 10, medium: 20 }),
    observation("openai", { low: 10, high: 30 }),
    observation("openai", { medium: 10, xhigh: 40 }),
    observation("openai", { high: 10, xhigh: 50 }),
    observation("openai", { xhigh: 10, max: 20 }),
  ]);
  expect(thinkingLevelRatio(graphs, "openai", "low", "max")).toBe((16 + 30) / 2);
});

test("ignores invalid ratios, allows a zero target but not a zero anchor", () => {
  const graphs = buildThinkingLevelGraphs([
    observation("openai", { low: 0, high: 20 }),
    observation("openai", { medium: Number.NaN, max: Number.POSITIVE_INFINITY }),
    observation("openai", { minimal: -1, xhigh: 10 }),
  ]);
  expect(thinkingLevelRatio(graphs, "openai", "high", "low")).toBe(0);
  expect(thinkingLevelRatio(graphs, "openai", "low", "high")).toBeUndefined();
  expect(thinkingLevelRatio(graphs, "openai", "xhigh", "minimal")).toBeUndefined();
  expect(thinkingLevelRatio(graphs, "openai", "high", "max")).toBeUndefined();
});
