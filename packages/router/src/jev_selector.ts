// TypeSafe Jev as a routing selector over the anonymous-action protocol.
// Jev answers two Choice questions about the de-identified selector input —
// which anonymous candidate action serves the next turns, and how long a
// lease to commit to — and the answers come back as calibrated
// probabilities rather than parsed JSON. The hosted router uses it as the
// fallback when Dari's policy endpoint is unavailable.
//
// Candidates are de-identified through the same anonymous-action protocol
// Dari uses (anonymous_actions.ts), so Jev decides on benchmark and cost
// evidence and never sees a model identity; comparisons Jev is weak at (cost
// ordering, benchmark standing) are computed here and passed as text.

import {
  anonymizeSelectorInput,
  type AnonymousActionCost,
  type AnonymousActionSlot,
  type AnonymousSelectorInput,
} from "./anonymous_actions.js";
import { FIXED_TURN_COST_COMPARISON_TURNS } from "./fixed_turn_cost_config.js";
import {
  invalidJevResponse,
  JevOutputError,
  postSystemOne,
  type JevTokenUsage,
  type ResolvedJevConfig,
} from "./jev_client.js";
import type { JsonObject, JsonValue } from "./json.js";
import { fillPrompt, JEV_SELECTOR_PROMPT } from "./prompts.js";
import type { CustomSelectorInput, SelectorInput } from "./selector_input.js";
import { isRecord, type RoutingDecision } from "./types.js";

// Jev evaluates up to 32k tokens of state plus the longest question, and
// JSON-shaped conversation state tokenizes at roughly 2.7 characters per
// token. The selector request is sized on its JSON-escaped messages, which
// overstate the state Jev receives, so this budget leaves room for the
// questions and the action descriptions.
export const JEV_SELECTOR_CONTEXT_WINDOW_CHARS = 64_000;

export type JevSelectorConfig = ResolvedJevConfig & {
  // Turn commitments offered as the lease question. Empty routes one turn at
  // a time without asking.
  leaseTurns: readonly number[];
};

export type JevChoiceQuestion = {
  type: "choice";
  instructions: JsonValue;
  criteria: Record<string, JsonValue>;
};

export type JevSystemOneRequest = {
  model: string;
  state: JsonValue;
  questions: {
    action: JevChoiceQuestion;
    lease?: JevChoiceQuestion;
  };
};

export type JevChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

export type JevSystemOneResponse = {
  model: string;
  answers: {
    action: JevChoiceAnswer;
    lease?: JevChoiceAnswer;
  };
  usage: JevTokenUsage;
};

export type JevSelection = {
  decision: RoutingDecision;
  request: JevSystemOneRequest;
  response: JevSystemOneResponse;
};

// Renders the de-identified selector input as a Jev request. Every candidate
// identity has already been replaced by its action letter; the only evidence
// an action carries is its projected cost and its benchmark standing.
export function buildJevSelectorRequest(
  anonymousInput: AnonymousSelectorInput,
  options: { model: string; leaseTurns: readonly number[] },
): JevSystemOneRequest {
  const costs = actionCosts(anonymousInput.cost_estimates);
  const criteria: Record<string, JsonValue> = {};
  for (const { action } of anonymousInput.candidate_actions) {
    const cost = costs.get(action);
    const benchmarks: Record<string, JsonValue> = {};
    for (const card of anonymousInput.imported_evals) {
      const score = card.scores.find((entry) => entry.action === action);
      if (score === undefined) continue;
      benchmarks[card.name] = {
        score: score.score,
        rank: `${score.rank} of ${score.rank_total}`,
      };
    }
    criteria[action] = cost === undefined && Object.keys(benchmarks).length === 0
      ? null
      : {
          ...(cost === undefined ? {} : { cost }),
          ...(Object.keys(benchmarks).length === 0 ? {} : { benchmarks }),
        };
  }

  const state: Record<string, JsonValue> = {
    previous_action: anonymousInput.previous_action === null
      ? null
      : anonymousInput.previous_action.action,
    lease_history: anonymousInput.lease_history as unknown as JsonValue,
    conversation: anonymousInput.messages,
  };

  const glossary: Record<string, JsonValue> = {};
  for (const card of anonymousInput.imported_evals) {
    glossary[card.name] = {
      ...(card.description === null ? {} : { description: card.description }),
      scale: `${card.min_score} to ${card.max_score}, higher is better`,
    };
  }

  const questions: JevSystemOneRequest["questions"] = {
    action: {
      type: "choice",
      instructions: {
        question: JEV_SELECTOR_PROMPT.action.question,
        rules: anonymousInput.router_rules === undefined
          ? JEV_SELECTOR_PROMPT.action.rules
          : [...JEV_SELECTOR_PROMPT.action.rules, JEV_SELECTOR_PROMPT.action.router_rules_rule],
        ...(Object.keys(glossary).length === 0 ? {} : { benchmarks: glossary }),
        ...(anonymousInput.router_rules === undefined
          ? {}
          : { router_rules: anonymousInput.router_rules as unknown as JsonValue }),
      },
      criteria,
    },
    ...(options.leaseTurns.length === 0 ? {} : { lease: leaseQuestion(options.leaseTurns) }),
  };
  return { model: options.model, state, questions };
}

function leaseQuestion(leaseTurns: readonly number[]): JevChoiceQuestion {
  const { question, guidance, criteria: templates } = JEV_SELECTOR_PROMPT.lease;
  const last = leaseTurns.length - 1;
  const criteria: Record<string, JsonValue> = {};
  leaseTurns.forEach((turns, index) => {
    const template = index === 0
      ? templates.shortest
      : index === last
        ? templates.longest
        : templates.middle;
    criteria[String(turns)] = fillPrompt(template, { turns: String(turns) });
  });
  return { type: "choice", instructions: { question, guidance }, criteria };
}

export function parseJevSelectorResponse(
  body: unknown,
  args: { slots: readonly AnonymousActionSlot[]; leaseTurns: readonly number[] },
): { decision: RoutingDecision; response: JevSystemOneResponse } {
  if (!isRecord(body) || typeof body.model !== "string" || !isRecord(body.answers)) {
    throw invalidResponse("Jev returned an unrecognized response body.");
  }
  const usage = body.usage;
  if (
    !isRecord(usage)
    || typeof usage.input_tokens !== "number"
    || typeof usage.output_tokens !== "number"
  ) {
    throw invalidResponse("Jev response is missing token usage.");
  }
  const tokenUsage: JevTokenUsage = {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
  };
  const action = choiceAnswer(body.answers.action, "action", tokenUsage);
  const slot = args.slots.find((entry) => entry.action === action.choice);
  if (slot === undefined) {
    throw new JevOutputError(
      "Jev selected an action outside this router's candidates.",
      "selector_invalid_candidate",
      tokenUsage,
    );
  }
  let lease: JevChoiceAnswer | undefined;
  let turns: number | undefined;
  if (args.leaseTurns.length > 0) {
    lease = choiceAnswer(body.answers.lease, "lease", tokenUsage);
    turns = Number(lease.choice);
    if (!args.leaseTurns.includes(turns)) {
      throw invalidResponse(
        `Jev lease answer ${lease.choice} is not on the offered menu.`,
        tokenUsage,
      );
    }
  }
  const response: JevSystemOneResponse = {
    model: body.model,
    answers: { action, ...(lease === undefined ? {} : { lease }) },
    usage: tokenUsage,
  };
  return {
    decision: {
      selectedModel: slot.candidate.model,
      reasoningEffort: slot.candidate.reasoningEffort as RoutingDecision["reasoningEffort"],
      // The reason is persisted into lease history and replayed to later
      // selectors, so it stays anonymous like the rest of the protocol.
      reason: decisionReason(action, turns, lease),
      ...(turns === undefined ? {} : { leaseTurnsRemaining: turns - 1 }),
    },
    response,
  };
}

function decisionReason(
  action: JevChoiceAnswer,
  turns: number | undefined,
  lease: JevChoiceAnswer | undefined,
): string {
  const pick = `Jev selected Action ${action.choice} `
    + `(probability ${percent(action.probabilities[action.choice] ?? 0)}, confidence ${percent(action.confidence)})`;
  if (turns === undefined || lease === undefined) return `${pick}.`;
  return `${pick} with a ${turns}-turn lease (probability ${percent(lease.probabilities[lease.choice] ?? 0)}).`;
}

// Anonymizes the named selector input against the slots, asks Jev, and maps
// the answers back onto the slots' candidates.
export async function selectWithJev(
  selectorInput: SelectorInput | CustomSelectorInput,
  slots: readonly AnonymousActionSlot[],
  config: JevSelectorConfig,
  signal?: AbortSignal,
): Promise<JevSelection> {
  const anonymousInput = anonymizeSelectorInput(selectorInput as unknown as JsonObject, slots);
  const request = buildJevSelectorRequest(anonymousInput, config);
  const body = await postSystemOne(request, config, signal);
  const { decision, response } = parseJevSelectorResponse(body, {
    slots,
    leaseTurns: config.leaseTurns,
  });
  return { decision, request, response };
}

// A Selector for createDariRoutingPolicy: decodes the selector input from the
// chat-shaped request and returns a routing_decision JSON the parser already
// understands, including lease_turns_remaining and the raw Jev answers.
// Letters are assigned per call: the framework path carries no conversation
// identity, and every candidate-bearing field is re-lettered together, so
// correctness never depends on cross-turn stability.


// Cost per action as text Jev can compare literally: the loop projections at
// each lease length, plus a rank across actions on the comparison horizon.
function actionCosts(costs: readonly AnonymousActionCost[]): Map<string, JsonValue> {
  const scalars = new Map<string, number>();
  const rendered = new Map<string, Record<string, JsonValue>>();
  for (const cost of costs) {
    if (cost.projections.length === 0) continue;
    const comparison = cost.projections.find(
      (projection) => projection.projected_turns === FIXED_TURN_COST_COMPARISON_TURNS,
    ) ?? cost.projections[cost.projections.length - 1]!;
    scalars.set(cost.action, comparison.total_cost_usd);
    rendered.set(cost.action, {
      projected_loop_cost: Object.fromEntries(
        cost.projections.map((projection) => [
          `${projection.projected_turns} turns`,
          usd(projection.total_cost_usd),
        ]),
      ),
    });
  }
  const ranked = [...scalars.entries()].sort((left, right) => left[1] - right[1]);
  ranked.forEach(([, value], index) => {
    // Competition ranking: tied costs share the better rank.
    const rank = ranked.findIndex(([, other]) => other === value) + 1;
    const suffix = ranked.length === 1
      ? ""
      : rank === 1
        ? " (cheapest)"
        : index === ranked.length - 1 && rank === ranked.length
          ? " (most expensive)"
          : "";
    const action = ranked[index]![0];
    rendered.get(action)!.rank = `${rank} of ${ranked.length}${suffix}`;
  });
  return rendered;
}

function choiceAnswer(
  value: unknown,
  name: string,
  usage: JevTokenUsage,
): JevChoiceAnswer {
  if (
    !isRecord(value)
    || value.type !== "choice"
    || typeof value.choice !== "string"
    || typeof value.confidence !== "number"
    || !isRecord(value.probabilities)
  ) {
    throw invalidResponse(`Jev response is missing a choice answer for ${name}.`, usage);
  }
  const probabilities: Record<string, number> = {};
  for (const [label, probability] of Object.entries(value.probabilities)) {
    if (typeof probability === "number") probabilities[label] = probability;
  }
  return {
    type: "choice",
    choice: value.choice,
    confidence: value.confidence,
    probabilities,
  };
}

function usd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  const trimmed = value.toPrecision(3).replace(/0+$/, "").replace(/\.$/, "");
  return `$${trimmed}`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}


const invalidResponse = invalidJevResponse;
