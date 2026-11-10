import type { SelectorBackend } from "./routing.js";

const PRIORITY_SELECTOR_MODEL = "dari-gateway/priority";
// Priority selection reads no messages, so the sized selector input only
// needs room for the router's candidates.
const PRIORITY_CONTEXT_WINDOW_CHARS = 1_000_000;

/**
 * Serve the router's first eligible model/thinking-level pair, in the order
 * the router lists them.
 */
export function createPrioritySelectorBackend(): SelectorBackend {
  return {
    selectorModel: PRIORITY_SELECTOR_MODEL,
    contextWindowChars: async () => PRIORITY_CONTEXT_WINDOW_CHARS,
    prepareMessages: () => [],
    supportsSpeculativeRouting: false,
    select: async (args) => {
      const first = args.candidates[0];
      if (first === undefined) {
        throw new Error("Priority selection needs at least one candidate.");
      }
      return {
        decision: {
          selectedModel: first.model,
          reasoningEffort: first.reasoningEffort,
          reason: "First eligible model on the router.",
        },
        selectorModel: args.selectorModel,
        candidates: args.candidates,
        selectorInput: args.selectorInput,
        selectorRequest: args.selectorRequest,
        outputText: "",
        usage: null,
        latencyMs: Date.now() - args.startedAt,
      };
    },
  };
}
