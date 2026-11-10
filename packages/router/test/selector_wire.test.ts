import { expect, test } from "bun:test";

import { RouterFrameworkError } from "../src/framework_error.js";
import { buildSelectorRequest } from "../src/selector_request.js";
import {
  assertAnonymizableSelectorInput,
  decodeUntrustedSelectorRequest,
} from "../src/selector_wire.js";
import type {
  ChatCompletionRequest,
  PreviousDecision,
  RouterEval,
  RoutingCandidate,
} from "../src/types.js";

const TWO_CANDIDATES: RoutingCandidate[] = [
  { model: "openai/gpt-5.6-sol", reasoningEffort: "high" },
  { model: "anthropic/claude-sonnet-5", reasoningEffort: "medium" },
];

const EVALS: RouterEval[] = [
  {
    id: "eval_1",
    name: "Coding",
    description: "Coding benchmark",
    min_score: 0,
    max_score: 100,
    scores: [
      { model_id: "openai/gpt-5.6-sol", thinking_level: "high", score: 91 },
      { model_id: "anthropic/claude-sonnet-5", thinking_level: "medium", score: 84 },
    ],
  },
];

function rawSelectorInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidate_pairs: [
      { model: "openai/gpt-5.6-sol", thinking_level: "high" },
      { model: "anthropic/claude-sonnet-5", thinking_level: "medium" },
    ],
    imported_evals: [],
    previous_decision: null,
    cost_estimates: null,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

function selectorInputBody(selectorInput: Record<string, unknown>): ChatCompletionRequest {
  return {
    model: "dari/auto-router",
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: JSON.stringify(selectorInput) },
    ],
  };
}

function decodeError(payload: unknown): RouterFrameworkError {
  try {
    decodeUntrustedSelectorRequest(payload);
  } catch (error) {
    expect(error).toBeInstanceOf(RouterFrameworkError);
    return error as RouterFrameworkError;
  }
  throw new Error("Expected decodeUntrustedSelectorRequest to throw.");
}

test("decode round-trips what buildSelectorRequest encodes", () => {
  const previousDecision: PreviousDecision = {
    model: "openai/gpt-5.6-sol",
    reasoningEffort: "high",
    reason: "Prior turn needed deep reasoning.",
  };
  const built = buildSelectorRequest({
    candidates: TWO_CANDIDATES,
    evals: EVALS,
    previousDecision,
    costEstimates: [
      {
        model: "openai/gpt-5.6-sol",
        reasoning_effort: "high",
        warm_tokens: 0,
        est_prompt_tokens: 120,
        est_input_cost_usd: 0.0004,
        output_cost_per_mtok: 10,
        pricing_known: true,
        fixed_turn_cost_estimate: null,
      },
      {
        model: "anthropic/claude-sonnet-5",
        reasoning_effort: "medium",
        warm_tokens: 0,
        est_prompt_tokens: 120,
        est_input_cost_usd: 0.0002,
        output_cost_per_mtok: 5,
        pricing_known: true,
        fixed_turn_cost_estimate: null,
      },
    ],
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "route me" },
    ],
    selectorModel: "dari/auto-router",
  });

  const decoded = decodeUntrustedSelectorRequest(built.selectorRequest);

  expect(decoded.candidates).toEqual(TWO_CANDIDATES);
  expect(decoded.previousDecision).toEqual(previousDecision);
  expect(decoded.selectorInput).toEqual(
    JSON.parse(JSON.stringify(built.selectorInput)),
  );
});

test("decode round-trips a minimal request without previous decision", () => {
  const built = buildSelectorRequest({
    candidates: [TWO_CANDIDATES[0]!],
    messages: [{ role: "user", content: "hello" }],
    selectorModel: "dari/auto-router",
  });

  const decoded = decodeUntrustedSelectorRequest(built.selectorRequest);

  expect(decoded.candidates).toEqual([TWO_CANDIDATES[0]!]);
  expect(decoded.previousDecision).toBeUndefined();
  expect(decoded.selectorInput.previous_decision).toBeNull();
  expect(decoded.selectorInput.cost_estimates).toBeNull();
});

test("decoded round-trip input passes the anonymization dry run", () => {
  const built = buildSelectorRequest({
    candidates: TWO_CANDIDATES,
    evals: EVALS,
    messages: [{ role: "user", content: "hello" }],
    selectorModel: "dari/auto-router",
  });
  const decoded = decodeUntrustedSelectorRequest(built.selectorRequest);

  expect(() =>
    assertAnonymizableSelectorInput(decoded.selectorInput, decoded.candidates, () => 0.42),
  ).not.toThrow();
});

test("decode rejects a non-object payload", () => {
  const error = decodeError("not an object");
  expect(error.kind).toBe("invalid_request");
  expect(error.status).toBe(400);
  expect(error.message).toBe("Selector request must be a JSON object.");
});

test("decode rejects non-array request messages", () => {
  const error = decodeError({ model: "dari/auto-router", messages: "hello" });
  expect(error.message).toBe("Selector request messages must be an array.");
  expect(error.param).toBe("messages");
});

test("decode rejects a request without a user message", () => {
  const error = decodeError({ model: "dari/auto-router", messages: [{ role: "system", content: "s" }] });
  expect(error.message).toBe("Selector request is missing the user message.");
  expect(error.param).toBeUndefined();
});

test("decode rejects a request with missing messages entirely", () => {
  const error = decodeError({ model: "dari/auto-router" });
  expect(error.message).toBe("Selector request is missing the user message.");
});

test("decode rejects non-string user message content", () => {
  const error = decodeError({
    model: "dari/auto-router",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });
  expect(error.message).toBe("Selector request user message content must be a string.");
});

test("decode rejects user message content that is not valid JSON", () => {
  const error = decodeError({
    model: "dari/auto-router",
    messages: [{ role: "user", content: "{nope" }],
  });
  expect(error.message).toBe("Selector request user message is not valid JSON.");
});

test("decode rejects user message JSON that is not an object", () => {
  const error = decodeError({
    model: "dari/auto-router",
    messages: [{ role: "user", content: "[1,2,3]" }],
  });
  expect(error.message).toBe("Selector request user message is not a JSON object.");
});

test("decode rejects selector input without candidate_pairs", () => {
  const error = decodeError({
    model: "dari/auto-router",
    messages: [{ role: "user", content: JSON.stringify({ messages: [] }) }],
  });
  expect(error.message).toBe("Selector input is missing candidate_pairs.");
});

test("decode rejects custom routing rules", () => {
  const error = decodeError(
    selectorInputBody(rawSelectorInput({ custom_rules: [], default_target: null })),
  );
  expect(error.kind).toBe("invalid_request");
  expect(error.code).toBe("custom_rules_not_supported");
});

test("decode rejects non-array selector input messages", () => {
  const error = decodeError(selectorInputBody(rawSelectorInput({ messages: "hello" })));
  expect(error.message).toBe("Selector input messages must be an array.");
  expect(error.param).toBe("messages");
});

test("decode rejects selector input messages without a string role", () => {
  const error = decodeError(
    selectorInputBody(
      rawSelectorInput({ messages: [{ role: "user", content: "ok" }, { content: "no role" }] }),
    ),
  );
  expect(error.message).toBe("Selector input messages must be objects with a string role.");
  expect(error.param).toBe("messages[1]");
});

test("decode rejects an empty candidate list", () => {
  const error = decodeError(selectorInputBody(rawSelectorInput({ candidate_pairs: [] })));
  expect(error.message).toBe("Selector request contains no candidates.");
});

test("decode rejects a null candidate pair entry", () => {
  const error = decodeError(
    selectorInputBody(
      rawSelectorInput({
        candidate_pairs: [null, { model: "openai/gpt-5.6-sol", thinking_level: "high" }],
      }),
    ),
  );
  expect(error.message).toBe("Selector candidate must be an object.");
  expect(error.param).toBe("candidate_pairs[0]");
});

test("decode rejects a candidate without a model name", () => {
  const error = decodeError(
    selectorInputBody(rawSelectorInput({ candidate_pairs: [{ thinking_level: "high" }] })),
  );
  expect(error.message).toBe("Selector candidate is missing a model name.");
  expect(error.param).toBe("candidate_pairs[0].model");
});

test("decode rejects a candidate with an invalid thinking_level", () => {
  const error = decodeError(
    selectorInputBody(
      rawSelectorInput({
        candidate_pairs: [{ model: "openai/gpt-5.6-sol", thinking_level: "ultra" }],
      }),
    ),
  );
  expect(error.message).toBe("Selector candidate has invalid thinking_level: ultra");
  expect(error.param).toBe("candidate_pairs[0].thinking_level");
});

test("decode rejects duplicate candidate pairs", () => {
  const error = decodeError(
    selectorInputBody(
      rawSelectorInput({
        candidate_pairs: [
          { model: "openai/gpt-5.6-sol", thinking_level: "high" },
          { model: "openai/gpt-5.6-sol", thinking_level: "high" },
        ],
      }),
    ),
  );
  expect(error.message).toBe(
    "Selector input contains duplicate candidate openai/gpt-5.6-sol/high.",
  );
  expect(error.param).toBe("candidate_pairs[1]");
});

test("decode rejects a non-object previous_decision", () => {
  const error = decodeError(selectorInputBody(rawSelectorInput({ previous_decision: "yes" })));
  expect(error.message).toBe("Selector previous_decision must be an object or null.");
  expect(error.param).toBe("previous_decision");
});

test("decode rejects malformed previous_decision fields", () => {
  const badModel = decodeError(
    selectorInputBody(
      rawSelectorInput({
        previous_decision: { model: 42, thinking_level: "high", reason: "r" },
      }),
    ),
  );
  expect(badModel.param).toBe("previous_decision.model");

  const badThinkingLevel = decodeError(
    selectorInputBody(
      rawSelectorInput({
        previous_decision: { model: "openai/gpt-5.6-sol", thinking_level: "ultra", reason: "r" },
      }),
    ),
  );
  expect(badThinkingLevel.message).toBe(
    "Selector previous_decision has invalid thinking_level: ultra",
  );
  expect(badThinkingLevel.param).toBe("previous_decision.thinking_level");

  const badReason = decodeError(
    selectorInputBody(
      rawSelectorInput({
        previous_decision: { model: "openai/gpt-5.6-sol", thinking_level: "high", reason: 7 },
      }),
    ),
  );
  expect(badReason.message).toBe("Selector previous_decision reason must be a string.");
  expect(badReason.param).toBe("previous_decision.reason");
});

test("assertAnonymizableSelectorInput wraps malformed imported_evals", () => {
  const decoded = decodeUntrustedSelectorRequest(
    selectorInputBody(rawSelectorInput({ imported_evals: [{ name: 42, scores: [] }] })),
  );

  let thrown: unknown;
  try {
    assertAnonymizableSelectorInput(decoded.selectorInput, decoded.candidates, () => 0.42);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RouterFrameworkError);
  const error = thrown as RouterFrameworkError;
  expect(error.kind).toBe("invalid_request");
  expect(error.status).toBe(400);
  expect(error.message).toContain("Selector input is invalid");
});

test("assertAnonymizableSelectorInput wraps malformed cost_estimates", () => {
  const decoded = decodeUntrustedSelectorRequest(
    selectorInputBody(rawSelectorInput({ cost_estimates: "bogus" })),
  );

  expect(() =>
    assertAnonymizableSelectorInput(decoded.selectorInput, decoded.candidates, () => 0.42),
  ).toThrow("Selector input is invalid");
});

test("assertAnonymizableSelectorInput skips single-candidate selections", () => {
  const decoded = decodeUntrustedSelectorRequest(
    selectorInputBody(
      rawSelectorInput({
        candidate_pairs: [{ model: "openai/gpt-5.6-sol", thinking_level: "high" }],
        imported_evals: [{ name: 42, scores: [] }],
      }),
    ),
  );

  expect(() =>
    assertAnonymizableSelectorInput(decoded.selectorInput, decoded.candidates),
  ).not.toThrow();
});
