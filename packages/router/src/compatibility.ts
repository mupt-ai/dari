import { RouterCoreError } from "./errors.js";
import {
  isReasoningEffort,
  type HardCapability,
  type ReasoningEffort,
  type RoutingCandidate,
} from "./types.js";

// Host-supplied capability facts for one candidate model. Hosts derive this
// from their model registry/catalog; the core only applies the eligibility
// rules and never inspects provider metadata records directly.
export type CandidateModelMetadata = {
  // Provider identifier, e.g. "meta" or "anthropic".
  provider: string;
  // Provider API identifier, e.g. "anthropic-messages" or "openai-responses".
  api: string;
  supportsImageInput: boolean;
  supportsHostedWebSearch: boolean;
  // Whether the model accepts Responses configuration_update items that
  // change reasoning effort without rewriting the request-level prefix.
  supportsReasoningConfigurationUpdate?: boolean;
  // Whether the provider API can serialize response_format for structured
  // output (JSON schema) requests.
  supportsStructuredOutput: boolean;
  supportedThinkingLevels: string[];
};

export type CandidateMetadataLookup = (modelId: string) => CandidateModelMetadata;

export type CompatibleCandidates = {
  candidates: RoutingCandidate[];
};

export function resolveCompatibleCandidates(args: {
  requiredCapabilities: readonly HardCapability[];
  // The client's explicit reasoning_effort request, when present. Pins every
  // candidate to that level.
  requestedReasoningEffort?: ReasoningEffort;
  // Some protocols carry an independent hard thinking-enabled constraint.
  thinkingEnabled?: boolean;
  // The request's tool_choice value in OpenAI wire shape ("none" | "auto" |
  // "required" | "any" | {..forced tool..}). Only forced-tool detection is
  // applied here.
  toolChoice?: unknown;
  candidateModels: string[];
  metadataLookup: CandidateMetadataLookup;
  modelThinkingLevels?: Readonly<Record<string, ReasoningEffort[]>>;
}): CompatibleCandidates {
  const compatible: RoutingCandidate[] = [];
  let anthropicToolChoiceRejected = false;
  let metaToolChoiceRejected = false;
  let candidates = args.candidateModels.map((model) => ({
    model,
    metadata: args.metadataLookup(model),
  }));

  if (args.requiredCapabilities.includes("image_input")) {
    candidates = candidates.filter(({ metadata }) => metadata.supportsImageInput);
    if (candidates.length === 0) {
      throw new RouterCoreError(
        "invalid_request",
        "Image input is not supported by any enabled model for this router.",
        "unsupported_input_modality",
      );
    }
  }

  if (args.requiredCapabilities.includes("structured_output")) {
    candidates = candidates.filter(({ metadata }) => metadata.supportsStructuredOutput);
    if (candidates.length === 0) {
      throw new RouterCoreError(
        "invalid_request",
        "Structured output is not supported by any enabled model for this router.",
        "unsupported_response_format",
        "response_format",
      );
    }
  }

  if (args.requiredCapabilities.includes("openai_hosted_web_search")) {
    candidates = candidates.filter(({ metadata }) => metadata.supportsHostedWebSearch);
    if (candidates.length === 0) {
      throw new RouterCoreError(
        "invalid_request",
        "Hosted web search requires an enabled OpenAI or Azure Responses model for this router.",
        "unsupported_tool",
        "tools",
      );
    }
  }

  if (args.requiredCapabilities.includes("reasoning_configuration_update")) {
    candidates = candidates.filter(({ metadata }) => metadata.supportsReasoningConfigurationUpdate);
    if (candidates.length === 0) {
      throw new RouterCoreError(
        "invalid_request",
        "Reasoning configuration updates require an enabled GPT-6 Responses model for this router.",
        "unsupported_reasoning_configuration",
        "input",
      );
    }
  }

  const requested = args.requestedReasoningEffort;
  for (const { model, metadata } of candidates) {
    if (
      metadata.provider === "meta" &&
      args.toolChoice !== undefined &&
      args.toolChoice !== "auto"
    ) {
      metaToolChoiceRejected = true;
      continue;
    }
    const supportedLevels = metadata.supportedThinkingLevels.filter(
      isReasoningEffort,
    );
    const configuredLevels = args.modelThinkingLevels?.[model] ?? supportedLevels;
    const enabledLevels = configuredLevels.filter(
      (level) => isReasoningEffort(level) && supportedLevels.includes(level),
    );
    const levels = requested === undefined
      ? args.thinkingEnabled
        ? enabledLevels.filter((level) => level !== "off")
        : enabledLevels
      : enabledLevels.includes(requested)
        ? [requested]
        : [];
    for (const reasoningEffort of levels) {
      if (
        reasoningEffort !== "off" &&
        metadata.api === "anthropic-messages" &&
        forcesToolUse(args.toolChoice)
      ) {
        anthropicToolChoiceRejected = true;
        continue;
      }
      compatible.push({ model, reasoningEffort });
    }
  }

  if (compatible.length > 0) return { candidates: compatible };

  if (anthropicToolChoiceRejected) {
    throw new RouterCoreError(
      "invalid_request",
      "Forced tool choice is not supported by any enabled model at the requested reasoning setting.",
      "unsupported_tool_choice",
      "tool_choice",
    );
  }

  if (metaToolChoiceRejected) {
    throw new RouterCoreError(
      "invalid_request",
      "Meta models currently support only omitted or 'auto' tool_choice.",
      "unsupported_tool_choice",
      "tool_choice",
    );
  }

  throw new RouterCoreError(
    "invalid_request",
    requested === undefined
      ? args.thinkingEnabled
        ? "Thinking is enabled, but no enabled non-off model/thinking-level pair is compatible with this request."
        : "No enabled model/thinking-level pair is compatible with this request."
      : `reasoning_effort '${requested}' is not supported by any enabled model for this router.`,
    "unsupported_reasoning_effort",
    requested === undefined ? undefined : "reasoning_effort",
  );
}

function forcesToolUse(choice: unknown): boolean {
  return choice === "required" ||
    choice === "any" ||
    (typeof choice === "object" && choice !== null);
}
