import { isRecord } from "@mupt-ai/dari-router/policy-engine";

import type { InteractionToolCall } from "../../interaction/types.js";

export function interactionToolInput(
  item: InteractionToolCall,
): Record<string, unknown> | undefined {
  if (isRecord(item.input)) return item.input;
  if (typeof item.input !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(item.input);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
