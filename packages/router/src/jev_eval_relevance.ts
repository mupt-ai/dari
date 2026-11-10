// Jev-decided eval relevance. Instead of the router owner curating which
// benchmark scorecards the selector sees, every candidate card is put to Jev
// as one yes/no (Noul) question — does this benchmark measure the kind of
// work the agent is doing? — all cards in a single System One call, and the
// cards Jev answers yes to become the selector's imported_evals.
//
// Jev is literal, so the question names the exact condition and the criteria
// carry the boundary: a benchmark of the same kind of work (coding, legal,
// visual design, ...) is relevant even when its exact task differs; a
// benchmark of a different kind of work is not, however capable a model
// scoring well on it might be.

import type { JsonValue } from "./json.js";
import { JEV_EVAL_RELEVANCE_PROMPT } from "./prompts.js";
import { invalidJevResponse, postSystemOne, type ResolvedJevConfig } from "./jev_client.js";
import {
  compactRoutingHistory,
  contentText,
  elideMiddle,
  ROUTER_USER_MESSAGE_CHAR_CAP,
} from "./routing_history.js";
import { isRecord, type ChatMessage, type RouterEval } from "./types.js";

// A card is kept when Jev's probability that it is relevant exceeds this.
// Below even odds on purpose: an irrelevant card is noise the selector can
// discount, while a missed card is evidence it never sees.
export const JEV_EVAL_RELEVANCE_THRESHOLD = 0.3;

// Cards per System One call. Jev evaluates every question against the
// state in one pass and its latency grows slowly with question count, but
// each question also counts toward the request's token cap alongside the
// state; probed against the API, 100 cards plus a 64k-char conversation fit
// with room to spare while 400 cards alone did not.
export const JEV_EVAL_RELEVANCE_BATCH_SIZE = 100;
export const JEV_EVAL_RELEVANCE_HISTORY_CHAR_BUDGET = 16_000;

export type JevEvalRelevanceState = {
  task: ChatMessage | null;
  conversation: ChatMessage[];
};

export type JevNoulQuestion = {
  type: "noul";
  instructions: JsonValue;
  criteria: { true: string; false: string };
};

export type JevEvalRelevanceRequest = {
  model: string;
  state: JsonValue;
  questions: Record<string, JevNoulQuestion>;
};

export type JevEvalRelevanceCard = {
  id: string;
  name: string;
  relevance: number;
  kept: boolean;
};

export type JevEvalRelevanceSelection = {
  evals: RouterEval[];
  cards: JevEvalRelevanceCard[];
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  requests: JevEvalRelevanceRequest[];
};


export function buildJevEvalRelevanceRequest(
  cards: readonly RouterEval[],
  state: JevEvalRelevanceState,
  model: string,
): JevEvalRelevanceRequest {
  const questions: Record<string, JevNoulQuestion> = {};
  for (const card of cards) {
    questions[card.id] = {
      type: "noul",
      instructions: {
        question: JEV_EVAL_RELEVANCE_PROMPT.question,
        benchmark: {
          name: card.name,
          ...(card.description ? { description: card.description } : {}),
        },
        rules: JEV_EVAL_RELEVANCE_PROMPT.rules,
      },
      criteria: JEV_EVAL_RELEVANCE_PROMPT.criteria,
    };
  }
  return {
    model,
    state: {
      task: state.task as unknown as JsonValue,
      conversation: state.conversation as unknown as JsonValue,
    },
    questions,
  };
}

// Maps a System One body back onto the cards it was asked about. Every card
// must be answered; a missing or non-Noul answer is a malformed response.
export function parseJevEvalRelevanceResponse(
  body: unknown,
  cards: readonly RouterEval[],
): {
  cards: JevEvalRelevanceCard[];
  model: string;
  usage: { input_tokens: number; output_tokens: number };
} {
  if (!isRecord(body) || typeof body.model !== "string" || !isRecord(body.answers)) {
    throw invalidJevResponse("Jev returned an unrecognized eval relevance response body.");
  }
  const usage = body.usage;
  if (
    !isRecord(usage)
    || typeof usage.input_tokens !== "number"
    || typeof usage.output_tokens !== "number"
  ) {
    throw invalidJevResponse("Jev eval relevance response is missing token usage.");
  }
  const answers = body.answers;
  const scored = cards.map((card): JevEvalRelevanceCard => {
    const answer = answers[card.id];
    if (
      !isRecord(answer)
      || answer.type !== "noul"
      || typeof answer.noul !== "number"
      || !Number.isFinite(answer.noul)
      || answer.noul < 0
      || answer.noul > 1
    ) {
      throw invalidJevResponse(`Jev eval relevance response has an invalid noul answer for ${card.id}.`);
    }
    return {
      id: card.id,
      name: card.name,
      relevance: answer.noul,
      kept: answer.noul > JEV_EVAL_RELEVANCE_THRESHOLD,
    };
  });
  return {
    cards: scored,
    model: body.model,
    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
  };
}

// Asks Jev about every card (batched, batches in parallel) and returns the
// kept cards in their original order plus the per-card probabilities.
export async function selectRelevantEvals(
  cards: readonly RouterEval[],
  state: JevEvalRelevanceState,
  config: ResolvedJevConfig,
  signal?: AbortSignal,
): Promise<JevEvalRelevanceSelection> {
  const unique = dedupeById(cards);
  if (unique.length === 0) {
    return {
      evals: [],
      cards: [],
      model: config.model,
      usage: { input_tokens: 0, output_tokens: 0 },
      requests: [],
    };
  }
  const batches: RouterEval[][] = [];
  for (let start = 0; start < unique.length; start += JEV_EVAL_RELEVANCE_BATCH_SIZE) {
    batches.push(unique.slice(start, start + JEV_EVAL_RELEVANCE_BATCH_SIZE));
  }
  // History compaction leaves a lone message and the leading instructions
  // verbatim, so every message is also capped: one large paste must not push
  // the request past Jev's token limit.
  const boundedState = {
    task: state.task === null ? null : boundedMessage(state.task, ROUTER_USER_MESSAGE_CHAR_CAP),
    conversation: compactRoutingHistory(
      state.conversation,
      JEV_EVAL_RELEVANCE_HISTORY_CHAR_BUDGET,
    ).map((message) => boundedMessage(message, JEV_EVAL_RELEVANCE_HISTORY_CHAR_BUDGET)),
  };
  const requests = batches.map((batch) => buildJevEvalRelevanceRequest(batch, boundedState, config.model));
  const parsed = await Promise.all(
    requests.map(async (request, index) =>
      parseJevEvalRelevanceResponse(await postSystemOne(request, config, signal), batches[index]!),
    ),
  );
  const scored = parsed.flatMap((result) => result.cards);
  const kept = new Set(scored.filter((card) => card.kept).map((card) => card.id));
  return {
    evals: unique.filter((card) => kept.has(card.id)),
    cards: scored,
    model: parsed[0]!.model,
    usage: parsed.reduce(
      (total, result) => ({
        input_tokens: total.input_tokens + result.usage.input_tokens,
        output_tokens: total.output_tokens + result.usage.output_tokens,
      }),
      { input_tokens: 0, output_tokens: 0 },
    ),
    requests,
  };
}

// Jev only needs the words, so an oversized message becomes its text with the
// middle of each long part elided, shrinking until the JSON (escapes
// included) fits.
function boundedMessage(message: ChatMessage, maxChars: number): ChatMessage {
  if (JSON.stringify(message).length <= maxChars) return message;
  const parts = typeof message.content === "string"
    ? [message.content]
    : Array.isArray(message.content)
      ? message.content.map((part) => contentText([part])).filter((text) => text !== "")
      : [];
  for (let keepChars = maxChars; ; keepChars = Math.floor(keepChars * 0.75)) {
    const bounded = { role: message.role, content: elideParts(parts, keepChars) };
    if (keepChars === 0 || JSON.stringify(bounded).length <= maxChars) return bounded;
  }
}

// Shares the budget across text parts so a short ask between long harness
// parts (reminders, environment dumps) survives: parts within an even share
// stay whole and the longer parts split what remains.
function elideParts(parts: readonly string[], maxChars: number): string {
  const limits = new Array<number>(parts.length).fill(0);
  let remaining = Math.max(0, maxChars - (parts.length - 1));
  const bySize = parts.map((_, index) => index).sort((left, right) =>
    parts[left]!.length - parts[right]!.length
  );
  for (let open = 0; open < bySize.length; open += 1) {
    const share = Math.floor(remaining / (bySize.length - open));
    const index = bySize[open]!;
    if (parts[index]!.length > share) {
      for (const rest of bySize.slice(open)) limits[rest] = share;
      break;
    }
    limits[index] = parts[index]!.length;
    remaining -= parts[index]!.length;
  }
  return parts.map((part, index) => elideMiddle(part, limits[index]!)).join("\n");
}

// The candidate pool is the router's own cards plus the public catalog; a
// card the router imported from the catalog appears in both, and the first
// occurrence (the router's copy) wins.
function dedupeById(cards: readonly RouterEval[]): RouterEval[] {
  const seen = new Set<string>();
  return cards.filter((card) => {
    if (seen.has(card.id)) return false;
    seen.add(card.id);
    return true;
  });
}
