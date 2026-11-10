import { RouterCoreError } from "./errors.js";
import { CUSTOM_RULES_PROMPT, SELECTOR_SYSTEM_PROMPT } from "./prompts.js";
import {
  buildSelectorInput,
  type CustomSelectorInput,
  type SelectorInput,
  type SelectorLeaseHistoryEntry,
} from "./selector_input.js";
import { olderMessageChars, trimMessagesFromFront } from "./selector_truncation.js";
import { REASONING_EFFORTS } from "./types.js";
import type {
  CandidateCostEstimate,
  ChatCompletionRequest,
  ChatMessage,
  CustomRouterRule,
  PreviousDecision,
  ReasoningEffort,
  RouterEval,
  RoutingCandidate,
} from "./types.js";

export type BuiltSelectorRequest = {
  selectorInput: SelectorInput | CustomSelectorInput;
  selectorRequest: ChatCompletionRequest;
};

export type SelectorRequestArgs = {
  candidates: RoutingCandidate[];
  evals?: RouterEval[];
  previousDecision?: PreviousDecision;
  costEstimates?: CandidateCostEstimate[];
  customRules?: CustomRouterRule[];
  defaultTarget?: {
    model: string;
    thinkingLevel: ReasoningEffort | null;
  } | null;
  selectorModel: string;
  messages: ChatMessage[];
  leaseHistory?: SelectorLeaseHistoryEntry[];
  modelFallbackEnabled?: boolean;
  fallbackRequiresDifferentProvider?: boolean;
  imputeEvalScores?: boolean;
  imputationReferenceEvals?: RouterEval[];
};

// Builds the selector request, trimming old conversation history first and the
// latest turn only when necessary. The window size is an explicit input (in
// characters) so the core stays free of model-registry lookups.
export function buildSizedSelectorRequest(
  args: SelectorRequestArgs & { contextWindowChars: number },
): BuiltSelectorRequest {
  let messages = args.messages;
  let built = buildSelectorRequest({ ...args, messages });

  while (true) {
    const inputChars = selectorRequestInputChars(built.selectorRequest);
    if (inputChars <= args.contextWindowChars) return built;
    const dropChars = inputChars - args.contextWindowChars;

    const removableHistoryChars = olderMessageChars(messages);
    if (removableHistoryChars > 0) {
      const trimmedMessages = trimMessagesFromFront(
        messages,
        Math.min(dropChars, removableHistoryChars),
      );
      const messagesBuilt = buildSelectorRequest({ ...args, messages: trimmedMessages });
      if (selectorRequestInputChars(messagesBuilt.selectorRequest) < inputChars) {
        messages = trimmedMessages;
        built = messagesBuilt;
        continue;
      }
    }

    const trimmedMessages = trimMessagesFromFront(messages, dropChars);
    const messagesBuilt = buildSelectorRequest({ ...args, messages: trimmedMessages });
    if (selectorRequestInputChars(messagesBuilt.selectorRequest) < inputChars) {
      messages = trimmedMessages;
      built = messagesBuilt;
      continue;
    }

    throw new RouterCoreError(
      "configuration",
      `Selector prompt cannot fit configured context window for ${args.selectorModel}.`,
      "configuration_error"
    );
  }
}

function selectorRequestInputChars(request: ChatCompletionRequest): number {
  return JSON.stringify(request.messages ?? []).length;
}

export function buildSelectorRequest(args: SelectorRequestArgs): BuiltSelectorRequest {
  const isCustom = args.customRules !== undefined;
  const selectorInput = buildSelectorInput({
    candidates: args.candidates,
    evals: args.evals ?? [],
    previousDecision: args.previousDecision ?? null,
    costEstimates: args.costEstimates ?? null,
    messages: args.messages,
    leaseHistory: args.leaseHistory,
    customRules: args.customRules,
    defaultTarget: args.defaultTarget,
    modelFallbackEnabled: args.modelFallbackEnabled,
    fallbackRequiresDifferentProvider:
      args.fallbackRequiresDifferentProvider,
    imputeEvalScores: args.imputeEvalScores,
    imputationReferenceEvals: args.imputationReferenceEvals,
  });
  return {
    selectorInput,
    selectorRequest: {
      model: args.selectorModel,
      messages: [
        {
          role: "system",
          content: isCustom
            ? `${SELECTOR_SYSTEM_PROMPT}\n\n${CUSTOM_RULES_PROMPT}`
            : SELECTOR_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: JSON.stringify(selectorInput),
        },
      ],
      // The selector is an internal fixed-purpose JSON pick; it must not inherit
      // the client-facing implicit-medium reasoning default. Selector models
      // must support a true off mode.
      reasoning_effort: "off",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "routing_decision",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              selected_model: { type: "string" },
              reasoning_effort: {
                type: "string",
                enum: [...REASONING_EFFORTS],
              },
              reason: { type: "string" },
            },
            required: [
              "selected_model",
              "reasoning_effort",
              "reason",
            ],
          },
        },
      },
    },
  };
}
