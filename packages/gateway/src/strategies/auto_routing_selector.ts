import { requestAutoRouterSelection } from "@mupt-ai/dari-router";
import { parseSelectorDecision, SELECTOR_LEASE_TURNS } from "@mupt-ai/dari-router/policy-engine";
import { HttpError } from "../http/errors.js";
import type { SelectorBackend } from "./routing.js";

export const DARI_AUTO_ROUTING_ENDPOINT = "https://routing.dari.dev/v1/auto-router";
// Same selector identity and input budget as `createAutoRouter` in
// @mupt-ai/dari-router, which calls the same API.
const AUTO_ROUTER_MODEL = "dari/auto-router";
const AUTO_ROUTER_CONTEXT_WINDOW_CHARS = 32_000;

/**
 * Choose among a router's models with Dari Auto Routing, the hosted routing
 * policy. Each selection is one call to the Auto Router API with a Dari API
 * key; the gateway still executes the chosen model with its own credentials.
 */
export function createAutoRoutingSelectorBackend(config: {
  apiKey: string;
  endpoint?: string;
  fetch?: typeof fetch;
}): SelectorBackend {
  const apiKey = config.apiKey.trim();
  if (!apiKey) {
    throw new Error("Dari Auto Routing needs an API key.");
  }
  return {
    selectorModel: AUTO_ROUTER_MODEL,
    contextWindowChars: async () => AUTO_ROUTER_CONTEXT_WINDOW_CHARS,
    // Dari's routing policy grants leases, so an expired lease goes back to
    // the policy rather than the runtime's stateless hold.
    negotiatedLeaseTurns: async () => SELECTOR_LEASE_TURNS,
    select: async (args) => {
      let outputText: string;
      try {
        outputText = await requestAutoRouterSelection({
          apiKey,
          endpoint: config.endpoint ?? DARI_AUTO_ROUTING_ENDPOINT,
          request: args.selectorRequest,
          fetch: config.fetch,
        });
      } catch {
        throw new HttpError(502, "Dari Auto Routing request failed.", "selector_execution_failed");
      }
      return {
        decision: parseSelectorDecision(outputText).decision,
        selectorModel: args.selectorModel,
        candidates: args.candidates,
        selectorInput: args.selectorInput,
        selectorRequest: args.selectorRequest,
        outputText,
        usage: null,
        latencyMs: Date.now() - args.startedAt,
      };
    },
  };
}
