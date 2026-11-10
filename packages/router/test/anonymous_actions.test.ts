import { expect, test } from "bun:test";

import type { JsonObject } from "../src/json.js";
import { ANONYMOUS_ACTION_SYSTEM_PROMPT, ANONYMOUS_RULES_PROMPT } from "../src/prompts.js";
import {
  assignAnonymousActions,
  assignStableAnonymousActions,
  anonymizeSelectorInput,
  buildAnonymousPolicyPrompt,
  leaseAnswerInstruction,
  parseAnonymousActionSelection,
  type Rng,
} from "../src/anonymous_actions.js";

const CHEAP = "fireworks/cheap";
const STRONG = "fireworks/strong";
const MEDIUM = "openai/medium";

const CANDIDATES = [
  { model: CHEAP, reasoningEffort: "low" },
  { model: STRONG, reasoningEffort: "high" },
  { model: MEDIUM, reasoningEffort: "medium" },
];

// Deterministic multiplicative-congruential rng; the protocol only requires a
// stable [0, 1) stream.
function rng(seed: number): Rng {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function selectorInput(): JsonObject {
  return {
    candidate_pairs: CANDIDATES.map((candidate) => ({
      model: candidate.model,
      thinking_level: candidate.reasoningEffort,
    })),
    imported_evals: [
      {
        id: "evl_swe",
        name: "SWE-bench",
        description: "Coding reliability",
        min_score: 0,
        max_score: 100,
        scores: [
          {
            model_id: CHEAP,
            thinking_level: "low",
            score: 40,
            rank: 3,
            rank_total: 3,
            z_score: -1.3,
            notes: "cheap model",
          },
          {
            model_id: STRONG,
            thinking_level: "high",
            score: 90,
            rank: 1,
            rank_total: 3,
            z_score: 1.14,
            notes: "strong model",
          },
          {
            model_id: MEDIUM,
            thinking_level: "medium",
            score: 70,
            rank: 2,
            rank_total: 3,
            z_score: 0.16,
            notes: "medium model",
          },
        ],
      },
    ],
    previous_decision: {
      model: MEDIUM,
      thinking_level: "medium",
      reason: `previously selected ${MEDIUM}`,
    },
    cost_estimates: [
      {
        model: CHEAP,
        reasoning_effort: "low",
        pricing_known: true,
        fixed_turn_cost_estimate: {
          output_tokens_per_turn: 700,
          assumed_reasoning_effort: "low",
          cold_start_usd: 0.006,
          projections: [
            { projected_turns: 1, total_cost_usd: 0.006 },
            { projected_turns: 10, total_cost_usd: 0.0432 },
            { projected_turns: 100, total_cost_usd: 0.55 },
          ],
        },
      },
      {
        model: STRONG,
        reasoning_effort: "high",
        pricing_known: true,
        fixed_turn_cost_estimate: {
          output_tokens_per_turn: 700,
          assumed_reasoning_effort: "high",
          cold_start_usd: 0.02,
          projections: [
            { projected_turns: 1, total_cost_usd: 0.02 },
            { projected_turns: 10, total_cost_usd: 0.191 },
            { projected_turns: 100, total_cost_usd: 2.4 },
          ],
        },
      },
      // No configured average output tokens means no loop projection at all.
      {
        model: MEDIUM,
        reasoning_effort: "medium",
        pricing_known: true,
        est_input_cost_usd: 0.09,
        output_cost_per_mtok: 75,
        fixed_turn_cost_estimate: null,
      },
    ],
    lease_history: [
      {
        candidate: { model: MEDIUM, thinking_level: "medium" },
        requested_turns: 10,
        completed_turns: 7,
        rationale: `Action C looked sufficient; never expose ${MEDIUM}.`,
        last_agent_thought: "The parser is fixed; run the focused test.",
        last_tool_call: {
          name: "bash",
          arguments: { command: "bun test parser.test.ts" },
        },
        last_tool_result: { output: "1 passed" },
        tool_errors: 1,
        files_changed: 2,
        tests: {
          command: "bun test parser.test.ts",
          status: "passed",
          result: "1 passed",
        },
      },
    ],
    messages: [{ role: "user", content: "Fix the failing test." }],
  };
}

test("deterministically anonymizes every candidate-bearing selector field", () => {
  const slots = assignAnonymousActions(CANDIDATES, rng(42));
  const replay = assignAnonymousActions(CANDIDATES, rng(42));
  expect(replay).toEqual(slots);
  expect(slots.map((slot) => slot.action)).toEqual(["A", "B", "C"]);

  const anonymous = anonymizeSelectorInput(selectorInput(), slots);
  const prompt = buildAnonymousPolicyPrompt(anonymous, slots);
  const [systemMessage, userMessage] = prompt.messages;
  expect(systemMessage).toEqual({ role: "system", content: ANONYMOUS_ACTION_SYSTEM_PROMPT });
  expect(prompt.actions).toEqual(["A", "B", "C"]);

  const serialized = userMessage.content;
  expect(serialized).not.toContain(CHEAP);
  expect(serialized).not.toContain(STRONG);
  expect(serialized).not.toContain(MEDIUM);
  expect(serialized).not.toContain("thinking_level");
  expect(serialized).not.toContain("reasoning_effort");
  expect(serialized).not.toContain("cheap model");
  expect(serialized).toContain("## Action A");
  expect(serialized).toContain("## Action B");
  expect(serialized).toContain("## Action C");
  expect(serialized).toContain("<conversation>");
  expect(serialized).not.toContain("<task>");
  expect(serialized).toContain("<lease_1>");
  expect(serialized).toContain(`- Model: Action ${actionFor(slots, MEDIUM)}`);
  expect(serialized).toContain("- Requested Turns: 10");
  expect(serialized).toContain("- Completed Turns: 7");
  expect(serialized).toContain("- Tool Errors: 1");
  expect(serialized).toContain('"status":"passed"');
  expect(serialized).toContain("anonymous candidate");
  expect(serialized).toContain("Fix the failing test.");
});

test("renders raw benchmark scores on the benchmark's own scale by default", () => {
  const slots = assignAnonymousActions(CANDIDATES, rng(42));
  const input = selectorInput();
  const card = (input["imported_evals"] as JsonObject[])[0]!;
  card["min_score"] = 0;
  card["max_score"] = 3000;
  const scores = card["scores"] as JsonObject[];
  scores[0]!["score"] = 1210.5;
  scores[1]!["score"] = 1450;
  scores[2]!["score"] = 1320.125;
  const anonymous = anonymizeSelectorInput(input, slots);
  const prompt = buildAnonymousPolicyPrompt(anonymous, slots);
  const [systemMessage, userMessage] = prompt.messages;
  const serialized = userMessage.content;

  expect(systemMessage).toEqual({ role: "system", content: ANONYMOUS_ACTION_SYSTEM_PROMPT });
  expect(serialized).toContain(
    "<benchmarks>\n- SWE-bench (scale 0–3000, higher is better): Coding reliability\n</benchmarks>",
  );
  expect(block(serialized, actionFor(slots, CHEAP))).toEqual([
    "- Cold start cost: $0.006",
    "- Per turn cost: $0.00563",
    "- SWE-bench: Score 1210.5",
  ]);
  expect(block(serialized, actionFor(slots, STRONG))).toEqual([
    "- Cold start cost: $0.02",
    "- Per turn cost: $0.0245",
    "- SWE-bench: Score 1450",
  ]);
  expect(block(serialized, actionFor(slots, MEDIUM))).toEqual([
    "- SWE-bench: Score 1320.13",
  ]);
  expect(serialized).not.toContain("Rank ");
  expect(serialized).not.toContain(", Z ");
  expect(serialized).not.toContain(CHEAP);
  expect(serialized).not.toContain(STRONG);
  expect(serialized).not.toContain(MEDIUM);
});

test("shows a benchmark's published cost per task beside the action's score", () => {
  const slots = assignAnonymousActions(CANDIDATES, rng(42));
  const input = selectorInput();
  const scores = (input["imported_evals"] as JsonObject[])[0]!["scores"] as JsonObject[];
  scores[0]!["cost_per_task_usd"] = 0.0421;
  scores[1]!["cost_per_task_usd"] = 1.5;
  const serialized = buildAnonymousPolicyPrompt(anonymizeSelectorInput(input, slots), slots)
    .messages[1].content;

  expect(serialized).toContain(
    "- SWE-bench (scale 0–100, higher is better): Coding reliability $/task is the model API spend for one task of this benchmark at that action's setting.",
  );
  expect(block(serialized, actionFor(slots, CHEAP))).toContain("- SWE-bench: Score 40, $0.0421/task");
  expect(block(serialized, actionFor(slots, STRONG))).toContain("- SWE-bench: Score 90, $1.50/task");
  expect(block(serialized, actionFor(slots, MEDIUM))).toContain("- SWE-bench: Score 70");
});

test("marks estimated scores and restates the routing job after the conversation", () => {
  const slots = assignAnonymousActions(CANDIDATES, rng(42));
  const input = selectorInput();
  const scores = (input["imported_evals"] as JsonObject[])[0]!["scores"] as JsonObject[];
  scores[1]!["imputed"] = true;
  const serialized = buildAnonymousPolicyPrompt(anonymizeSelectorInput(input, slots), slots)
    .messages[1].content;

  expect(serialized).toContain(
    "<benchmarks>\nScores marked (est.) were estimated from the same model's other settings or its predecessor, not measured.\n",
  );
  expect(block(serialized, actionFor(slots, STRONG))).toContain("- SWE-bench: Score 90 (est.)");
  expect(block(serialized, actionFor(slots, CHEAP))).toContain("- SWE-bench: Score 40");
  expect(serialized.slice(serialized.lastIndexOf("</conversation>"))).toContain(
    "You are routing, not solving",
  );
});

test("anonymized eval cards keep the raw score and scale without model identity", () => {
  const slots = assignAnonymousActions(CANDIDATES, rng(42));
  const anonymous = anonymizeSelectorInput(selectorInput(), slots);
  const card = anonymous.imported_evals[0]!;
  expect(card.min_score).toBe(0);
  expect(card.max_score).toBe(100);
  expect(card.scores.map((score) => score.score).sort((a, b) => a - b)).toEqual([40, 70, 90]);
  expect(Object.keys(card.scores[0]!).sort()).toEqual(["action", "rank", "rank_total", "score", "z_score"]);

  const noScoreValue = selectorInput();
  delete ((noScoreValue["imported_evals"] as JsonObject[])[0]!["scores"] as JsonObject[])[0]!["score"];
  expect(() => anonymizeSelectorInput(noScoreValue, slots)).toThrow("scores[0].score must be a finite number");

  const outOfRange = selectorInput();
  ((outOfRange["imported_evals"] as JsonObject[])[0]!["scores"] as JsonObject[])[0]!["score"] = 101;
  expect(() => anonymizeSelectorInput(outOfRange, slots)).toThrow("score must be between 0 and 100");

  const badRange = selectorInput();
  (badRange["imported_evals"] as JsonObject[])[0]!["max_score"] = 0;
  expect(() => anonymizeSelectorInput(badRange, slots)).toThrow("score range is invalid");
});

test("omits benchmark sections and cost details it has no data for", () => {
  const slots = assignAnonymousActions(CANDIDATES, rng(42));
  const bare = {
    ...selectorInput(),
    imported_evals: [],
    previous_decision: null,
    cost_estimates: null,
    lease_history: [],
  };
  const prompt = buildAnonymousPolicyPrompt(anonymizeSelectorInput(bare, slots), slots);
  const serialized = prompt.messages[1].content;

  expect(serialized).not.toContain("<benchmarks>");
  expect(serialized).not.toContain("<previous_action>");
  expect(serialized).not.toContain("<task>");
  expect(serialized).not.toContain("<lease_history>");
  expect(block(serialized, "A")).toEqual([]);
});

function actionFor(slots: ReturnType<typeof assignAnonymousActions>, model: string): string {
  const slot = slots.find((entry) => entry.candidate.model === model);
  if (slot === undefined) throw new Error(`no slot for ${model}`);
  return slot.action;
}

// The lines of one action's block, so assertions do not depend on the order
// the rng shuffled the candidates into.
function block(prompt: string, action: string): string[] {
  const lines = prompt.split("\n");
  const start = lines.indexOf(`## Action ${action}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = lines.slice(start + 1);
  const end = body.findIndex((line) => line === "" || line === "</candidates>");
  return body.slice(0, end === -1 ? undefined : end);
}

test("different rng streams change the mapping but keep the candidates", () => {
  const first = assignAnonymousActions(CANDIDATES, rng(42));
  const second = assignAnonymousActions(CANDIDATES, rng(1));
  expect(second.map((slot) => slot.candidate)).not.toEqual(first.map((slot) => slot.candidate));
  expect(
    new Set(second.map((slot) => JSON.stringify(slot.candidate))),
  ).toEqual(new Set(first.map((slot) => JSON.stringify(slot.candidate))));
});

test("resolves the strict JSON action back to the real pair", () => {
  const slots = assignAnonymousActions(CANDIDATES, rng(42));
  const selection = parseAnonymousActionSelection('{"action":"B"}', slots);

  expect(selection.action).toBe("B");
  expect(selection.candidate).toEqual(slots[1]!.candidate);
  expect(() =>
    parseAnonymousActionSelection('{"action":"B","reason":"extra"}', slots),
  ).toThrow("must contain exactly");
  expect(() => parseAnonymousActionSelection('{"action":"Z"}', slots)).toThrow(
    "unavailable action Z",
  );
});

test("parses the lease turns beside the action when a menu is offered", () => {
  const slots = assignAnonymousActions(CANDIDATES, rng(42));
  const menu = [5, 10, 30];

  const selection = parseAnonymousActionSelection('{"action":"B","turns":10}', slots, menu);
  expect(selection.action).toBe("B");
  expect(selection.turns).toBe(10);

  // With a menu the turns field is mandatory and must be on the menu.
  expect(() => parseAnonymousActionSelection('{"action":"B"}', slots, menu)).toThrow(
    "must contain exactly",
  );
  expect(() =>
    parseAnonymousActionSelection('{"action":"B","turns":7}', slots, menu),
  ).toThrow("must be one of 5, 10, 30");
  // Without a menu the turns field is rejected, preserving the strict shape.
  expect(() =>
    parseAnonymousActionSelection('{"action":"B","turns":10}', slots),
  ).toThrow("must contain exactly");
});

test("supports more than 26 anonymous actions", () => {
  const candidates = Array.from({ length: 53 }, (_, index) => ({
    model: `fireworks/model-${index}`,
    reasoningEffort: "low",
  }));
  const slots = assignAnonymousActions(candidates, () => 0.999999);

  expect(slots.map((slot) => slot.action).slice(24)).toEqual([
    "Y", "Z", "AA", "AB", "AC", "AD", "AE", "AF", "AG", "AH",
    "AI", "AJ", "AK", "AL", "AM", "AN", "AO", "AP", "AQ", "AR",
    "AS", "AT", "AU", "AV", "AW", "AX", "AY", "AZ", "BA",
  ]);
});

test("rejects candidate sets that cannot form anonymous actions", () => {
  expect(() => assignAnonymousActions(CANDIDATES.slice(0, 1), rng(42))).toThrow(
    "at least two candidates",
  );
  const duplicate = [CANDIDATES[0]!, CANDIDATES[0]!];
  expect(() => assignAnonymousActions(duplicate, rng(42))).toThrow(
    "Duplicate anonymous action candidate",
  );
});

test("rejects malformed or identity-leaking selector shapes", () => {
  const slots = assignAnonymousActions(CANDIDATES, rng(42));

  const badPairs = { ...selectorInput(), candidate_pairs: null };
  expect(() => anonymizeSelectorInput(badPairs, slots)).toThrow(
    "candidate_pairs must be an array",
  );

  const mismatch = { ...selectorInput(), candidate_pairs: [] };
  expect(() => anonymizeSelectorInput(mismatch, slots)).toThrow(
    "Routing and selector candidates do not match",
  );

  const badEvals = { ...selectorInput(), imported_evals: null };
  expect(() => anonymizeSelectorInput(badEvals, slots)).toThrow(
    "imported_evals must be an array",
  );

  const badScores = { ...selectorInput(), imported_evals: [{ id: "eval", scores: null }] };
  expect(() => anonymizeSelectorInput(badScores, slots)).toThrow(
    "scores must be an array",
  );

  const badCosts = { ...selectorInput(), cost_estimates: {} };
  expect(() => anonymizeSelectorInput(badCosts, slots)).toThrow(
    "cost_estimates must be an array or null",
  );

  // Pre-projection estimates (a bare scalar shape) must fail loudly instead of
  // silently rendering the candidate's cost as unavailable.
  const legacyCost = selectorInput();
  (legacyCost["cost_estimates"] as JsonObject[])[0]!["fixed_turn_cost_estimate"] = {
    projected_turns: 10,
    total_cost_usd: 0.05,
  };
  expect(() => anonymizeSelectorInput(legacyCost, slots)).toThrow(
    "fixed_turn_cost_estimate must carry a projections array",
  );

  const staleEval = selectorInput();
  (staleEval["imported_evals"] as JsonObject[])[0]!["scores"] = [
    {
      model_id: "openai/not-a-candidate",
      thinking_level: "low",
      score: 1,
      rank: 1,
      rank_total: 1,
      z_score: 0,
    },
  ];
  expect(() => anonymizeSelectorInput(staleEval, slots)).toThrow(
    "references unavailable candidate openai/not-a-candidate/low",
  );
});

test("rejects impossible ranks and inconsistent resolved-candidate denominators", () => {
  const slots = assignAnonymousActions(CANDIDATES, rng(42));
  const impossibleRank = selectorInput();
  const impossibleScores = (impossibleRank["imported_evals"] as JsonObject[])[0]![
    "scores"
  ] as JsonObject[];
  impossibleScores[0]!["rank"] = 4;
  expect(() => anonymizeSelectorInput(impossibleRank, slots)).toThrow(
    "rank must be an integer between 1 and rank_total",
  );

  const inconsistentTotal = selectorInput();
  const inconsistentScores = (inconsistentTotal["imported_evals"] as JsonObject[])[0]![
    "scores"
  ] as JsonObject[];
  inconsistentScores[0]!["rank_total"] = 4;
  expect(() => anonymizeSelectorInput(inconsistentTotal, slots)).toThrow(
    "rank_total must equal the resolved score count 3",
  );

  const anonymous = anonymizeSelectorInput(selectorInput(), slots);
  anonymous.imported_evals[0]!.scores[0]!.rank = 4;
  expect(() => buildAnonymousPolicyPrompt(anonymous, slots)).toThrow(
    "rank must be an integer between 1 and rank_total",
  );
});

test("rejects impossible lease history turn counts", () => {
  const slots = assignAnonymousActions(CANDIDATES, rng(42));
  const input = selectorInput();
  const lease = (input["lease_history"] as JsonObject[])[0]!;
  lease["completed_turns"] = 11;

  expect(() => anonymizeSelectorInput(input, slots)).toThrow(
    "completed_turns must not exceed requested_turns",
  );
});

test("an empty lease menu parses per-turn completions", () => {
  const slots = assignAnonymousActions(CANDIDATES, rng(42));

  expect(parseAnonymousActionSelection('{"action":"A"}', slots, [])).toEqual({
    action: "A",
    candidate: slots[0]!.candidate,
  });
  expect(() => parseAnonymousActionSelection('{"action":"A","turns":5}', slots, [])).toThrow(
    'must contain exactly {"action":...}',
  );
});

test("rejects malformed action completions", () => {
  const slots = assignAnonymousActions(CANDIDATES, rng(42));
  expect(() => parseAnonymousActionSelection("not json", slots)).toThrow("not valid JSON");
  expect(() => parseAnonymousActionSelection('{"action":1}', slots)).toThrow(
    "action must be a string",
  );
  expect(() => parseAnonymousActionSelection("[]", slots)).toThrow("must be an object");
});

test("levels sharing a prompt cache share a letter with a level suffix", () => {
  const roster = [
    { model: "m/shared", reasoningEffort: "low" },
    { model: "m/shared", reasoningEffort: "high" },
    { model: "m/keyed", reasoningEffort: "low" },
    { model: "m/keyed", reasoningEffort: "high" },
  ];
  const cacheScope = (model: string) => (model === "m/shared" ? "shared" as const : "effort_keyed" as const);
  const slots = assignAnonymousActions(roster, rng(42), cacheScope);
  const actionOf = (model: string, effort: string) =>
    slots.find((slot) => slot.candidate.model === model && slot.candidate.reasoningEffort === effort)!.action;

  const sharedLetter = actionOf("m/shared", "low").split(":")[0];
  expect(actionOf("m/shared", "low")).toBe(`${sharedLetter}:low`);
  expect(actionOf("m/shared", "high")).toBe(`${sharedLetter}:high`);
  expect(actionOf("m/keyed", "low")).toMatch(/^[A-C]$/);
  expect(actionOf("m/keyed", "high")).toMatch(/^[A-C]$/);
  expect(new Set(slots.map((slot) => slot.action.split(":")[0])).size).toBe(3);

  const pruned = assignStableAnonymousActions(roster, [roster[1]!, roster[2]!], rng(42), cacheScope);
  expect(pruned.map((slot) => slot.action).sort()).toEqual(
    [actionOf("m/shared", "high"), actionOf("m/keyed", "low")].sort(),
  );
  expect(parseAnonymousActionSelection(`{"action":"${sharedLetter}:high"}`, slots).candidate).toEqual(roster[1]);

  // Without a cache scope every pair keeps its own bare letter, as before.
  expect(assignAnonymousActions(roster, rng(42)).map((slot) => slot.action)).toEqual(["A", "B", "C", "D"]);
});

test("stable letters survive pruning of the active menu", () => {
  const roster = [
    { model: "m/alpha", reasoningEffort: "low" },
    { model: "m/beta", reasoningEffort: "high" },
    { model: "m/gamma", reasoningEffort: "high" },
    { model: "m/delta", reasoningEffort: "medium" },
  ];
  const rng = () => 0.42;
  const full = assignStableAnonymousActions(roster, roster, rng);
  const pruned = assignStableAnonymousActions(
    roster,
    [roster[1]!, roster[3]!],
    rng,
  );
  const letterFor = (slots: ReturnType<typeof assignStableAnonymousActions>, model: string) =>
    slots.find((slot) => slot.candidate.model === model)?.action;
  expect(letterFor(pruned, "m/beta")).toBe(letterFor(full, "m/beta"));
  expect(letterFor(pruned, "m/delta")).toBe(letterFor(full, "m/delta"));
  expect(pruned).toHaveLength(2);
  expect(() =>
    assignStableAnonymousActions(roster, [{ model: "m/other", reasoningEffort: "low" }, roster[0]!], rng),
  ).toThrow(/not on the anonymous action roster/);
  expect(() =>
    assignStableAnonymousActions(roster, [roster[0]!], rng),
  ).toThrow(/at least two active candidates/);
});

test("states the lease menu as a range when contiguous and as values otherwise", () => {
  const range = Array.from({ length: 196 }, (_, index) => index + 5);
  expect(leaseAnswerInstruction(range)).toBe(
    'Answer with {"action": <action>, "turns": <lease length>}, where action is written exactly as in its "## Action" heading and turns is any whole number from 5 to 200.',
  );
  expect(leaseAnswerInstruction([30, 5, 10])).toEndWith("turns is one of 5, 10, 30.");
  expect(() => leaseAnswerInstruction([])).toThrow("requires lease turn options");
});

test("a custom router's rules become an anonymous system addendum", () => {
  const slots = assignAnonymousActions(CANDIDATES, rng(42));
  const plain = buildAnonymousPolicyPrompt(anonymizeSelectorInput(selectorInput(), slots), slots);
  const anonymous = anonymizeSelectorInput(
    {
      ...selectorInput(),
      custom_rules: [
        { when: "planning and design", use: STRONG, thinking_level: null },
        { when: "small edits", use: CHEAP, thinking_level: "low" },
      ],
      default_target: { model: MEDIUM, thinking_level: null },
    },
    slots,
  );
  const prompt = buildAnonymousPolicyPrompt(anonymous, slots);
  const [systemMessage, userMessage] = prompt.messages;

  expect(anonymous.router_rules).toEqual({
    rules: [
      { when: "planning and design", actions: [actionFor(slots, STRONG)] },
      { when: "small edits", actions: [actionFor(slots, CHEAP)] },
    ],
    default_actions: [actionFor(slots, MEDIUM)],
  });
  expect(systemMessage.content.startsWith(`${ANONYMOUS_ACTION_SYSTEM_PROMPT}\n\n${ANONYMOUS_RULES_PROMPT}\n`)).toBe(true);
  expect(systemMessage.content).toContain(
    `<router_rules>\n- When "planning and design": Action ${actionFor(slots, STRONG)}\n`,
  );
  expect(systemMessage.content).toContain(`- Default: Action ${actionFor(slots, MEDIUM)}\n</router_rules>`);
  for (const model of [CHEAP, STRONG, MEDIUM]) expect(systemMessage.content).not.toContain(model);
  // The data message is the same as for a router without rules.
  expect(userMessage).toEqual(plain.messages[1]);
});
