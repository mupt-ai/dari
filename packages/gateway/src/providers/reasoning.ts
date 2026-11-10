import type { ReasoningEffort } from "@mupt-ai/dari-router/policy-engine";
import { HttpError } from "../http/errors.js";
import type { InteractionRequest } from "../interaction/types.js";

type ReasoningRequest = Pick<InteractionRequest, "reasoning">;

function requestedReasoningEffort(request: ReasoningRequest): ReasoningEffort | undefined {
  return request.reasoning?.effort;
}

export function effectiveReasoningForModel(args: {
  request: ReasoningRequest;
  selectedModel: string;
  supportedLevels: string[];
  selectedReasoningEffort?: ReasoningEffort;
  defaultReasoningEffort?: ReasoningEffort;
}): ReasoningEffort | undefined {
  const requested =
    requestedReasoningEffort(args.request) ?? args.selectedReasoningEffort;
  const effective =
    requested ??
    args.defaultReasoningEffort ??
    implicitReasoningEffort(args.supportedLevels);
  if (effective === undefined) return undefined;

  validateReasoningEffortForModel(
    effective,
    args.selectedModel,
    args.supportedLevels,
  );
  return effective;
}

export function validateReasoningEffortForModel(
  effort: ReasoningEffort,
  selectedModel: string,
  supportedLevels: string[],
): void {
  if (supportedLevels.includes(effort)) return;
  throw new HttpError(
    400,
    `reasoning_effort '${effort}' is not supported by ${selectedModel}. Supported values: ${supportedLevels.join(", ")}.`,
    "unsupported_reasoning_effort",
    "reasoning_effort"
  );
}

// Routed serving always supplies the selected pair's effort. For direct
// internal provider calls that do not (currently the selector), use cataloged
// provider defaults when available, then fall back to medium or the closest
// supported level for custom models. Explicit "off" remains available for
// routed candidates that support a true non-reasoning mode.
const IMPLICIT_REASONING_PREFERENCE: readonly ReasoningEffort[] = ["medium", "low", "high", "minimal", "xhigh", "max"];

function implicitReasoningEffort(supportedLevels: string[]): ReasoningEffort | undefined {
  // Models with no non-off level (non-reasoning models) keep omitting the
  // reasoning field entirely.
  return IMPLICIT_REASONING_PREFERENCE.find((level) => supportedLevels.includes(level));
}
