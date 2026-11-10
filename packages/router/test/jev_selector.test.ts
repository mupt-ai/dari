import { afterEach, expect, test } from "bun:test";

import {
  anonymizeSelectorInput,
  assignAnonymousActions,
  type AnonymousActionSlot,
  type Rng,
} from "../src/anonymous_actions.js";
import { JevOutputError, resolveJevConfig } from "../src/jev_client.js";
import {
  buildJevSelectorRequest,
  parseJevSelectorResponse,
  selectWithJev,
  type JevSystemOneRequest,
} from "../src/jev_selector.js";
import { buildSelectorRequest } from "../src/selector_request.js";
import type { SelectorInput } from "../src/selector_input.js";
import type { RouterEval, RoutingCandidate } from "../src/types.js";

const SOL = "openai/gpt-5.6-sol";
const SONNET = "anthropic/claude-sonnet-5";
const FLASH = "fireworks/deepseek-ai/DeepSeek-V4-Flash";

const CANDIDATES: RoutingCandidate[] = [
  { model: SOL, reasoningEffort: "high" },
  { model: SONNET, reasoningEffort: "medium" },
  { model: FLASH, reasoningEffort: "high" },
];

const EVALS: RouterEval[] = [
  {
    id: "swe",
    name: "SWE-bench Verified",
    description: "Resolved rate on real GitHub issues",
    min_score: 0,
    max_score: 100,
    scores: [
      { model_id: SOL, thinking_level: "high", score: 78 },
      { model_id: SONNET, thinking_level: "medium", score: 72 },
    ],
  },
];

const CONFIG = { ...resolveJevConfig({ apiKey: "ts-key" }), leaseTurns: [5, 10, 30] };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Deterministic rng so letter assignments are reproducible in tests.
function rng(seed: number): Rng {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function slots(): AnonymousActionSlot[] {
  return assignAnonymousActions(CANDIDATES, rng(42));
}

function actionFor(candidate: RoutingCandidate): string {
  const slot = slots().find(
    (entry) => entry.candidate.model === candidate.model
      && entry.candidate.reasoningEffort === candidate.reasoningEffort,
  );
  if (slot === undefined) throw new Error("no slot");
  return slot.action;
}

function selectorInput(overrides: Partial<SelectorInput> = {}): SelectorInput {
  const { selectorInput: built } = buildSelectorRequest({
    candidates: CANDIDATES,
    evals: EVALS,
    previousDecision: { model: SONNET, reasoningEffort: "medium", reason: "held" },
    costEstimates: CANDIDATES.map((candidate, index) => ({
      model: candidate.model,
      reasoning_effort: candidate.reasoningEffort,
      warm_tokens: 0,
      est_prompt_tokens: 1_000,
      est_input_cost_usd: 0.01 * (3 - index),
      output_cost_per_mtok: 10,
      pricing_known: true,
      fixed_turn_cost_estimate: {
        output_tokens_per_turn: 500,
        assumed_reasoning_effort: candidate.reasoningEffort,
        cold_start_usd: 0,
        projections: [5, 10, 30].map((turns) => ({
          projected_turns: turns,
          total_cost_usd: 0.03 * turns * (3 - index),
        })),
      },
    })),
    selectorModel: "typesafe/jev-latest",
    messages: [
      { role: "user", content: "Fix the failing auth tests." },
      { role: "assistant", content: "Running the suite." },
    ],
    leaseHistory: [
      {
        candidate: { model: SONNET, thinking_level: "medium" },
        requested_turns: 10,
        completed_turns: 10,
        rationale: "held",
        last_agent_thought: null,
        last_tool_call: null,
        last_tool_result: null,
        tool_errors: 1,
        files_changed: 2,
        tests: { command: "bun test", status: "failed", result: "3 failing" },
      },
    ],
  });
  return { ...(built as SelectorInput), ...overrides };
}

function jevAnswer(
  action: string,
  lease: string | undefined,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: "jev-1.13.0",
    answers: {
      action: {
        type: "choice",
        choice: action,
        confidence: 0.6,
        probabilities: Object.fromEntries(
          slots().map((slot) => [slot.action, slot.action === action ? 0.7 : 0.15]),
        ),
      },
      ...(lease === undefined
        ? {}
        : {
            lease: {
              type: "choice",
              choice: lease,
              confidence: 0.5,
              probabilities: { "5": 0.2, "10": 0.6, "30": 0.2 },
            },
          }),
    },
    usage: { input_tokens: 1_000, output_tokens: 40 },
    ...overrides,
  };
}


test("renders the anonymized input as a Jev state with action and lease choices", () => {
  const anonymous = anonymizeSelectorInput(selectorInput() as never, slots());
  const request = buildJevSelectorRequest(anonymous, {
    model: "jev-latest",
    leaseTurns: [5, 10, 30],
  });

  expect(request.model).toBe("jev-latest");
  const state = request.state as Record<string, unknown>;
  expect(state).not.toHaveProperty("task");
  expect(JSON.stringify(state.conversation)).toContain("Fix the failing auth tests.");
  expect(state.previous_action).toBe(actionFor({ model: SONNET, reasoningEffort: "medium" }));
  expect(state.lease_history).toEqual([
    expect.objectContaining({
      action: actionFor({ model: SONNET, reasoningEffort: "medium" }),
      requested_turns: 10,
      completed_turns: 10,
    }),
  ]);
  expect(state.conversation).toEqual([
    { role: "user", content: "Fix the failing auth tests." },
    { role: "assistant", content: "Running the suite." },
  ]);

  const actions = slots().map((slot) => slot.action);
  const action = request.questions.action;
  expect(Object.keys(action.criteria).sort()).toEqual([...actions].sort());
  // The most expensive candidate carries its projections, its rank, and its
  // benchmark standing; the cheapest has no benchmark row at all.
  expect(action.criteria[actionFor(CANDIDATES[0]!)]).toEqual({
    cost: {
      projected_loop_cost: { "5 turns": "$0.45", "10 turns": "$0.9", "30 turns": "$2.70" },
      rank: "3 of 3 (most expensive)",
    },
    benchmarks: { "SWE-bench Verified": { score: 78, rank: "1 of 2" } },
  });
  expect(action.criteria[actionFor(CANDIDATES[2]!)]).toEqual({
    cost: {
      projected_loop_cost: { "5 turns": "$0.15", "10 turns": "$0.3", "30 turns": "$0.9" },
      rank: "1 of 3 (cheapest)",
    },
  });
  const instructions = action.instructions as Record<string, unknown>;
  expect(instructions.benchmarks).toEqual({
    "SWE-bench Verified": {
      description: "Resolved rate on real GitHub issues",
      scale: "0 to 100, higher is better",
    },
  });

  const lease = request.questions.lease!;
  expect(Object.keys(lease.criteria)).toEqual(["5", "10", "30"]);
  // The whole request is de-identified: no model identity reaches Jev.
  for (const model of [SOL, SONNET, FLASH]) {
    expect(JSON.stringify(request)).not.toContain(model);
  }
  expect(JSON.stringify(request)).not.toContain("thinking_level");
});

test("omits the lease question when no menu is offered", () => {
  const anonymous = anonymizeSelectorInput(selectorInput() as never, slots());
  const request = buildJevSelectorRequest(anonymous, { model: "jev-latest", leaseTurns: [] });
  expect(request.questions.lease).toBeUndefined();
});

test("puts a custom router's rules, as actions, into the action question", async () => {
  let body: JevSystemOneRequest | undefined;
  const chosen = actionFor(CANDIDATES[0]!);
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return Response.json(jevAnswer(chosen, "10"));
  }) as typeof fetch;
  const custom = {
    ...selectorInput(),
    custom_rules: [{ when: "planning", use: SOL, thinking_level: null }],
    default_target: { model: FLASH, thinking_level: "high" as const },
  };

  const { decision } = await selectWithJev(custom, slots(), CONFIG);

  const instructions = body!.questions.action.instructions as Record<string, unknown>;
  expect(instructions.router_rules).toEqual({
    rules: [{ when: "planning", actions: [actionFor(CANDIDATES[0]!)] }],
    default_actions: [actionFor(CANDIDATES[2]!)],
  });
  expect(JSON.stringify(instructions.rules)).toContain("router_rules");
  expect(JSON.stringify(body)).not.toContain(SOL);
  expect(decision.selectedModel).toBe(SOL);
});

test("maps the Jev answers onto the slots as a leased, anonymous decision", () => {
  const chosen = actionFor(CANDIDATES[2]!);
  const { decision, response } = parseJevSelectorResponse(jevAnswer(chosen, "10"), {
    slots: slots(),
    leaseTurns: [5, 10, 30],
  });
  expect(decision).toEqual({
    selectedModel: FLASH,
    reasoningEffort: "high",
    reason: `Jev selected Action ${chosen} (probability 70%, confidence 60%) with a 10-turn lease (probability 60%).`,
    leaseTurnsRemaining: 9,
  });
  expect(decision.reason).not.toContain(FLASH);
  expect(response.model).toBe("jev-1.13.0");
  expect(response.usage).toEqual({ input_tokens: 1_000, output_tokens: 40 });
});

test("rejects answers outside the slots or the lease menu", () => {
  expect(() =>
    parseJevSelectorResponse(jevAnswer("D", "10"), { slots: slots(), leaseTurns: [5, 10, 30] }),
  ).toThrow("outside this router's candidates");
  try {
    parseJevSelectorResponse(jevAnswer("D", "10"), { slots: slots(), leaseTurns: [5, 10, 30] });
    throw new Error("expected JevOutputError");
  } catch (error) {
    expect(error).toBeInstanceOf(JevOutputError);
    expect((error as JevOutputError).usage).toEqual({
      input_tokens: 1_000,
      output_tokens: 40,
    });
  }
  expect(() =>
    parseJevSelectorResponse(jevAnswer(actionFor(CANDIDATES[0]!), "7"), {
      slots: slots(),
      leaseTurns: [5, 10, 30],
    }),
  ).toThrow("not on the offered menu");
  expect(() =>
    parseJevSelectorResponse(jevAnswer(actionFor(CANDIDATES[0]!), undefined), {
      slots: slots(),
      leaseTurns: [5, 10, 30],
    }),
  ).toThrow("missing a choice answer for lease");
  expect(() =>
    parseJevSelectorResponse(jevAnswer(actionFor(CANDIDATES[0]!), "10", { usage: null }), {
      slots: slots(),
      leaseTurns: [5, 10, 30],
    }),
  ).toThrow("missing token usage");
});


test("selectWithJev posts an anonymized request and maps the answers back", async () => {
  let captured: { url: string; auth: string | null; body: JevSystemOneRequest } | undefined;
  const chosen = actionFor(CANDIDATES[1]!);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = {
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    };
    return Response.json(jevAnswer(chosen, "30"));
  }) as typeof fetch;

  const { decision, response } = await selectWithJev(selectorInput(), slots(), CONFIG);

  expect(captured?.url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(captured?.auth).toBe("Bearer ts-key");
  expect(captured?.body.model).toBe("jev-latest");
  for (const model of [SOL, SONNET, FLASH]) {
    expect(JSON.stringify(captured?.body)).not.toContain(model);
  }
  expect(decision.selectedModel).toBe(SONNET);
  expect(decision.leaseTurnsRemaining).toBe(29);
  expect(response.model).toBe("jev-1.13.0");
});
