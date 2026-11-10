import type {
  CandidateCostEstimate,
  ModelPricing,
  ReasoningEffort,
} from "@mupt-ai/dari-router/policy-engine";
import { pricingForPrompt } from "@mupt-ai/dari-router/policy-engine";
import type {
  InteractionOutput,
  InteractionUsage,
  ProviderIdentity,
} from "../interaction/types.js";

/** Prose from current models averages about 4.8 characters per token. */
export const ESTIMATED_CHARS_PER_TOKEN = 4.8;
const MTOK = 1_000_000;
const MAX_RETAINED_TEXT_CHARS = 512 * 1024;

export type PromptTokenEstimate = { promptTokens: number; warmTokens: number };

export type DeliveredOutput = {
  text: string;
  textChars: number;
  reasoningChars: number;
};

export const NO_DELIVERED_OUTPUT: DeliveredOutput = {
  text: "",
  textChars: 0,
  reasoningChars: 0,
};

export function promptTokenEstimateFor(
  estimates: readonly CandidateCostEstimate[] | undefined,
  model: string,
  reasoningEffort: ReasoningEffort,
): PromptTokenEstimate | undefined {
  const match =
    estimates?.find(
      (item) => item.model === model && item.reasoning_effort === reasoningEffort,
    ) ?? estimates?.find((item) => item.model === model);
  return match
    ? { promptTokens: match.est_prompt_tokens, warmTokens: match.warm_tokens }
    : undefined;
}

/** Measure the provider text the protocol actually consumed for the client. */
export function observeDeliveredOutput(
  events: AsyncIterable<Record<string, unknown>>,
): {
  events: AsyncIterable<Record<string, unknown>>;
  delivered: () => DeliveredOutput;
} {
  const state: DeliveredOutput = { text: "", textChars: 0, reasoningChars: 0 };
  async function* observed(): AsyncIterable<Record<string, unknown>> {
    for await (const event of events) {
      if (typeof event.delta === "string") {
        if (event.type === "text_delta") {
          state.textChars += event.delta.length;
          if (state.text.length < MAX_RETAINED_TEXT_CHARS) {
            state.text += event.delta.slice(
              0,
              MAX_RETAINED_TEXT_CHARS - state.text.length,
            );
          }
        } else if (event.type === "thinking_delta") {
          state.reasoningChars += event.delta.length;
        }
      }
      yield event;
    }
  }
  return { events: observed(), delivered: () => ({ ...state }) };
}

/**
 * Usage for a cancelled attempt: prompt tokens from the selector's estimate,
 * output tokens from the characters delivered before the abort. Reasoning the
 * provider never surfaced is not counted, so the estimate errs in the
 * customer's favor. Cost is zero when the model has no known pricing.
 */
export function estimatedCancelUsage(args: {
  pricing: ModelPricing | null;
  promptEstimate: PromptTokenEstimate | undefined;
  delivered: DeliveredOutput;
}): InteractionUsage & { estimated: true } {
  const cacheRead = Math.max(0, Math.round(args.promptEstimate?.warmTokens ?? 0));
  const input = Math.max(
    0,
    Math.round((args.promptEstimate?.promptTokens ?? 0) - cacheRead),
  );
  const output = Math.round(
    (args.delivered.textChars + args.delivered.reasoningChars) /
      ESTIMATED_CHARS_PER_TOKEN,
  );
  const price = pricingForPrompt(args.pricing ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, input + cacheRead);
  const cost = {
    input: (input * price.input) / MTOK,
    output: (output * price.output) / MTOK,
    cacheRead: (cacheRead * price.cacheRead) / MTOK,
    cacheWrite: 0,
    total: 0,
  };
  cost.total = cost.input + cost.output + cost.cacheRead;
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + cacheRead + output,
    cost,
    estimated: true,
  };
}

/**
 * The delivered partial as an assistant turn, so the interrupted request can
 * still write a prefix entry that the follow-up turn may match.
 */
export function partialInteractionOutput(args: {
  delivered: DeliveredOutput;
  usage: InteractionUsage;
  source: ProviderIdentity;
  createdAtMs: number;
}): InteractionOutput | null {
  if (args.delivered.text.length === 0) return null;
  return {
    createdAtMs: args.createdAtMs,
    source: args.source,
    items: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: args.delivered.text }],
        contentShape: "parts",
      },
    ],
    usage: args.usage,
    stopReason: "aborted",
  };
}
