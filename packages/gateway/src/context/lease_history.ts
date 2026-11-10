import {
  isReasoningEffort,
  isRecord,
  routingCandidateKey,
  type ChatMessage,
  type JsonValue,
  type RouterPrefixHit,
  type RoutingCandidate,
  type SelectorLeaseHistoryEntry,
} from "@mupt-ai/dari-router/policy-engine";

const MAX_HISTORY_LEASES = 3;
const MAX_OBSERVATION_CHARS = 3_000;
const TEST_COMMAND = /(?:^|\s)(?:bun|npm|pnpm|yarn|uv|pytest|cargo|go|make|npx|bash)\b[^\n]*(?:test|check|lint|typecheck|vet|build)/i;

type LeaseSegment = {
  candidate: RoutingCandidate;
  requestedTurns: number;
  lastRemaining: number;
  rationale: string;
};

type ConversationTurn = {
  assistant: ChatMessage;
  toolResults: ChatMessage[];
};

export function leaseHistoryFromPrefixHits(args: {
  prefixHits: readonly RouterPrefixHit[];
  conversationId: string;
  candidates: readonly RoutingCandidate[];
  messages: readonly ChatMessage[];
}): SelectorLeaseHistoryEntry[] {
  const candidateKeys = new Set(args.candidates.map(routingCandidateKey));
  const hits = deduplicatedHits(args.prefixHits)
    .filter((hit) => hit.conversation_id === args.conversationId)
    .sort((left, right) => left.message_depth - right.message_depth);
  const segments: LeaseSegment[] = [];
  for (const hit of hits) {
    const remaining = hit.lease_turns_remaining;
    const effort = hit.next_reasoning_effort;
    if (
      typeof remaining !== "number" ||
      !Number.isInteger(remaining) ||
      remaining < 0 ||
      !hit.next_model ||
      !isReasoningEffort(effort)
    ) {
      continue;
    }
    const candidate = { model: hit.next_model, reasoningEffort: effort };
    if (!candidateKeys.has(routingCandidateKey(candidate))) continue;
    const current = segments.at(-1);
    if (
      current !== undefined &&
      routingCandidateKey(current.candidate) === routingCandidateKey(candidate) &&
      remaining < current.lastRemaining
    ) {
      current.lastRemaining = remaining;
      continue;
    }
    segments.push({
      candidate,
      requestedTurns: remaining + 1,
      lastRemaining: remaining,
      rationale: hit.reason ?? "",
    });
  }

  const recent = segments.slice(-MAX_HISTORY_LEASES);
  const turns = conversationTurns(args.messages);
  let turnCursor = turns.length;
  const history = [...recent].reverse().map((segment) => {
    const completedTurns = Math.max(
      0,
      Math.min(segment.requestedTurns, segment.requestedTurns - segment.lastRemaining),
    );
    const start = Math.max(0, turnCursor - completedTurns);
    const observation = turns.slice(start, turnCursor);
    turnCursor = start;
    return observationForSegment(segment, completedTurns, observation);
  });
  return history.reverse();
}

function observationForSegment(
  segment: LeaseSegment,
  completedTurns: number,
  turns: readonly ConversationTurn[],
): SelectorLeaseHistoryEntry {
  const calls = turns.flatMap((turn) => turn.assistant.tool_calls ?? []);
  const results = turns.flatMap((turn) => turn.toolResults);
  const lastCall = calls.at(-1);
  const callId = typeof lastCall?.["id"] === "string" ? lastCall["id"] : null;
  const lastResult = callId === null
    ? undefined
    : [...results].reverse().find((result) => result.tool_call_id === callId);
  const testCall = [...calls].reverse().find((call) => {
    const parsed = toolCall(call);
    return parsed?.name === "bash" && TEST_COMMAND.test(command(parsed.arguments));
  });
  const parsedLastCall = lastCall === undefined ? null : toolCall(lastCall);
  const parsedTestCall = testCall === undefined ? null : toolCall(testCall);
  const testCallId = typeof testCall?.["id"] === "string" ? testCall["id"] : null;
  const testResult = testCallId === null
    ? undefined
    : [...results].reverse().find((result) => result.tool_call_id === testCallId);
  const lastAssistant = turns.at(-1)?.assistant;
  const thought = lastAssistant?.reasoning_content
    ?? lastAssistant?.reasoning_text
    ?? lastAssistant?.reasoning
    ?? null;
  return {
    candidate: {
      model: segment.candidate.model,
      thinking_level: segment.candidate.reasoningEffort,
    },
    requested_turns: segment.requestedTurns,
    completed_turns: completedTurns,
    rationale: truncate(segment.rationale),
    last_agent_thought: thought === null ? null : truncate(thought),
    last_tool_call: parsedLastCall === null
      ? null
      : { name: parsedLastCall.name, arguments: compactJson(parsedLastCall.arguments) },
    last_tool_result: lastResult === undefined ? null : compactJson(lastResult.content ?? null),
    // Generic Chat Completions tool results do not carry a portable error bit
    // or a trustworthy changed-file count.
    tool_errors: null,
    files_changed: null,
    tests: parsedTestCall === null
      ? null
      : {
          command: truncate(command(parsedTestCall.arguments)),
          status: "unknown",
          result: testResult === undefined ? null : compactJson(testResult.content ?? null),
        },
  };
}

function deduplicatedHits(hits: readonly RouterPrefixHit[]): RouterPrefixHit[] {
  const byState = new Map<string, RouterPrefixHit>();
  for (const hit of hits) {
    const key = [
      hit.conversation_id,
      hit.message_depth,
      hit.next_model ?? "",
      hit.next_reasoning_effort ?? "",
      hit.lease_turns_remaining ?? "",
    ].join("\u0000");
    const existing = byState.get(key);
    if (existing === undefined || existing.updated_at < hit.updated_at) byState.set(key, hit);
  }
  return [...byState.values()];
}

function conversationTurns(messages: readonly ChatMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let current: ConversationTurn | undefined;
  for (const message of messages) {
    if (message.role === "assistant") {
      current = { assistant: message, toolResults: [] };
      turns.push(current);
    } else if (message.role === "tool" && current !== undefined) {
      current.toolResults.push(message);
    }
  }
  return turns;
}

function toolCall(value: Record<string, unknown>): { name: string; arguments: JsonValue } | null {
  const fn = value["function"];
  if (!isRecord(fn) || typeof fn.name !== "string") return null;
  const rawArguments = fn.arguments ?? {};
  if (typeof rawArguments !== "string") {
    return { name: fn.name, arguments: compactJson(rawArguments) };
  }
  try {
    return { name: fn.name, arguments: JSON.parse(rawArguments) as JsonValue };
  } catch {
    return { name: fn.name, arguments: rawArguments };
  }
}

function command(value: JsonValue): string {
  return isRecord(value) && typeof value.command === "string" ? value.command : "";
}

function compactJson(value: unknown): JsonValue {
  const serialized = JSON.stringify(value) ?? "null";
  if (serialized.length <= MAX_OBSERVATION_CHARS) {
    return JSON.parse(serialized) as JsonValue;
  }
  return `${serialized.slice(0, MAX_OBSERVATION_CHARS)}…`;
}

function truncate(value: string): string {
  return value.length <= MAX_OBSERVATION_CHARS
    ? value
    : `${value.slice(0, MAX_OBSERVATION_CHARS)}…`;
}
