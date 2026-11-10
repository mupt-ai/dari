import type { ProviderContinuationState } from "../../interaction/types.js";

export function chatReasoningDetailId(
  continuation: ProviderContinuationState,
  index: number,
  toolCallIds: readonly string[],
  usedIds: Set<string>
): string {
  let candidate = toolCallIds[index];
  if (
    !candidate
    && continuation.kind === "openai_reasoning"
    && continuation.providerItemId
  ) candidate = continuation.providerItemId;
  if (!candidate || usedIds.has(candidate)) candidate = `reasoning_${index}`;
  while (usedIds.has(candidate)) candidate = `${candidate}_${index}`;
  usedIds.add(candidate);
  return candidate;
}
