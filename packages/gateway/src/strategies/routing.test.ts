import type { ChatCompletionRequest } from "@mupt-ai/dari-router/policy-engine";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";

import { validateChatCompletionsRequest } from "../protocol/input/chat_completions_validation.js";
import type { InteractionRequest } from "../interaction/types.js";

const { registeredModelPrice: realRegisteredModelPrice } = await import("../providers/pi.js");

let selectorMessage: Record<string, unknown>;
let selectorMessageQueue: Array<Record<string, unknown>>;
let selectorRequests: InteractionRequest[];
let selectorEfforts: Array<string | undefined>;
let selectorError: Error | null;
let selectorContextWindows: Record<string, number | null>;

function mediumCandidates(...models: string[]) {
  return models.map((model) => ({ model, reasoningEffort: "medium" as const }));
}

mock.module("../providers/pi", () => ({
  completeInteractionModel: async (args: {
    request: InteractionRequest;
    selectedReasoningEffort?: string;
  }) => {
    selectorRequests.push(args.request);
    selectorEfforts.push(args.selectedReasoningEffort);
    if (selectorError) throw selectorError;
    return {
      message: selectorMessageQueue.shift() ?? selectorMessage,
      source: { provider: "openai", api: "openai-responses", model: "gpt-5.4-nano" },
    };
  },
  streamInteractionModel: async () => {
    throw new Error("streamInteractionModel should not be called in routing tests");
  },
  modelContextWindow: (modelId: string) => selectorContextWindows[modelId] ?? null,
  // mock.module is process-wide, so keep this export for later importers such as self_host/resolve.
  registeredModelPrice: realRegisteredModelPrice,
  modelMetadataLookup: () => (modelId: string) => ({
    model: { id: modelId, reasoning: false },
    supportedThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
  }),
}));

const {
  createLlmSelectorBackend,
  selectModel: selectModelWithBackend,
  selectorTraceFromError,
} = await import("./routing.js");
mock.restore();

type SelectModelArgs = Omit<
  Parameters<typeof selectModelWithBackend>[0],
  "selectorBackend"
>;
let selectorBackend = createLlmSelectorBackend({
  model: "openai/gpt-5.6-luna",
  apiKey: "sk-selector",
});

function selectModel(args: SelectModelArgs) {
  return selectModelWithBackend({ ...args, selectorBackend });
}

function selectorMessageText(request: InteractionRequest, index: number): string {
  const message = request.items.filter((item) => item.type === "message")[index];
  if (!message) throw new Error(`Expected selector message at index ${index}.`);
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

beforeEach(() => {
  selectorBackend = createLlmSelectorBackend({
    model: "openai/gpt-5.6-luna",
    apiKey: "sk-selector",
  });
  selectorRequests = [];
  selectorEfforts = [];
  selectorMessageQueue = [];
  selectorError = null;
  selectorContextWindows = {
    "openai/gpt-5.6-luna": 128_000,
    "deepseek-ai/DeepSeek-V4-Pro-0813": 131_000,
  };
  selectorMessage = {
    stopReason: "stop",
    content: [{ type: "text", text: JSON.stringify({ selected_model: "openai/gpt-4.1-mini", reasoning_effort: "medium", reason: "fast" }) }],
  };
});

afterAll(() => {
  mock.restore();
});

test("rejects non-routing models and empty message lists", () => {
  validateChatCompletionsRequest({
    model: "dari/routing",
    messages: [{ role: "user", content: "hello" }],
  });
  expect(() =>
    validateChatCompletionsRequest({
      model: "openai/gpt-4.1-mini",
      messages: [{ role: "user", content: "hello" }],
    }),
  ).toThrow("Only model 'dari/routing' or 'dari/model/<model>' is supported.");
  expect(() => validateChatCompletionsRequest({
    model: "dari/routing",
    messages: [],
  })).toThrow(
    "messages must include at least one message.",
  );
});

test("rejects unsupported message roles and remote image URLs", () => {
  expect(() =>
    validateChatCompletionsRequest({
      model: "dari/routing",
      messages: [{ role: "moderator", content: "hello" }],
    }),
  ).toThrow("Unsupported message role");

  expect(() =>
    validateChatCompletionsRequest({
      model: "dari/routing",
      messages: [
        {
          role: "user",
          content: [{
            type: "image_url",
            image_url: { url: "https://example.com/image.png" },
          }],
        },
      ],
    }),
  ).toThrow("Unsupported image_url");
});

test("rejects malformed message content, options, tool history, and tool definitions", () => {
  expect(() =>
    validateChatCompletionsRequest({
      model: "dari/routing",
      messages: [{ role: "user", content: [null] } as any],
    }),
  ).toThrow("Unsupported content part");

  expect(() =>
    validateChatCompletionsRequest({
      model: "dari/routing",
      messages: [{
        role: "user",
        content: { type: "text", text: "hello" },
      } as any],
    }),
  ).toThrow("content must be a string, an array, or null");

  expect(() =>
    validateChatCompletionsRequest({
      model: "dari/routing",
      messages: [{ role: "user", content: "hello" }],
      stream: "false" as any,
    }),
  ).toThrow("stream must be a boolean");

  expect(() =>
    validateChatCompletionsRequest({
      model: "dari/routing",
      messages: [{ role: "user", content: "hello" }],
      n: 2,
    } as ChatCompletionRequest),
  ).toThrow("Only n=1 is supported");

  expect(() =>
    validateChatCompletionsRequest({
      model: "dari/routing",
      messages: [{ role: "tool", content: "72 and sunny" }],
    }),
  ).toThrow("tool_call_id is required");

  expect(() =>
    validateChatCompletionsRequest({
      model: "dari/routing",
      messages: [{ role: "user", content: "hello" }],
      tools: [{
        type: "function",
        function: { parameters: { type: "object" } },
      }],
    }),
  ).toThrow("function.name must be a non-empty string");
});

test("validates reasoning request options", () => {
  expect(() =>
    validateChatCompletionsRequest({
      model: "dari/routing",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "turbo" as never,
    }),
  ).toThrow("reasoning_effort is not supported.");

  expect(() =>
    validateChatCompletionsRequest({
      model: "dari/routing",
      messages: [{ role: "user", content: "hello" }],
      reasoning: { effort: "high" },
    } as ChatCompletionRequest),
  ).toThrow("reasoning is not supported; use reasoning_effort.");

  expect(() =>
    validateChatCompletionsRequest({
      model: "dari/routing",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "off",
    })
  ).not.toThrow();
});

test("selects a model returned as strict JSON", async () => {
  const run = await selectModel({
    messages: [{ role: "user", content: "hello" }],
    candidates: mediumCandidates("openai/gpt-4.1-mini"),
  });

  expect(run.decision).toEqual({
    selectedModel: "openai/gpt-4.1-mini",
    reasoningEffort: "medium",
    reason: "fast",
  });
  expect(run.selectorModel).toBe("openai/gpt-5.6-luna");
  expect(run.outputText).toContain("openai/gpt-4.1-mini");
  expect(selectorEfforts).toEqual([undefined]);
});

test("passes a configured reasoning effort to the selector completion", async () => {
  selectorBackend = createLlmSelectorBackend({
    model: "openai/gpt-5.6-luna",
    apiKey: "sk-selector",
    reasoningEffort: "low",
  });

  await selectModel({
    messages: [{ role: "user", content: "hello" }],
    candidates: mediumCandidates("openai/gpt-4.1-mini"),
  });

  expect(selectorEfforts).toEqual(["low"]);
});

test("keeps custom routing on the LLM selector", async () => {
  const run = await selectModel({
    messages: [{ role: "user", content: "hello" }],
    candidates: mediumCandidates("openai/gpt-4.1-mini", "anthropic/claude-sonnet-4-6"),
    customRules: [
      {
        when: "For greetings",
        use: "openai/gpt-4.1-mini",
        thinking_level: "medium",
      },
    ],
  });

  expect(run.selectorModel).toBe("openai/gpt-5.6-luna");
  expect(selectorRequests).toHaveLength(1);
});

test("the selector request carries no fallback configuration", async () => {
  selectorMessage = {
    stopReason: "stop",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          selected_model: "openai/gpt-4.1-mini",
          reasoning_effort: "medium",
          reason: "best",
        }),
      },
    ],
  };

  const run = await selectModel({
    messages: [{ role: "user", content: "hello" }],
    candidates: mediumCandidates(
      "openai/gpt-4.1-mini",
      "openai/gpt-5.5",
      "anthropic/claude-sonnet-4-6",
    ),
  });

  expect(run.decision.selectedModel).toBe("openai/gpt-4.1-mini");
  expect(run.selectorInput).not.toHaveProperty("fallback_config");
  const responseFormat = selectorRequests[0].responseFormat;
  expect(responseFormat?.type).toBe("json_schema");
  const responseSchema = responseFormat?.type === "json_schema"
    ? responseFormat.schema
    : {};
  expect(responseSchema.properties).not.toHaveProperty("fallback_model");
  const systemPrompt = selectorMessageText(selectorRequests[0], 0);
  expect(systemPrompt).not.toContain("second-best fallback");
});

test("ignores a fallback the selector output names", async () => {
  selectorMessage = {
    stopReason: "stop",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          selected_model: "openai/gpt-4.1-mini",
          reasoning_effort: "medium",
          reason: "best",
          fallback_model: "anthropic/claude-sonnet-4-6",
          fallback_reasoning_effort: "medium",
          fallback_reason: "Second best.",
        }),
      },
    ],
  };

  const run = await selectModel({
    messages: [{ role: "user", content: "hello" }],
    candidates: mediumCandidates("openai/gpt-4.1-mini", "anthropic/claude-sonnet-4-6"),
  });

  expect(run.decision).toEqual({
    selectedModel: "openai/gpt-4.1-mini",
    reasoningEffort: "medium",
    reason: "best",
  });
  expect(run).not.toHaveProperty("fallbackDecision");
});

test("passes imported eval scorecards to the selector", async () => {
  await selectModel({
    messages: [{ role: "user", content: "debug this flaky test" }],
    candidates: mediumCandidates("openai/gpt-4.1-mini", "anthropic/claude-sonnet-4-6"),
    evals: [
      {
        id: "evl_1",
        name: "SWE-bench Verified",
        description: "Resolved tasks.",
        min_score: 0,
        max_score: 100,
        scores: [
          { model_id: "openai/gpt-4.1-mini", score: 67, notes: "fast" },
          { model_id: "anthropic/claude-sonnet-4-6", score: 81, notes: null },
          { model_id: "openai/not-enabled-legacy", score: 99, notes: "not enabled" },
        ],
      },
    ],
  });

  const selectorPayload = JSON.parse(selectorMessageText(selectorRequests[0], 1));
  expect(selectorPayload.imported_evals).toEqual([
    {
      id: "evl_1",
      name: "SWE-bench Verified",
      description: "Resolved tasks.",
      min_score: 0,
      max_score: 100,
      scores: [
        // Rank and z-score compare only the current scored candidate actions;
        // the legacy model row is not part of the routing population.
        {
          model_id: "openai/gpt-4.1-mini",
          thinking_level: "medium",
          score: 67,
          rank: 2,
          rank_total: 2,
          z_score: -1,
          notes: "fast",
        },
        {
          model_id: "anthropic/claude-sonnet-4-6",
          thinking_level: "medium",
          score: 81,
          rank: 1,
          rank_total: 2,
          z_score: 1,
          notes: null,
        },
      ],
    },
  ]);
});

test("drops imported eval scorecards with no current candidate scores", async () => {
  await selectModel({
    messages: [{ role: "user", content: "debug this flaky test" }],
    candidates: mediumCandidates("openai/gpt-4.1-mini"),
    evals: [
      {
        id: "evl_stale",
        name: "Old Stale Scorecard",
        description: null,
        min_score: 0,
        max_score: 100,
        scores: [{ model_id: "openai/not-enabled-legacy", score: 99, notes: "removed" }],
      },
    ],
  });

  const selectorPayload = JSON.parse(selectorMessageText(selectorRequests[0], 1));
  expect(selectorPayload.imported_evals).toEqual([]);
});

test("passes only matching thinking-level eval scores to the selector", async () => {
  selectorMessage = {
    stopReason: "stop",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          selected_model: "openai/gpt-4.1-mini",
          reasoning_effort: "high",
          reason: "high score",
        }),
      },
    ],
  };
  await selectModel({
    messages: [{ role: "user", content: "debug this flaky test" }],
    candidates: [
      { model: "openai/gpt-4.1-mini", reasoningEffort: "high" },
      { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "off" },
    ],
    evals: [
      {
        id: "evl_reasoning",
        name: "Reasoning Bench",
        description: null,
        min_score: 0,
        max_score: 100,
        scores: [
          { model_id: "openai/gpt-4.1-mini", score: 11, notes: "low row", thinking_level: "low" },
          { model_id: "openai/gpt-4.1-mini", score: 67, notes: "high row", thinking_level: "high" },
          { model_id: "anthropic/claude-sonnet-4-6", score: 81, notes: "generic" },
          { model_id: "anthropic/claude-sonnet-4-6", score: 22, notes: "off row", thinking_level: "off" },
        ],
      },
    ],
  });

  const selectorPayload = JSON.parse(selectorMessageText(selectorRequests[0], 1));
  expect(selectorPayload.imported_evals).toEqual([
    {
      id: "evl_reasoning",
      name: "Reasoning Bench",
      description: null,
      min_score: 0,
      max_score: 100,
      scores: [
        {
          model_id: "openai/gpt-4.1-mini",
          score: 67,
          rank: 1,
          rank_total: 2,
          z_score: 1,
          notes: "high row",
          thinking_level: "high",
        },
        {
          model_id: "anthropic/claude-sonnet-4-6",
          score: 22,
          rank: 2,
          rank_total: 2,
          z_score: -1,
          notes: "off row",
          thinking_level: "off",
        },
      ],
    },
  ]);
});

test("filters eval scores to the candidate set and drops emptied cards", async () => {
  // Pruned (or otherwise filtered) models must not leak back into the
  // selector prompt as scorecard evidence.
  await selectModel({
    messages: [{ role: "user", content: "hello" }],
    candidates: mediumCandidates("openai/gpt-4.1-mini"),
    evals: [
      {
        id: "evl_mixed",
        name: "Mixed",
        description: null,
        min_score: 0,
        max_score: 100,
        scores: [
          { model_id: "openai/gpt-4.1-mini", score: 67, notes: null },
          { model_id: "anthropic/claude-sonnet-4-6", score: 81, notes: null },
        ],
      },
      {
        id: "evl_noncandidates_only",
        name: "Non-Candidates Only",
        description: null,
        min_score: 0,
        max_score: 100,
        scores: [{ model_id: "anthropic/claude-sonnet-4-6", score: 90, notes: null }],
      },
    ],
  });

  const payload = JSON.parse(selectorMessageText(selectorRequests[0], 1));
  expect(payload.imported_evals).toEqual([
    {
      id: "evl_mixed",
      name: "Mixed",
      description: null,
      min_score: 0,
      max_score: 100,
      scores: [
        {
          model_id: "openai/gpt-4.1-mini",
          thinking_level: "medium",
          score: 67,
          rank: 1,
          rank_total: 1,
          z_score: 0,
          notes: null,
        },
      ],
    },
  ]);
});

test("imputeEvalScores uses provider-local ratios for missing per-level scores", async () => {
  // Candidate runs at "medium" but only has "low" and "high" rows.
  // Only another OpenAI model's measured levels may calibrate this candidate.
  await selectModel({
    messages: [{ role: "user", content: "hello" }],
    candidates: mediumCandidates("openai/gpt-4.1-mini"),
    imputeEvalScores: true,
    evals: [
      {
        id: "evl_gap",
        name: "Gap",
        description: null,
        min_score: 0,
        max_score: 100,
        scores: [
          { model_id: "openai/gpt-4.1-mini", score: 60, thinking_level: "low", notes: null },
          { model_id: "openai/gpt-4.1-mini", score: 80, thinking_level: "high", notes: null },
          { model_id: "openai/calibrator", score: 30, thinking_level: "low", notes: null },
          { model_id: "openai/calibrator", score: 40, thinking_level: "medium", notes: null },
          { model_id: "openai/calibrator", score: 50, thinking_level: "high", notes: null },
          { model_id: "anthropic/calibrator", score: 50, thinking_level: "low", notes: null },
          { model_id: "anthropic/calibrator", score: 20, thinking_level: "medium", notes: null },
          { model_id: "anthropic/calibrator", score: 30, thinking_level: "high", notes: null },
        ],
      },
    ],
  });

  const payload = JSON.parse(selectorMessageText(selectorRequests[0], 1));
  expect(payload.imported_evals).toHaveLength(1);
  expect(payload.imported_evals[0].scores).toEqual([
    expect.objectContaining({
      model_id: "openai/gpt-4.1-mini",
      thinking_level: "medium",
      score: 72,
      imputed: true,
    }),
  ]);
});

test("retries malformed selector output once and retains its raw output and cost", async () => {
  selectorMessageQueue = [
    {
      stopReason: "stop",
      usage: {
        input: 10,
        output: 1,
        totalTokens: 11,
        cost: { input: 0.001, output: 0.002, total: 0.003 },
      },
      content: [{ type: "text", text: "not json" }],
    },
    {
      stopReason: "stop",
      usage: {
        input: 4,
        output: 2,
        totalTokens: 6,
        cost: { input: 0.0004, output: 0.0002, total: 0.0006 },
      },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            selected_model: "openai/gpt-4.1-mini",
            reasoning_effort: "medium",
            reason: "valid retry",
          }),
        },
      ],
    },
  ];

  const run = await selectModel({
    messages: [{ role: "user", content: "hello" }],
    candidates: mediumCandidates("openai/gpt-4.1-mini"),
  });

  expect(selectorRequests).toHaveLength(2);
  expect(run.rejectedOutputTexts).toEqual(["not json"]);
  expect(run.outputText).toContain("valid retry");
  expect(run.usage).toMatchObject({
    input: 14,
    output: 3,
    totalTokens: 17,
    cost: { input: 0.0014, output: 0.0022, total: 0.0036 },
  });
});

test("rejects invalid selector JSON after one retry and exposes both raw attempts", async () => {
  selectorMessage = { stopReason: "stop", content: [{ type: "text", text: "openai/gpt-4.1-mini" }] };

  let thrown: unknown;
  try {
    await selectModel({
      messages: [{ role: "user", content: "hello" }],
      candidates: mediumCandidates("openai/gpt-4.1-mini"),
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe("Selector returned invalid JSON.");
  expect(selectorRequests).toHaveLength(2);
  expect(selectorTraceFromError(thrown)).toMatchObject({
    outputText: "openai/gpt-4.1-mini",
    rejectedOutputTexts: ["openai/gpt-4.1-mini"],
  });
});

test("synthesizes a safe reason when selector omits one", async () => {
  selectorMessage = {
    stopReason: "stop",
    content: [{ type: "text", text: JSON.stringify({ selected_model: "openai/gpt-4.1-mini", reasoning_effort: "medium" }) }],
  };
  const run = await selectModel({
    messages: [{ role: "user", content: "hello" }],
    candidates: mediumCandidates("openai/gpt-4.1-mini"),
  });

  expect(run.decision).toEqual({
    selectedModel: "openai/gpt-4.1-mini",
    reasoningEffort: "medium",
    reason:
      "Selector selected openai/gpt-4.1-mini/medium; no reason was provided.",
  });
});

test("rejects thrown selector responses", async () => {
  selectorError = new Error("sk-selector leaked");
  await expect(
    selectModel({
      messages: [{ role: "user", content: "hello" }],
      candidates: mediumCandidates("openai/gpt-4.1-mini"),
    }),
  ).rejects.toThrow("Selector request failed.");
});

test("rejects selector models outside the router", async () => {
  selectorMessage = {
    stopReason: "stop",
    content: [{ type: "text", text: JSON.stringify({ selected_model: "openai/o3", reasoning_effort: "medium", reason: "hard" }) }],
  };

  let thrown: unknown;
  try {
    await selectModel({
      messages: [{ role: "user", content: "hello" }],
      candidates: mediumCandidates("openai/gpt-4.1-mini"),
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe(
    "Selector returned a model/thinking-level pair outside this router's candidates.",
  );
  expect(selectorRequests).toHaveLength(1);
  expect(selectorTraceFromError(thrown)?.outputText).toBe(
    JSON.stringify({
      selected_model: "openai/o3",
      reasoning_effort: "medium",
      reason: "hard",
    }),
  );
});

test("selector payload carries previous decision, cost estimates, and the cost directive", async () => {
  const run = await selectModel({
    messages: [{ role: "user", content: "hello" }],
    candidates: mediumCandidates("openai/gpt-4.1-mini"),
    previousDecision: { model: "openai/gpt-4.1-mini", reasoningEffort: "medium", reason: "prior turn" },
    costEstimates: [
      {
        model: "openai/gpt-4.1-mini",
        reasoning_effort: "medium",
        warm_tokens: 2000,
        est_prompt_tokens: 2500,
        est_input_cost_usd: 0.0012,
        output_cost_per_mtok: 14,
        pricing_known: true,
        fixed_turn_cost_estimate: {
          output_tokens_per_turn: 2500,
          assumed_reasoning_effort: "medium",
          cold_start_usd: 0,
          projections: [
            { projected_turns: 1, total_cost_usd: 0.002 },
            { projected_turns: 10, total_cost_usd: 0.014 },
            { projected_turns: 100, total_cost_usd: 0.31 },
          ],
        },
      },
    ],
  });

  // The selector must stay pinned to a true off; it should not rely on a hard
  // max-token cap to avoid reasoning-token burn. Temperature is omitted because
  // the default selector model does not accept that parameter.
  expect(selectorRequests[0].reasoning?.effort).toBe("off");
  expect(selectorRequests[0].generation.maxOutputTokens).toBeUndefined();
  expect(selectorRequests[0].generation.temperature).toBeUndefined();
  const systemText = selectorMessageText(selectorRequests[0], 0);
  expect(systemText).toContain("capability is never traded away for cost");
  expect(systemText).toContain(
    "A missing benchmark score means that candidate pair was not evaluated",
  );
  expect(systemText).toContain("Prefer the previous_decision pair");
  expect(systemText).toContain("fixed_turn_cost_estimate.projections");
  expect(systemText).toContain("preferred cost-comparison pool");
  expect(systemText).toContain("Do not discard those estimates just because some candidates lack them");
  expect(systemText).toContain("fallback cost evidence");

  const payload = JSON.parse(selectorMessageText(selectorRequests[0], 1));
  expect(payload.previous_decision).toEqual({
    model: "openai/gpt-4.1-mini",
    thinking_level: "medium",
    reason: "prior turn",
  });
  expect(payload.cost_estimates[0]).toMatchObject({
    warm_tokens: 2000,
    output_cost_per_mtok: 14,
    fixed_turn_cost_estimate: {
      projections: [
        { projected_turns: 1, total_cost_usd: 0.002 },
        { projected_turns: 10, total_cost_usd: 0.014 },
        { projected_turns: 100, total_cost_usd: 0.31 },
      ],
    },
  });
  expect(run.decision.selectedModel).toBe("openai/gpt-4.1-mini");
});

test("selector sees image placeholders, never base64 bytes", async () => {
  const dataUrl = `data:image/png;base64,${"A".repeat(5000)}`;
  await selectModel({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this image?" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    candidates: mediumCandidates("openai/gpt-4.1-mini"),
  });

  const serialized = selectorMessageText(selectorRequests[0], 1);
  expect(serialized).toContain("<image omitted>");
  expect(serialized).not.toContain("A".repeat(100));
  expect(serialized).toContain("what is in this image?");
});

test("disabled lease context keeps the selector input byte-identical to the pre-lease-context shape", async () => {
  const messages = [
    { role: "user", content: "original task" },
    { role: "assistant", content: "a reply" },
    { role: "user", content: "follow-up question" },
  ];
  const run = await selectModel({
    messages,
    candidates: mediumCandidates("openai/gpt-4.1-mini"),
    leaseContextEnabled: false,
  });

  expect("task" in run.selectorInput).toBe(false);
  expect("lease_history" in run.selectorInput).toBe(false);
  expect(JSON.stringify(run.selectorInput)).toBe(
    JSON.stringify({
      candidate_pairs: [{ model: "openai/gpt-4.1-mini", thinking_level: "medium" }],
      imported_evals: [],
      previous_decision: null,
      cost_estimates: null,
      messages,
    }),
  );
});

test("lease context defaults to enabled with empty lease history", async () => {
  const messages = [
    { role: "user", content: "original task" },
    { role: "assistant", content: "a reply" },
    { role: "user", content: "follow-up question" },
  ];
  const run = await selectModel({
    messages,
    candidates: mediumCandidates("openai/gpt-4.1-mini"),
  });

  expect(JSON.stringify(run.selectorInput)).toBe(
    JSON.stringify({
      candidate_pairs: [{ model: "openai/gpt-4.1-mini", thinking_level: "medium" }],
      imported_evals: [],
      previous_decision: null,
      cost_estimates: null,
      lease_history: [],
      messages,
    }),
  );
});

test("enabled lease context forwards provided lease history entries", async () => {
  const leaseHistory = [
    {
      candidate: { model: "openai/gpt-4.1-mini", thinking_level: "medium" as const },
      requested_turns: 5,
      completed_turns: 2,
      rationale: "cheap model holds",
      last_agent_thought: null,
      last_tool_call: null,
      last_tool_result: null,
      tool_errors: null,
      files_changed: null,
      tests: null,
    },
  ];
  const run = await selectModel({
    messages: [{ role: "user", content: "follow-up question" }],
    leaseHistory,
    candidates: mediumCandidates("openai/gpt-4.1-mini"),
  });

  const input = run.selectorInput as Record<string, unknown>;
  expect("task" in input).toBe(false);
  expect(input.lease_history).toEqual(leaseHistory);
});

test("oversized selector input trims oldest messages before the selector call", async () => {
  selectorContextWindows["openai/gpt-5.6-luna"] = 1_000;
  const run = await selectModel({
    messages: [
      { role: "user", content: "x".repeat(6000) },
      { role: "assistant", content: "old reply" },
      { role: "user", content: "the question that matters" },
    ],
    candidates: mediumCandidates("openai/gpt-4.1-mini"),
  });

  expect(run.decision.selectedModel).toBe("openai/gpt-4.1-mini");
  expect(selectorRequests).toHaveLength(1);
  const sent = JSON.parse(selectorMessageText(selectorRequests[0], 1));
  const texts = sent.messages.map((message: Record<string, unknown>) => String(message.content));
  expect(texts[0]).toBe("<earlier messages truncated for routing>");
  expect(texts.some((text: string) => text.includes("the question that matters"))).toBe(true);
  expect(texts.some((text: string) => text.includes("x".repeat(4000)))).toBe(false);
});

test("selector sizing accounts for many model and thinking-level pairs", async () => {
  selectorContextWindows["openai/gpt-5.6-luna"] = 4_000;
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const candidates = Array.from({ length: 12 }, (_, index) =>
    index === 0 ? "openai/gpt-4.1-mini" : `provider/model-${index}`,
  ).flatMap((model) =>
    levels.map((reasoningEffort) => ({ model, reasoningEffort })),
  );

  const run = await selectModel({
    messages: [
      { role: "user", content: "x".repeat(30_000) },
      { role: "user", content: "route this final request" },
    ],
    candidates,
  });

  expect(run.decision).toMatchObject({
    selectedModel: "openai/gpt-4.1-mini",
    reasoningEffort: "medium",
  });
  expect(selectorRequests).toHaveLength(1);
  const sent = JSON.parse(selectorMessageText(selectorRequests[0], 1));
  expect(sent.candidate_pairs).toHaveLength(candidates.length);
  expect(sent.messages[0].content).toBe("<earlier messages truncated for routing>");
  expect(sent.messages.at(-1).content).toBe("route this final request");
});

test("single-message selector trim still shrinks when the prompt is barely over budget", async () => {
  const messages = [{ role: "user", content: "x".repeat(6000) }];
  const initial = await selectModel({
    messages,
    candidates: mediumCandidates("openai/gpt-4.1-mini"),
  });
  const initialInputChars = JSON.stringify(initial.selectorRequest.messages ?? []).length;

  selectorRequests = [];
  selectorContextWindows["openai/gpt-5.6-luna"] = Math.floor((initialInputChars - 128) / 4);
  const run = await selectModel({ messages, candidates: mediumCandidates("openai/gpt-4.1-mini") });

  expect(run.decision.selectedModel).toBe("openai/gpt-4.1-mini");
  expect(selectorRequests).toHaveLength(1);
  const sent = JSON.parse(selectorMessageText(selectorRequests[0], 1));
  expect(sent.messages).toHaveLength(1);
  expect(String(sent.messages[0].content).startsWith("<earlier messages truncated for routing>")).toBe(true);
  expect(String(sent.messages[0].content)).not.toContain("x".repeat(6000));
});

test("single-message multimodal selector trim preserves task text", async () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: `please classify this contract risk ${"x".repeat(6000)}` },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    },
  ];
  const initial = await selectModel({
    messages,
    candidates: mediumCandidates("openai/gpt-4.1-mini"),
  });
  const initialInputChars = JSON.stringify(initial.selectorRequest.messages ?? []).length;

  selectorRequests = [];
  selectorContextWindows["openai/gpt-5.6-luna"] = Math.floor((initialInputChars - 1) / 4);
  const run = await selectModel({ messages, candidates: mediumCandidates("openai/gpt-4.1-mini") });

  expect(run.decision.selectedModel).toBe("openai/gpt-4.1-mini");
  expect(selectorRequests).toHaveLength(1);
  const sent = JSON.parse(selectorMessageText(selectorRequests[0], 1));
  expect(sent.messages).toHaveLength(1);
  const content = String(sent.messages[0].content);
  expect(content.startsWith("<earlier messages truncated for routing>")).toBe(true);
  expect(content).toContain("please classify this contract risk");
  expect(content).toContain("<image omitted>");
});

test("selector sizing requires selector context window metadata", async () => {
  selectorContextWindows["openai/gpt-5.6-luna"] = null;

  await expect(
    selectModel({
      messages: [{ role: "user", content: "x".repeat(4000) }],
      candidates: mediumCandidates("openai/gpt-4.1-mini"),
    }),
  ).rejects.toThrow("No context window is configured for selector model openai/gpt-5.6-luna.");
  expect(selectorRequests).toHaveLength(0);
});

test("non-context selector errors do not retry", async () => {
  selectorMessage = { stopReason: "error", errorMessage: "rate limited" };
  await expect(
    selectModel({
      messages: [{ role: "user", content: "hello" }],
      candidates: mediumCandidates("openai/gpt-4.1-mini"),
    }),
  ).rejects.toThrow("Selector request failed.");
  expect(selectorRequests).toHaveLength(1);
});
