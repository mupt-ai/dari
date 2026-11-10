// Anonymous candidate-action selector protocol. Candidates are shuffled into
// anonymous action slots ("A", "B", ..., "AA", ...) and every model-identifying
// field in the selector input is replaced by its slot, so a trained policy
// cannot memorize model names or list positions. This is the canonical
// open-weight selector protocol used by Dari's routing strategy; the
// named-candidate protocol in selector_input.ts/prompts.ts remains available
// for custom routers that use a general-purpose LLM selector.

import { createHash } from "node:crypto";

import type { ReasoningCacheScopeLookup } from "./cache_scope.js";
import { FIXED_TURN_COST_COMPARISON_TURNS } from "./fixed_turn_cost_config.js";
import { ANONYMOUS_ACTION_SYSTEM_PROMPT, ANONYMOUS_RULES_PROMPT } from "./prompts.js";
import {
  jsonRecord,
  jsonValue,
  requiredString,
  type JsonObject,
  type JsonValue,
} from "./json.js";
import type { TurnCostProjection } from "./types.js";

// Deterministic random source in [0, 1). Callers own seeding so experiment
// harnesses can reproduce recorded permutations with their own PRNG.
export type Rng = () => number;

export type AnonymousActionCandidate = {
  model: string;
  reasoningEffort: string;
};

export type AnonymousActionSlot = {
  action: string;
  candidate: AnonymousActionCandidate;
};

export type AnonymousSelectorMessage = {
  role: "system" | "user";
  content: string;
};

export type AnonymousPolicyPrompt = {
  messages: [system: AnonymousSelectorMessage, user: AnonymousSelectorMessage];
  actions: string[];
};

export type AnonymousActionSelection = {
  action: string;
  candidate: AnonymousActionCandidate;
  // Turns the selection commits to when the caller offered a lease menu;
  // absent for single-turn selectors.
  turns?: number;
};

// The de-identified selector input. Every field is JSON-serializable so it can
// cross a process boundary, but it is a concrete type rather than a bag: it is
// produced by anonymizeSelectorInput and consumed by the prompt formatter, so
// nothing downstream needs to re-parse it.
export type AnonymousEvalScore = {
  action: string;
  rank: number;
  rank_total: number;
  z_score: number;
  score: number;
  cost_per_task_usd?: number;
  // Estimated from the same model's other settings or its predecessor.
  estimated?: true;
};

export type AnonymousEvalCard = {
  name: string;
  description: string | null;
  min_score: number;
  max_score: number;
  scores: AnonymousEvalScore[];
};

export type AnonymousActionCost = {
  action: string;
  cold_start_usd: number;
  projections: TurnCostProjection[];
};

export type AnonymousLeaseHistoryEntry = {
  action: string;
  requested_turns: number;
  completed_turns: number;
  rationale: string;
  last_agent_thought: string | null;
  last_tool_call: {
    name: string;
    arguments: JsonValue;
  } | null;
  last_tool_result: JsonValue | null;
  tool_errors: number | null;
  files_changed: number | null;
  tests: {
    command: string;
    status: "passed" | "failed" | "unknown";
    result: JsonValue | null;
  } | null;
};

// A custom router's rules with each target rewritten into the actions it
// allows: a pinned thinking level is one action, Auto is every action of
// that model.
export type AnonymousRouterRules = {
  rules: Array<{ when: string; actions: string[] }>;
  default_actions: string[] | null;
};

export type AnonymousSelectorInput = {
  candidate_actions: Array<{ action: string }>;
  imported_evals: AnonymousEvalCard[];
  previous_action: { action: string } | null;
  cost_estimates: AnonymousActionCost[];
  lease_history: AnonymousLeaseHistoryEntry[];
  messages: JsonValue;
  // Present only for routers with custom rules.
  router_rules?: AnonymousRouterRules;
};

// Shuffles candidates into spreadsheet-style action slots A..Z, AA..AZ, ...
// with the injected rng. Given a cache scope, a model whose thinking levels
// share one prompt cache gets one letter with a level suffix ("A:high",
// "A:low"), so the policy sees that changing level keeps the cache warm;
// effort-keyed levels stay separate letters.
export function assignAnonymousActions(
  candidates: readonly AnonymousActionCandidate[],
  rng: Rng,
  cacheScope?: ReasoningCacheScopeLookup,
): AnonymousActionSlot[] {
  if (candidates.length < 2) {
    throw new Error(`Anonymous action routing requires at least two candidates, got ${candidates.length}`);
  }
  const keys = new Set<string>();
  const groups = new Map<string, AnonymousActionCandidate[]>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate.model, candidate.reasoningEffort);
    if (keys.has(key)) throw new Error(`Duplicate anonymous action candidate ${key}`);
    keys.add(key);
    const groupKey = cacheScope?.(candidate.model) === "shared" ? candidate.model : key;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), candidate]);
  }
  return shuffled([...groups.values()], rng).flatMap((group, index) =>
    group.map((candidate) => ({
      action: group.length === 1
        ? actionForIndex(index)
        : `${actionForIndex(index)}:${candidate.reasoningEffort}`,
      candidate,
    })),
  );
}

// Assigns letters over the conversation's full candidate roster, then keeps
// only the currently routable candidates with their letters intact. Letters
// therefore stay fixed for the whole agent loop even when pruning shrinks the
// menu mid-conversation; a pruned candidate's letter simply goes absent
// instead of being reassigned.
export function assignStableAnonymousActions(
  allCandidates: readonly AnonymousActionCandidate[],
  activeCandidates: readonly AnonymousActionCandidate[],
  rng: Rng,
  cacheScope?: ReasoningCacheScopeLookup,
): AnonymousActionSlot[] {
  const slots = assignAnonymousActions(allCandidates, rng, cacheScope);
  const byKey = new Map(
    slots.map((slot) => [candidateKey(slot.candidate.model, slot.candidate.reasoningEffort), slot]),
  );
  const rosterOrder = new Map(slots.map((slot, index) => [slot, index]));
  const active = activeCandidates.map((candidate) => {
    const slot = byKey.get(candidateKey(candidate.model, candidate.reasoningEffort));
    if (slot === undefined) {
      throw new Error(
        `Active candidate ${candidate.model}/${candidate.reasoningEffort} is not on the anonymous action roster`,
      );
    }
    return slot;
  });
  if (active.length < 2) {
    throw new Error(
      `Anonymous action routing requires at least two active candidates, got ${active.length}`,
    );
  }
  // Menu order follows the roster's letter order, matching the single-roster
  // behavior where slots come back in assignment order.
  return active.sort((left, right) => rosterOrder.get(left)! - rosterOrder.get(right)!);
}

function actionForIndex(index: number): string {
  let remaining = index;
  let action = "";
  do {
    action = String.fromCharCode("A".charCodeAt(0) + (remaining % 26)) + action;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return action;
}

// Rewrites a named-candidate selector input (see selector_input.ts) into its
// anonymous-action form. The input must reference exactly the candidates in
// `slots`; any mismatch is an error rather than a silent partial rewrite.
export function anonymizeSelectorInput(
  selectorInput: JsonObject,
  slots: readonly AnonymousActionSlot[],
): AnonymousSelectorInput {
  const input = jsonRecord(structuredClone(selectorInput), "selector input");
  const byCandidate = new Map(
    slots.map((slot) => [candidateKey(slot.candidate.model, slot.candidate.reasoningEffort), slot.action]),
  );
  assertSelectorCandidates(input["candidate_pairs"], byCandidate);

  return {
    candidate_actions: slots.map((slot) => ({ action: slot.action })),
    imported_evals: anonymizeEvals(input["imported_evals"], byCandidate),
    previous_action: anonymizePreviousDecision(input["previous_decision"], byCandidate),
    cost_estimates: anonymizeCosts(input["cost_estimates"], byCandidate),
    lease_history: anonymizeLeaseHistory(input["lease_history"], byCandidate),
    messages: jsonValue(input["messages"], "selector input messages"),
    ...(Array.isArray(input["custom_rules"])
      ? { router_rules: anonymizeRouterRules(input["custom_rules"], input["default_target"], slots) }
      : {}),
  };
}

function anonymizeRouterRules(
  customRules: JsonValue[],
  defaultTarget: JsonValue | undefined,
  slots: readonly AnonymousActionSlot[],
): AnonymousRouterRules {
  const actionsFor = (model: string, thinkingLevel: JsonValue | undefined) =>
    slots
      .filter((slot) =>
        slot.candidate.model === model
        && (thinkingLevel === null || thinkingLevel === undefined
          || slot.candidate.reasoningEffort === thinkingLevel)
      )
      .map((slot) => slot.action);
  const rules = customRules.flatMap((value, index) => {
    const rule = jsonRecord(value, `custom_rules[${index}]`);
    const actions = actionsFor(
      requiredString(rule["use"], `custom_rules[${index}].use`),
      rule["thinking_level"],
    );
    return actions.length === 0
      ? []
      : [{ when: requiredString(rule["when"], `custom_rules[${index}].when`), actions }];
  });
  let defaultActions: string[] | null = null;
  if (defaultTarget !== null && defaultTarget !== undefined) {
    const target = jsonRecord(defaultTarget, "default_target");
    const actions = actionsFor(
      requiredString(target["model"], "default_target.model"),
      target["thinking_level"],
    );
    defaultActions = actions.length === 0 ? null : actions;
  }
  return { rules, default_actions: defaultActions };
}

export function buildAnonymousPolicyPrompt(
  anonymousSelectorInput: AnonymousSelectorInput,
  slots: readonly AnonymousActionSlot[],
): AnonymousPolicyPrompt {
  // Rules are static per router, so they ride in the system prompt and the
  // conversation-last user message keeps its shared prefix.
  const rules = anonymousSelectorInput.router_rules;
  return {
    messages: [
      {
        role: "system",
        content: rules === undefined
          ? ANONYMOUS_ACTION_SYSTEM_PROMPT
          : `${ANONYMOUS_ACTION_SYSTEM_PROMPT}\n\n${ANONYMOUS_RULES_PROMPT}\n${formatRouterRules(rules)}`,
      },
      { role: "user", content: formatAnonymousPolicyInput(anonymousSelectorInput) },
    ],
    actions: slots.map((slot) => slot.action),
  };
}

export function formatRouterRules(rules: AnonymousRouterRules): string {
  const actionList = (actions: readonly string[]) =>
    actions.map((action) => `Action ${action}`).join(", ");
  const lines = rules.rules.map((rule) => `- When ${JSON.stringify(rule.when)}: ${actionList(rule.actions)}`);
  if (rules.default_actions !== null) lines.push(`- Default: ${actionList(rules.default_actions)}`);
  return section("router_rules", lines.join("\n"));
}

// The answer format a lease-trained policy learned, stating its lease menu: a
// contiguous range as "any whole number from a to b", otherwise the values.
// Training appends it to the system prompt, so serving must too.
export function leaseAnswerInstruction(leaseTurns: readonly number[]): string {
  if (leaseTurns.length === 0) throw new Error("A lease answer instruction requires lease turn options");
  const sorted = [...leaseTurns].sort((left, right) => left - right);
  const contiguous = sorted.every((turns, index) => index === 0 || turns === sorted[index - 1]! + 1);
  const menu = contiguous
    ? `any whole number from ${sorted[0]} to ${sorted[sorted.length - 1]}`
    : `one of ${sorted.join(", ")}`;
  return `Answer with {"action": <action>, "turns": <lease length>}, where action is written exactly as in its "## Action" heading and turns is ${menu}.`;
}

// The conversation is the coding agent's own transcript, and a long one ends
// the prompt far from the system prompt, so the policy can drift into doing
// the agent's task. The job is restated after it.
const ROUTING_REMINDER =
  "You are routing, not solving: the conversation above is evidence about the coding agent's progress. " +
  "Pick the action and lease length for the agent's next turns, and answer only with the JSON.";

// Renders the anonymous selector input as sectioned text rather than raw JSON.
// One block per action carries that action's benchmark evidence and its
// projected cost, so the policy compares like against like instead of
// re-deriving comparisons from scores on incomparable scales and six cost
// fields. How to read those blocks lives in the score system prompt,
// keeping this message pure data. The conversation goes last: it is the only
// section that grows turn over turn, so keeping it at the end preserves the
// shared prefix.
export function formatAnonymousPolicyInput(input: AnonymousSelectorInput): string {
  assertValidBenchmarkStandings(input.imported_evals);
  const sections = [
    ...(input.imported_evals.length > 0
      ? [section(
          "benchmarks",
          [
            ...(input.imported_evals.some((card) => card.scores.some((score) => score.estimated))
              ? ["Scores marked (est.) were estimated from the same model's other settings or its predecessor, not measured."]
              : []),
            ...input.imported_evals.map((card) => glossaryLine(card)),
          ].join("\n"),
        )]
      : []),
    section(
      "candidates",
      input.candidate_actions
        .map((candidate) => candidateBlock(candidate.action, input))
        .join("\n\n"),
    ),
    ...(input.previous_action === null
      ? []
      : [section("previous_action", input.previous_action.action)]),
    ...(input.lease_history.length === 0
      ? []
      : [section(
          "lease_history",
          input.lease_history.map((entry, index) => leaseBlock(entry, index)).join("\n\n"),
        )]),
    section("conversation", JSON.stringify(input.messages)),
    ROUTING_REMINDER,
  ];
  return sections.join("\n\n");
}

function leaseBlock(entry: AnonymousLeaseHistoryEntry, index: number): string {
  const lines = [
    `<lease_${index + 1}>`,
    `- Model: Action ${entry.action}`,
    `- Requested Turns: ${entry.requested_turns}`,
    `- Completed Turns: ${entry.completed_turns}`,
    `- Rationale: ${JSON.stringify(entry.rationale)}`,
    `- Last Agent Thought: ${jsonLabel(entry.last_agent_thought)}`,
    `- Last Tool Call: ${jsonLabel(entry.last_tool_call)}`,
    `- Last Tool Result: ${jsonLabel(entry.last_tool_result)}`,
    `- Tool Errors: ${entry.tool_errors === null ? "Unknown" : entry.tool_errors}`,
    `- Files Changed: ${entry.files_changed === null ? "Unknown" : entry.files_changed}`,
    `- Tests: ${entry.tests === null ? "Not Run" : JSON.stringify(entry.tests)}`,
    `</lease_${index + 1}>`,
  ];
  return lines.join("\n");
}

function jsonLabel(value: JsonValue | null): string {
  return value === null ? "None" : JSON.stringify(value);
}

function section(name: string, body: string): string {
  return `<${name}>\n${body}\n</${name}>`;
}

function candidateBlock(action: string, input: AnonymousSelectorInput): string {
  const cost = input.cost_estimates.find((entry) => entry.action === action);
  const lines = [`## Action ${action}`];
  if (cost !== undefined) lines.push(...costLines(cost));
  for (const card of input.imported_evals) {
    const score = card.scores.find((entry) => entry.action === action);
    if (score !== undefined) {
      const line = `- ${card.name}: Score ${rawScore(score.score)}${score.estimated ? " (est.)" : ""}`;
      lines.push(
        score.cost_per_task_usd === undefined
          ? line
          : `${line}, ${usd(score.cost_per_task_usd)}/task`,
      );
    }
  }
  return lines.join("\n");
}

function rawScore(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.?0+$/, "");
}

// Two numbers per action. The cold start is what switching to it costs before
// its cache is warm. The per turn cost is the steady spend once it is warm,
// taken from the turns between the comparison horizon and the longest one so
// the cold start does not leak into it.
function costLines(cost: AnonymousActionCost): string[] {
  const at = (turns: number) =>
    cost.projections.find((entry) => entry.projected_turns === turns);
  const comparison = at(FIXED_TURN_COST_COMPARISON_TURNS);
  const longest = cost.projections[cost.projections.length - 1]!;
  const warmTurns = longest.projected_turns - FIXED_TURN_COST_COMPARISON_TURNS;
  const perTurn = comparison === undefined || warmTurns <= 0
    ? longest.total_cost_usd / longest.projected_turns
    : (longest.total_cost_usd - comparison.total_cost_usd) / warmTurns;
  return [
    `- Cold start cost: ${usd(cost.cold_start_usd)}`,
    `- Per turn cost: ${usd(perTurn)}`,
  ];
}

function usd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  const trimmed = value.toPrecision(3).replace(/0+$/, "").replace(/\.$/, "");
  return `$${trimmed}`;
}

function glossaryLine(card: AnonymousEvalCard): string {
  const scale = ` (scale ${rawScore(card.min_score)}–${rawScore(card.max_score)}, higher is better)`;
  const line = card.description === null
    ? `- ${card.name}${scale}`
    : `- ${card.name}${scale}: ${card.description}`;
  return card.scores.some((score) => score.cost_per_task_usd !== undefined)
    ? `${line} $/task is the model API spend for one task of this benchmark at that action's setting.`
    : line;
}

function assertValidBenchmarkStandings(cards: readonly AnonymousEvalCard[]): void {
  for (const [cardIndex, card] of cards.entries()) {
    const resolvedCount = card.scores.length;
    for (const [scoreIndex, score] of card.scores.entries()) {
      assertValidBenchmarkStanding(
        score.rank,
        score.rank_total,
        resolvedCount,
        `anonymous eval[${cardIndex}].scores[${scoreIndex}]`,
      );
    }
  }
}

function assertValidBenchmarkStanding(
  rank: number,
  rankTotal: number,
  resolvedCount: number,
  label: string,
): void {
  if (!Number.isInteger(rank) || rank < 1 || rank > rankTotal) {
    throw new Error(`${label}.rank must be an integer between 1 and rank_total`);
  }
  if (!Number.isInteger(rankTotal) || rankTotal !== resolvedCount) {
    throw new Error(
      `${label}.rank_total must equal the resolved score count ${resolvedCount}`,
    );
  }
}

function previousAction(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(
    jsonRecord(value, "anonymous previous_action")["action"],
    "anonymous previous_action.action",
  );
}

function isRecordValue(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Parses a policy completion against the permutation's slots. Without a lease
// menu the exact shape is {"action":"B"}; with one it is
// {"action":"B","turns":10} and turns must be on the menu.
export function parseAnonymousActionSelection(
  completion: string,
  slots: readonly AnonymousActionSlot[],
  leaseTurns?: readonly number[],
): AnonymousActionSelection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(completion);
  } catch {
    throw new Error("Anonymous action completion is not valid JSON");
  }
  const record = jsonRecord(parsed, "anonymous action completion");
  const keys = Object.keys(record);
  // An empty menu means the caller routes one turn at a time, same as no menu.
  const offeredLeaseTurns =
    leaseTurns !== undefined && leaseTurns.length > 0 ? leaseTurns : undefined;
  const expected = offeredLeaseTurns === undefined ? ["action"] : ["action", "turns"];
  if (keys.length !== expected.length || expected.some((key, i) => keys[i] !== key)) {
    throw new Error(
      `Anonymous action completion must contain exactly {${expected
        .map((key) => `"${key}":...`)
        .join(",")}}`,
    );
  }
  const action = record["action"];
  if (typeof action !== "string") {
    throw new Error("Anonymous action completion action must be a string");
  }
  const slot = slots.find((candidate) => candidate.action === action);
  if (slot === undefined) {
    throw new Error(`Anonymous action completion selected unavailable action ${action}`);
  }
  if (offeredLeaseTurns === undefined) return { action, candidate: slot.candidate };
  const turns = record["turns"];
  if (typeof turns !== "number" || !offeredLeaseTurns.includes(turns)) {
    throw new Error(
      `Anonymous action completion turns must be one of ${offeredLeaseTurns.join(", ")}`,
    );
  }
  return { action, candidate: slot.candidate, turns };
}

// Deterministic per-conversation rng so a conversation's action letters stay
// fixed across turns. The hash keeps unrelated conversation identifiers from
// exposing adjacent seeds.
export function sessionRng(sessionId: string): Rng {
  const digest = createHash("sha256")
    .update("dari-anonymous-actions-v1\u0000")
    .update(sessionId)
    .digest();
  let state = digest.readUInt32BE(0);
  return () => {
    // Mulberry32.
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

// Fisher-Yates copy, drawing from the end, matching d3-array's shuffler so an
// injected rng reproduces permutations recorded by harnesses that used d3.
function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const array = [...items];
  let m = array.length;
  while (m) {
    const i = (rng() * m--) | 0;
    const t = array[m]!;
    array[m] = array[i]!;
    array[i] = t;
  }
  return array;
}

function assertSelectorCandidates(
  value: unknown,
  byCandidate: ReadonlyMap<string, string>,
): void {
  if (!Array.isArray(value)) {
    throw new Error("Selector input candidate_pairs must be an array");
  }
  const selectorKeys = new Set(
    value.map((candidate, index) => {
      const record = jsonRecord(candidate, `selector candidate[${index}]`);
      return candidateKey(
        requiredString(record["model"], `selector candidate[${index}].model`),
        requiredString(
          record["thinking_level"],
          `selector candidate[${index}].thinking_level`,
        ),
      );
    }),
  );
  if (selectorKeys.size !== byCandidate.size || [...byCandidate.keys()].some((key) => !selectorKeys.has(key))) {
    throw new Error("Routing and selector candidates do not match");
  }
}

function anonymizeEvals(
  value: unknown,
  byCandidate: ReadonlyMap<string, string>,
): AnonymousEvalCard[] {
  if (!Array.isArray(value)) {
    throw new Error("Selector input imported_evals must be an array");
  }
  return value.map((entry, evalIndex) => {
    const card = jsonRecord(entry, `selector eval[${evalIndex}]`);
    const scores = card["scores"];
    if (!Array.isArray(scores)) {
      throw new Error(`selector eval[${evalIndex}].scores must be an array`);
    }
    const resolvedCount = scores.length;
    const cardLabel = `selector eval[${evalIndex}]`;
    const minScore = requiredNumber(card["min_score"], `${cardLabel}.min_score`);
    const maxScore = requiredNumber(card["max_score"], `${cardLabel}.max_score`);
    if (minScore >= maxScore) throw new Error(`${cardLabel} score range is invalid`);
    const anonymousScores = scores.map((entryScore, scoreIndex) => {
      const label = `${cardLabel}.scores[${scoreIndex}]`;
      const score = jsonRecord(entryScore, label);
      const rank = requiredNumber(score["rank"], `${label}.rank`);
      const rankTotal = requiredNumber(score["rank_total"], `${label}.rank_total`);
      assertValidBenchmarkStanding(rank, rankTotal, resolvedCount, label);
      const rawScore = requiredNumber(score["score"], `${label}.score`);
      if (rawScore < minScore || rawScore > maxScore) {
        throw new Error(`${label}.score must be between ${minScore} and ${maxScore}`);
      }
      const costPerTask = score["cost_per_task_usd"];
      if (costPerTask !== undefined && (typeof costPerTask !== "number" || !(costPerTask > 0))) {
        throw new Error(`${label}.cost_per_task_usd must be a positive number`);
      }
      const imputed = score["imputed"];
      if (imputed !== undefined && imputed !== true) {
        throw new Error(`${label}.imputed must be true when present`);
      }
      return {
        action: actionForCandidate(
          byCandidate,
          requiredString(score["model_id"], `${label}.model_id`),
          requiredString(score["thinking_level"], `${label}.thinking_level`),
        ),
        rank,
        rank_total: rankTotal,
        z_score: requiredNumber(score["z_score"], `${label}.z_score`),
        score: rawScore,
        ...(costPerTask === undefined ? {} : { cost_per_task_usd: costPerTask }),
        ...(imputed === true ? { estimated: true as const } : {}),
      };
    });
    return {
      name: requiredString(card["name"], `${cardLabel}.name`),
      description: typeof card["description"] === "string" ? card["description"] : null,
      min_score: minScore,
      max_score: maxScore,
      // Explicit allowlist: notes and any future field can name the model.
      scores: anonymousScores,
    };
  });
}

function anonymizePreviousDecision(
  value: unknown,
  byCandidate: ReadonlyMap<string, string>,
): { action: string } | null {
  if (value === null || value === undefined) return null;
  const previous = jsonRecord(value, "selector previous_decision");
  const model = requiredString(previous["model"], "selector previous_decision.model");
  const thinkingLevel = requiredString(
    previous["thinking_level"],
    "selector previous_decision.thinking_level",
  );
  return {
    action: actionForCandidate(byCandidate, model, thinkingLevel),
  };
}

function anonymizeCosts(
  value: unknown,
  byCandidate: ReadonlyMap<string, string>,
): AnonymousActionCost[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Selector input cost_estimates must be an array or null");
  }
  // Only the loop projections survive. The per-request fields the prompt does
  // not show would be dead weight, and assumed_reasoning_effort names the
  // candidate's thinking level, which the protocol exists to hide.
  return value.flatMap((entry, index) => {
    const label = `selector cost_estimates[${index}]`;
    const cost = jsonRecord(entry, label);
    const action = actionForCandidate(
      byCandidate,
      requiredString(cost["model"], `${label}.model`),
      requiredString(cost["reasoning_effort"], `${label}.reasoning_effort`),
    );
    const fixedTurn = cost["fixed_turn_cost_estimate"];
    if (fixedTurn === null || fixedTurn === undefined) return [];
    if (!isRecordValue(fixedTurn) || !Array.isArray(fixedTurn["projections"])) {
      // A present estimate without projections is the pre-projection schema.
      // Reject it loudly: silently dropping it would show "Cost: unavailable"
      // for a candidate whose cost the caller thinks it supplied.
      throw new Error(
        `${label}.fixed_turn_cost_estimate must carry a projections array`,
      );
    }
    return [
      {
        action,
        cold_start_usd: requiredNumber(fixedTurn["cold_start_usd"], `${label}.fixed_turn_cost_estimate.cold_start_usd`),
        projections: fixedTurn["projections"].map((projection, projectionIndex) => {
          const projectionLabel = `${label}.fixed_turn_cost_estimate.projections[${projectionIndex}]`;
          const record = jsonRecord(projection, projectionLabel);
          return {
            projected_turns: requiredNumber(
              record["projected_turns"],
              `${projectionLabel}.projected_turns`,
            ),
            total_cost_usd: requiredNumber(
              record["total_cost_usd"],
              `${projectionLabel}.total_cost_usd`,
            ),
          };
        }),
      },
    ];
  });
}

function anonymizeLeaseHistory(
  value: unknown,
  byCandidate: ReadonlyMap<string, string>,
): AnonymousLeaseHistoryEntry[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Selector input lease_history must be an array");
  }
  const candidateModels = [...byCandidate.keys()].map((key) => key.split("\u0000", 1)[0]!);
  return value.map((entry, index) => {
    const label = `selector lease_history[${index}]`;
    const history = jsonRecord(entry, label);
    const candidate = jsonRecord(history["candidate"], `${label}.candidate`);
    const lastToolCall = nullableRecord(history["last_tool_call"], `${label}.last_tool_call`);
    const tests = nullableRecord(history["tests"], `${label}.tests`);
    const testStatus = tests?.["status"];
    if (
      tests !== null &&
      testStatus !== "passed" &&
      testStatus !== "failed" &&
      testStatus !== "unknown"
    ) {
      throw new Error(`${label}.tests.status must be passed, failed, or unknown`);
    }
    const requestedTurns = positiveInteger(
      history["requested_turns"],
      `${label}.requested_turns`,
    );
    const completedTurns = nonNegativeInteger(
      history["completed_turns"],
      `${label}.completed_turns`,
    );
    if (completedTurns > requestedTurns) {
      throw new Error(`${label}.completed_turns must not exceed requested_turns`);
    }
    return {
      action: actionForCandidate(
        byCandidate,
        requiredString(candidate["model"], `${label}.candidate.model`),
        requiredString(candidate["thinking_level"], `${label}.candidate.thinking_level`),
      ),
      requested_turns: requestedTurns,
      completed_turns: completedTurns,
      rationale: scrubCandidateNames(
        stringOrEmpty(history["rationale"], `${label}.rationale`),
        candidateModels,
      ) as string,
      last_agent_thought: nullableString(history["last_agent_thought"], `${label}.last_agent_thought`),
      last_tool_call: lastToolCall === null
        ? null
        : {
            name: requiredString(lastToolCall["name"], `${label}.last_tool_call.name`),
            arguments: scrubCandidateNames(
              jsonValue(lastToolCall["arguments"], `${label}.last_tool_call.arguments`),
              candidateModels,
            ),
          },
      last_tool_result: history["last_tool_result"] === null || history["last_tool_result"] === undefined
        ? null
        : scrubCandidateNames(
            jsonValue(history["last_tool_result"], `${label}.last_tool_result`),
            candidateModels,
          ),
      tool_errors: history["tool_errors"] === null || history["tool_errors"] === undefined
        ? null
        : nonNegativeInteger(history["tool_errors"], `${label}.tool_errors`),
      files_changed: history["files_changed"] === null || history["files_changed"] === undefined
        ? null
        : nonNegativeInteger(history["files_changed"], `${label}.files_changed`),
      tests: tests === null
        ? null
        : {
            command: stringOrEmpty(tests["command"], `${label}.tests.command`),
            status: testStatus as "passed" | "failed" | "unknown",
            result: tests["result"] === null || tests["result"] === undefined
              ? null
              : scrubCandidateNames(
                  jsonValue(tests["result"], `${label}.tests.result`),
                  candidateModels,
                ),
          },
    };
  }).map((entry) => ({
    ...entry,
    last_agent_thought: entry.last_agent_thought === null
      ? null
      : scrubCandidateNames(entry.last_agent_thought, candidateModels) as string,
  }));
}

function nullableRecord(
  value: unknown,
  label: string,
): Record<string, JsonValue> | null {
  if (value === null || value === undefined) return null;
  return jsonRecord(value, label);
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return stringOrEmpty(value, label);
}

function stringOrEmpty(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed === 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function scrubCandidateNames(value: JsonValue, candidateModels: readonly string[]): JsonValue {
  if (typeof value === "string") {
    return candidateModels.reduce(
      (scrubbed, model) => scrubbed.split(model).join("anonymous candidate"),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubCandidateNames(item, candidateModels));
  }
  if (isRecordValue(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubCandidateNames(item, candidateModels)]),
    );
  }
  return value;
}

function requiredNumber(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function actionForCandidate(
  byCandidate: ReadonlyMap<string, string>,
  model: string,
  thinkingLevel: string,
): string {
  const action = byCandidate.get(candidateKey(model, thinkingLevel));
  if (action === undefined) {
    throw new Error(`Selector field references unavailable candidate ${model}/${thinkingLevel}`);
  }
  return action;
}

function candidateKey(model: string, thinkingLevel: string): string {
  return `${model}\u0000${thinkingLevel}`;
}
