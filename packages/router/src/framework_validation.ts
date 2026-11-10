import { RouterFrameworkError } from "./framework_error.js";
import {
  completionContract,
  streamContract,
} from "./framework_lifecycle.js";
import { isReasoningEffort } from "./types.js";
import type {
  RouterCandidate,
  RouterCompletion,
  RouterFinishReason,
  RouterSelection,
  RouterStreamEvent,
  RoutingPolicyDecision,
} from "./framework_types.js";

export function validateStreamSequence(
  event: Exclude<RouterStreamEvent, { type: "finish" }>,
  openIndexes: Map<number, "text" | "tool" | "reasoning">,
): void {
  const current = openIndexes.get(event.index);
  if (event.type === "text_delta") {
    if (current === "tool" || current === "reasoning") throw streamContract(`Stream index ${event.index} is already a ${current} block.`);
    if (current === undefined) openIndexes.set(event.index, "text");
    return;
  }
  if (event.type === "reasoning_delta") {
    if (current === "tool" || current === "text") throw streamContract(`Stream index ${event.index} is already a ${current} block.`);
    if (current === undefined) openIndexes.set(event.index, "reasoning");
    return;
  }
  if (event.type === "reasoning_end") {
    if (current === "text" || current === "tool") throw streamContract(`Stream index ${event.index} is already a ${current} block.`);
    if (current === "reasoning") openIndexes.delete(event.index);
    // If current is undefined, reasoning_end opens and immediately closes a
    // reasoning block (empty or redacted thinking with no prior delta).
    return;
  }
  if (event.type === "tool_call_start") {
    if (current !== undefined) throw streamContract(`Stream index ${event.index} is already in use.`);
    openIndexes.set(event.index, "tool");
    return;
  }
  if (event.type === "hosted_tool_call") {
    // Hosted tool calls arrive complete: the event opens and closes its
    // block, so the index only needs to be unused.
    if (current !== undefined) throw streamContract(`Stream index ${event.index} is already in use.`);
    return;
  }
  if (current !== "tool") {
    throw streamContract(`Stream index ${event.index} has no open tool call.`);
  }
  if (event.type === "tool_call_end") openIndexes.delete(event.index);
}

export function validateStreamEvent(event: RouterStreamEvent): void {
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    throw streamContract("Executor emitted an invalid stream event.");
  }
  if (event.type === "finish") {
    validateFinishReason(event.finishReason);
    if (event.usage !== undefined) validateUsage(event.usage);
    return;
  }
  if (!Number.isSafeInteger(event.index) || event.index < 0) {
    throw streamContract("Executor stream event index must be a non-negative integer.");
  }
  if (event.type === "text_delta" || event.type === "tool_call_delta" || event.type === "reasoning_delta") {
    if (typeof event.delta !== "string" || event.delta.length === 0) {
      throw streamContract("Executor stream deltas must be non-empty strings.");
    }
    return;
  }
  if (event.type === "tool_call_start") {
    if (
      typeof event.id !== "string" || !event.id.trim() ||
      typeof event.name !== "string" || !event.name.trim()
    ) {
      throw streamContract("Executor tool-call starts require non-empty id and name.");
    }
    return;
  }
  if (event.type === "hosted_tool_call") {
    if (
      typeof event.id !== "string" || event.id.length === 0 ||
      event.tool !== "web_search" ||
      event.providerType !== "web_search_call" ||
      typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)
    ) {
      throw streamContract("Executor hosted tool calls require id, tool, providerType, and payload.");
    }
    return;
  }
  if (event.type !== "tool_call_end" && event.type !== "reasoning_end") {
    throw streamContract(`Executor emitted unsupported stream event '${String((event as { type: unknown }).type)}'.`);
  }
}

export function validateCompletion(output: RouterCompletion): void {
  if (!output || typeof output !== "object" || !Array.isArray(output.content)) {
    throw new RouterFrameworkError(
      "executor",
      "Executor returned an invalid completion.",
      "executor_output_invalid",
    );
  }
  validateFinishReason(output.finishReason, completionContract);
  if (output.usage !== undefined) validateUsage(output.usage, completionContract);
  for (const item of output.content) {
    if (
      item && typeof item === "object" && (
        (item.type === "text" && typeof item.text === "string") ||
        (
          item.type === "reasoning" &&
          typeof item.text === "string" &&
          (item.redacted === undefined || typeof item.redacted === "boolean") &&
          (item.source === undefined || (
            typeof item.source.provider === "string" &&
            typeof item.source.api === "string" &&
            typeof item.source.model === "string"
          )) &&
          (item.continuation === undefined || (
            typeof item.continuation === "object" && item.continuation !== null
          ))
        ) ||
        (
          item.type === "tool_call" &&
          typeof item.id === "string" && item.id.length > 0 &&
          typeof item.name === "string" && item.name.length > 0 &&
          (typeof item.arguments === "string" || (
            typeof item.arguments === "object" && item.arguments !== null && !Array.isArray(item.arguments)
          ))
        ) ||
        (
          item.type === "hosted_tool_call" &&
          typeof item.id === "string" && item.id.length > 0 &&
          item.tool === "web_search" &&
          item.providerType === "web_search_call" &&
          typeof item.payload === "object" && item.payload !== null && !Array.isArray(item.payload)
        )
      )
    ) continue;
    throw new RouterFrameworkError(
      "executor",
      "Executor returned an invalid completion content item.",
      "executor_output_invalid",
    );
  }
}

function validateFinishReason(
  value: unknown,
  contractError: (message: string) => RouterFrameworkError = streamContract,
): asserts value is RouterFinishReason {
  if (value !== "stop" && value !== "length" && value !== "tool_calls") {
    throw contractError("Executor returned an invalid finish reason.");
  }
}

function validateUsage(
  usage: NonNullable<RouterCompletion["usage"]>,
  contractError: (message: string) => RouterFrameworkError = streamContract,
): void {
  if (!usage || typeof usage !== "object") {
    throw contractError("Executor usage must be an object.");
  }
  for (const [name, value, required] of [
    ["inputTokens", usage.inputTokens, true],
    ["outputTokens", usage.outputTokens, true],
    ["cacheReadTokens", usage.cacheReadTokens, false],
    ["cacheWriteTokens", usage.cacheWriteTokens, false],
    ["totalTokens", usage.totalTokens, false],
  ] as const) {
    if ((required && value === undefined) || (
      value !== undefined && (!Number.isSafeInteger(value) || value < 0)
    )) {
      throw contractError(
        `Executor usage ${name} must be ${required ? "a" : "an optional"} non-negative integer.`,
      );
    }
  }
}

export function validatePolicyDecision<Metadata>(
  value: RoutingPolicyDecision,
  candidates: readonly RouterCandidate<Metadata>[],
): RouterSelection<Metadata> {
  if (!value || typeof value !== "object" || typeof value.model !== "string") {
    throw new RouterFrameworkError(
      "policy",
      "Routing policy returned an invalid decision.",
      "policy_invalid_decision",
    );
  }
  const candidate = candidates.find((item) => item.id === value.model);
  if (candidate === undefined) {
    throw new RouterFrameworkError(
      "policy",
      `Routing policy selected unconfigured or ineligible model '${value.model}'.`,
      "policy_invalid_model",
    );
  }
  const reasoningEffort = value.reasoningEffort ?? candidate.defaultReasoningEffort;
  if (!isReasoningEffort(reasoningEffort) || !candidate.reasoningEfforts.includes(reasoningEffort)) {
    throw new RouterFrameworkError(
      "policy",
      `Routing policy selected unsupported reasoning effort '${String(reasoningEffort)}' for '${candidate.id}'.`,
      "policy_invalid_reasoning_effort",
    );
  }
  const reason = typeof value.reason === "string" && value.reason.trim()
    ? value.reason.trim()
    : `Routing policy selected ${candidate.id}/${reasoningEffort}.`;
  const leaseTurnsRemaining = value.leaseTurnsRemaining;
  if (leaseTurnsRemaining !== undefined && (
    typeof leaseTurnsRemaining !== "number" ||
    !Number.isInteger(leaseTurnsRemaining) ||
    leaseTurnsRemaining < 0
  )) {
    throw new RouterFrameworkError(
      "policy",
      `Routing policy returned invalid leaseTurnsRemaining '${String(leaseTurnsRemaining)}'.`,
      "policy_invalid_lease_turns",
    );
  }
  return {
    decision: {
      selectedModel: candidate.id,
      reasoningEffort,
      reason,
      ...(leaseTurnsRemaining === undefined ? {} : { leaseTurnsRemaining }),
    },
    candidates,
    source: "policy",
    ...(value.details === undefined ? {} : { policyDetails: value.details }),
  };
}
