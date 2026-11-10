import { parseSelectorDecision } from "@mupt-ai/dari-router/policy-engine";
import { HttpError } from "../http/errors.js";
import type { SelectorBackend } from "./routing.js";

export const DARI_AUTO_ROUTING_ENDPOINT = "https://routing.dari.dev/v1/auto-router";
// Same selector identity and input budget as `createAutoRouter` in
// @mupt-ai/dari-router, which calls the same API.
const AUTO_ROUTER_MODEL = "dari/auto-router";
const AUTO_ROUTER_CONTEXT_WINDOW_CHARS = 32_000;
const AUTO_ROUTER_TIMEOUT_MS = 30_000;

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
  const endpoint = (config.endpoint ?? DARI_AUTO_ROUTING_ENDPOINT)
    .replace(/\/+$/, "")
    .replace(/\/select$/, "");
  const fetchImpl = config.fetch ?? fetch;
  return {
    selectorModel: AUTO_ROUTER_MODEL,
    contextWindowChars: async () => AUTO_ROUTER_CONTEXT_WINDOW_CHARS,
    select: async (args) => {
      let response: Response;
      try {
        response = await fetchImpl(`${endpoint}/select`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(args.selectorRequest),
          signal: AbortSignal.timeout(AUTO_ROUTER_TIMEOUT_MS),
        });
      } catch {
        throw new HttpError(502, "Dari Auto Routing request failed.", "selector_execution_failed");
      }
      if (!response.ok) {
        throw new HttpError(
          502,
          `Dari Auto Routing returned HTTP ${response.status}.`,
          "selector_execution_failed",
        );
      }
      const outputText = await response.text();
      // The gateway applies its own stateless hold; drop any lease the
      // policy stamps so it is not mistaken for a negotiated one.
      const { leaseTurnsRemaining: _leaseTurnsRemaining, ...decision } =
        parseSelectorDecision(outputText).decision;
      return {
        decision,
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
