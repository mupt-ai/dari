import { expect, test } from "bun:test";

import { RouterCoreError } from "../src/errors.js";
import { parseSelectorDecision, validateSelectorDecisions } from "../src/selector_parse.js";
import type { RoutingCandidate } from "../src/types.js";

function mediumCandidates(...models: string[]): RoutingCandidate[] {
  return models.map((model) => ({ model, reasoningEffort: "medium" as const }));
}

test("parses a strict JSON decision", () => {
  const parsed = parseSelectorDecision(
    JSON.stringify({ selected_model: "openai/gpt-4.1-mini", reasoning_effort: "medium", reason: "fast" }),
  );
  expect(parsed.decision).toEqual({
    selectedModel: "openai/gpt-4.1-mini",
    reasoningEffort: "medium",
    reason: "fast",
  });
  expect(parsed.fallbackDecision).toBeUndefined();
});

test("parses a fenced JSON decision with a fallback", () => {
  const parsed = parseSelectorDecision(
    "```json\n" +
      JSON.stringify({
        selected_model: "openai/gpt-4.1-mini",
        reasoning_effort: "medium",
        reason: "best",
        fallback_model: "anthropic/claude-sonnet-4-6",
        fallback_reasoning_effort: "medium",
        fallback_reason: "second best",
      }) +
      "\n```",
  );
  expect(parsed.fallbackDecision).toEqual({
    selectedModel: "anthropic/claude-sonnet-4-6",
    reasoningEffort: "medium",
    reason: "second best",
  });
});

test("synthesizes safe reasons when the selector omits them", () => {
  const parsed = parseSelectorDecision(
    JSON.stringify({
      selected_model: "openai/gpt-4.1-mini",
      reasoning_effort: "medium",
      fallback_model: "anthropic/claude-sonnet-4-6",
      fallback_reasoning_effort: "low",
      fallback_reason: null,
    }),
  );
  expect(parsed.decision.reason).toBe(
    "Selector selected openai/gpt-4.1-mini/medium; no reason was provided.",
  );
  expect(parsed.fallbackDecision?.reason).toBe(
    "Selector ranked anthropic/claude-sonnet-4-6/low as the fallback; no reason was provided.",
  );
});

test("treats a null fallback_model with an explanatory reason as no fallback", () => {
  const parsed = parseSelectorDecision(
    JSON.stringify({
      selected_model: "openai/gpt-4.1-mini",
      reasoning_effort: "medium",
      reason: "best",
      fallback_model: null,
      fallback_reasoning_effort: null,
      fallback_reason: "No eligible fallback exists.",
    }),
  );
  expect(parsed.fallbackDecision).toBeUndefined();
});

test("rejects invalid selector output shapes", () => {
  expect(() => parseSelectorDecision("openai/gpt-4.1-mini")).toThrow(
    "Selector returned invalid JSON.",
  );
  expect(() => parseSelectorDecision("[]")).toThrow(
    "Selector returned invalid routing decision.",
  );
  expect(() => parseSelectorDecision(JSON.stringify({ reasoning_effort: "medium" }))).toThrow(
    "Selector response missing selected_model.",
  );
  expect(() =>
    parseSelectorDecision(
      JSON.stringify({ selected_model: "openai/gpt-4.1-mini", reasoning_effort: "turbo" }),
    ),
  ).toThrow("Selector response missing a valid reasoning_effort.");
  expect(() =>
    parseSelectorDecision(
      JSON.stringify({
        selected_model: "openai/gpt-4.1-mini",
        reasoning_effort: "medium",
        reason: "best",
        fallback_model: "anthropic/claude-sonnet-4-6",
        fallback_reasoning_effort: "turbo",
      }),
    ),
  ).toThrow("Selector response contains an incomplete fallback decision.");
});

test("selection must be one of the candidates", () => {
  expect(() =>
    validateSelectorDecisions({
      decision: { selectedModel: "openai/o3", reasoningEffort: "medium", reason: "hard" },
      candidates: mediumCandidates("openai/gpt-4.1-mini"),
    }),
  ).toThrow("Selector returned a model/thinking-level pair outside this router's candidates.");
});

test("fallback eligibility respects the provider constraint", () => {
  const candidates = mediumCandidates(
    "openai/gpt-4.1-mini",
    "openai/gpt-5.5",
    "anthropic/claude-sonnet-4-6",
  );
  const decision = {
    selectedModel: "openai/gpt-4.1-mini",
    reasoningEffort: "medium",
    reason: "best",
  } as const;
  const sameProviderFallback = {
    selectedModel: "openai/gpt-5.5",
    reasoningEffort: "medium",
    reason: "second best",
  } as const;

  expect(() =>
    validateSelectorDecisions({
      decision,
      fallbackDecision: sameProviderFallback,
      candidates,
      modelFallbackEnabled: true,
      fallbackRequiresDifferentProvider: true,
    }),
  ).toThrow("Selector returned an ineligible fallback model/thinking-level pair.");

  validateSelectorDecisions({
    decision,
    fallbackDecision: sameProviderFallback,
    candidates,
    modelFallbackEnabled: true,
    fallbackRequiresDifferentProvider: false,
  });
});

test("a missing fallback is rejected only when an eligible fallback exists", () => {
  const decision = {
    selectedModel: "openai/gpt-4.1-mini",
    reasoningEffort: "medium",
    reason: "best",
  } as const;

  expect(() =>
    validateSelectorDecisions({
      decision,
      candidates: mediumCandidates("openai/gpt-4.1-mini", "anthropic/claude-sonnet-4-6"),
      modelFallbackEnabled: true,
      fallbackRequiresDifferentProvider: true,
    }),
  ).toThrow("Selector response missing an eligible fallback model.");

  // All other candidates share the selected provider: no eligible fallback.
  validateSelectorDecisions({
    decision,
    candidates: mediumCandidates("openai/gpt-4.1-mini", "openai/gpt-5.5"),
    modelFallbackEnabled: true,
    fallbackRequiresDifferentProvider: true,
  });
});

test("core selector errors carry mappable kinds and codes", () => {
  try {
    parseSelectorDecision("not json");
    throw new Error("expected parseSelectorDecision to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(RouterCoreError);
    expect((error as RouterCoreError).kind).toBe("selector_output");
    expect((error as RouterCoreError).code).toBe("selector_invalid_json");
  }
});
