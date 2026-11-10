// Inverse codec for the selector-request wire format buildSelectorRequest
// produces: the selector input travels as a JSON-stringified user message
// inside a chat-completion request.

import {
  anonymizeSelectorInput,
  assignAnonymousActions,
  type Rng,
} from "./anonymous_actions.js";
import { RouterFrameworkError } from "./framework_error.js";
import type { JsonObject } from "./json.js";
import type { SelectorInput } from "./selector_input.js";
import {
  isReasoningEffort,
  isRecord,
  routingCandidateKey,
  type PreviousDecision,
  type RoutingCandidate,
} from "./types.js";

export type DecodedSelectorRequest = {
  candidates: RoutingCandidate[];
  previousDecision?: PreviousDecision;
  selectorInput: SelectorInput;
};

// Decodes an untrusted POSTed selector request body; throws kind
// "invalid_request" on malformed input.
export function decodeUntrustedSelectorRequest(payload: unknown): DecodedSelectorRequest {
  const selectorInput = parseSelectorInput(payload);
  const candidates: RoutingCandidate[] = [];
  const seenPairs = new Set<string>();
  for (const [index, pair] of (selectorInput.candidate_pairs as unknown[]).entries()) {
    const param = `candidate_pairs[${index}]`;
    if (!isRecord(pair)) {
      throw invalidSelectorRequest("Selector candidate must be an object.", param);
    }
    const candidate = parseCandidatePair(pair, "candidate", param);
    const key = routingCandidateKey(candidate);
    if (seenPairs.has(key)) {
      throw invalidSelectorRequest(
        `Selector input contains duplicate candidate ${candidate.model}/${candidate.reasoningEffort}.`,
        param,
      );
    }
    seenPairs.add(key);
    candidates.push(candidate);
  }
  const previousDecision = parsePreviousDecision(selectorInput.previous_decision);
  if (candidates.length === 0) {
    throw invalidSelectorRequest("Selector request contains no candidates.");
  }
  return { candidates, ...(previousDecision !== undefined ? { previousDecision } : {}), selectorInput };
}

// anonymizeSelectorInput's validators throw plain Errors; dry-run it here so
// malformed input surfaces as invalid_request instead of an internal error.
export function assertAnonymizableSelectorInput(
  selectorInput: SelectorInput,
  candidates: RoutingCandidate[],
  rng: Rng = Math.random,
): void {
  if (candidates.length < 2) return;
  try {
    anonymizeSelectorInput(
      selectorInput as unknown as JsonObject,
      assignAnonymousActions(candidates, rng),
    );
  } catch (error) {
    throw invalidSelectorRequest(
      `Selector input is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parsePreviousDecision(value: unknown): PreviousDecision | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value)) {
    throw invalidSelectorRequest(
      "Selector previous_decision must be an object or null.",
      "previous_decision",
    );
  }
  const candidate = parseCandidatePair(value, "previous_decision", "previous_decision");
  if (typeof value.reason !== "string") {
    throw invalidSelectorRequest(
      "Selector previous_decision reason must be a string.",
      "previous_decision.reason",
    );
  }
  return { ...candidate, reason: value.reason };
}

function parseCandidatePair(
  value: Record<string, unknown>,
  subject: "candidate" | "previous_decision",
  param: string,
): RoutingCandidate {
  if (typeof value.model !== "string" || value.model === "") {
    throw invalidSelectorRequest(`Selector ${subject} is missing a model name.`, `${param}.model`);
  }
  if (!isReasoningEffort(value.thinking_level)) {
    throw invalidSelectorRequest(
      `Selector ${subject} has invalid thinking_level: ${String(value.thinking_level)}`,
      `${param}.thinking_level`,
    );
  }
  return { model: value.model, reasoningEffort: value.thinking_level };
}

function parseSelectorInput(payload: unknown): SelectorInput {
  if (!isRecord(payload)) {
    throw invalidSelectorRequest("Selector request must be a JSON object.");
  }
  const messages: unknown = payload.messages ?? [];
  if (!Array.isArray(messages)) {
    throw invalidSelectorRequest("Selector request messages must be an array.", "messages");
  }
  const userMessage = messages.find(
    (message): message is Record<string, unknown> => isRecord(message) && message.role === "user",
  );
  if (userMessage === undefined) {
    throw invalidSelectorRequest("Selector request is missing the user message.");
  }
  const content = userMessage.content;
  if (typeof content !== "string") {
    throw invalidSelectorRequest("Selector request user message content must be a string.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw invalidSelectorRequest("Selector request user message is not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw invalidSelectorRequest("Selector request user message is not a JSON object.");
  }
  if (!Array.isArray(parsed.candidate_pairs)) {
    throw invalidSelectorRequest("Selector input is missing candidate_pairs.");
  }
  // Anonymization would silently drop custom rules rather than apply them.
  if ("custom_rules" in parsed || "default_target" in parsed) {
    throw new RouterFrameworkError(
      "invalid_request",
      "The Dari Auto Router serves only the default routing policy and cannot apply " +
        "custom routing rules. Self-host the selector or use the Dari managed platform " +
        "for custom routing.",
      "custom_rules_not_supported",
    );
  }
  if (!Array.isArray(parsed.messages)) {
    throw invalidSelectorRequest("Selector input messages must be an array.", "messages");
  }
  for (const [index, message] of (parsed.messages as unknown[]).entries()) {
    if (!isRecord(message) || typeof message.role !== "string") {
      throw invalidSelectorRequest(
        "Selector input messages must be objects with a string role.",
        `messages[${index}]`,
      );
    }
  }
  return parsed as unknown as SelectorInput;
}

function invalidSelectorRequest(message: string, param?: string): RouterFrameworkError {
  return new RouterFrameworkError("invalid_request", message, "invalid_request_error", param);
}
