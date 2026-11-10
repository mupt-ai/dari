import { expect, test } from "bun:test";

import {
  estimatedCancelUsage,
  observeDeliveredOutput,
  partialInteractionOutput,
  promptTokenEstimateFor,
} from "./cancel_estimate.js";

const pricing = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

test("cancel usage prices the prompt estimate and the delivered characters", () => {
  const usage = estimatedCancelUsage({
    pricing,
    promptEstimate: { promptTokens: 1000, warmTokens: 200 },
    delivered: { text: "x".repeat(480), textChars: 480, reasoningChars: 240 },
  });

  expect(usage).toMatchObject({
    input: 800,
    cacheRead: 200,
    cacheWrite: 0,
    output: 150,
    totalTokens: 1150,
    estimated: true,
  });
  expect(usage.cost.input).toBeCloseTo(0.0008, 12);
  expect(usage.cost.cacheRead).toBeCloseTo(0.00002, 12);
  expect(usage.cost.output).toBeCloseTo(0.00075, 12);
  expect(usage.cost.total).toBeCloseTo(0.00157, 12);
});

test("cancel usage without pricing or an estimate is zero tokens and zero cost", () => {
  const usage = estimatedCancelUsage({
    pricing: null,
    promptEstimate: undefined,
    delivered: { text: "", textChars: 0, reasoningChars: 0 },
  });

  expect(usage).toMatchObject({ input: 0, output: 0, cacheRead: 0, totalTokens: 0 });
  expect(usage.cost.total).toBe(0);
});

test("prompt estimate prefers the serving reasoning effort and falls back to the model", () => {
  const estimates = [
    { model: "m", reasoning_effort: "off", warm_tokens: 10, est_prompt_tokens: 100 },
    { model: "m", reasoning_effort: "high", warm_tokens: 20, est_prompt_tokens: 200 },
  ] as never[];

  expect(promptTokenEstimateFor(estimates, "m", "high")).toEqual({ promptTokens: 200, warmTokens: 20 });
  expect(promptTokenEstimateFor(estimates, "m", "medium")).toEqual({ promptTokens: 100, warmTokens: 10 });
  expect(promptTokenEstimateFor(estimates, "other", "off")).toBeUndefined();
  expect(promptTokenEstimateFor(undefined, "m", "off")).toBeUndefined();
});

test("delivered output is measured from the events the protocol consumed", async () => {
  async function* events(): AsyncIterable<Record<string, unknown>> {
    yield { type: "text_delta", delta: "hello " };
    yield { type: "thinking_delta", delta: "hmm" };
    yield { type: "text_delta", delta: "world" };
    yield { type: "done", message: {} };
  }
  const observed = observeDeliveredOutput(events());
  const seen: unknown[] = [];
  for await (const event of observed.events) seen.push(event.type);

  expect(seen).toEqual(["text_delta", "thinking_delta", "text_delta", "done"]);
  expect(observed.delivered()).toEqual({ text: "hello world", textChars: 11, reasoningChars: 3 });
});

test("a partial output exists only when text was delivered", () => {
  const usage = estimatedCancelUsage({
    pricing,
    promptEstimate: undefined,
    delivered: { text: "partial", textChars: 7, reasoningChars: 0 },
  });
  const source = { provider: "openai", api: "openai-responses", model: "gpt" } as never;

  expect(
    partialInteractionOutput({
      delivered: { text: "", textChars: 0, reasoningChars: 0 },
      usage,
      source,
      createdAtMs: 1,
    }),
  ).toBeNull();
  expect(
    partialInteractionOutput({
      delivered: { text: "partial", textChars: 7, reasoningChars: 0 },
      usage,
      source,
      createdAtMs: 1,
    }),
  ).toMatchObject({
    stopReason: "aborted",
    items: [{ type: "message", role: "assistant", content: [{ type: "text", text: "partial" }] }],
  });
});
