import { isRecord } from "@mupt-ai/dari-router/policy-engine";

import { requiredCapabilitiesFor } from "../interaction/capabilities.js";
import type { InteractionRequest } from "../interaction/types.js";
import { sseEventScanner } from "./anthropic_safeguards.js";
import type { ProviderFetch } from "./response_capture.js";

// Anthropic and OpenAI charge for each web search on top of tokens: $10 per
// 1,000 searches, a search that fails is not charged.
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool#usage-and-pricing
// https://developers.openai.com/api/docs/pricing
export const WEB_SEARCH_USD_PER_SEARCH = 0.01;

// Whether the request can make the provider run a web search it charges for.
export function chargesWebSearch(request: Pick<InteractionRequest, "tools" | "toolChoice" | "items">): boolean {
  const capabilities = requiredCapabilitiesFor(request);
  return capabilities.includes("anthropic_web_search") || capabilities.includes("openai_hosted_web_search");
}

export type WebSearchCountTap = {
  fetch: ProviderFetch;
  searches: () => number;
};

// Counts the searches the provider charged for, from its own stream:
// Anthropic's usage reports them (`server_tool_use.web_search_requests`, the
// running total for the response), and OpenAI lists each completed
// `web_search_call`.
export function webSearchCountTap(fetch: ProviderFetch = globalThis.fetch): WebSearchCountTap {
  let anthropic = 0;
  let openai = new Set<string>();
  return {
    searches: () => anthropic + openai.size,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (!response.ok || response.body === null) return response;
      anthropic = 0;
      openai = new Set();
      return new Response(
        response.body.pipeThrough(sseEventScanner("\"web_search", (event) => {
          const usage = event.type === "message_delta" ? event.usage
            : event.type === "message_start" && isRecord(event.message) ? event.message.usage
            : undefined;
          const requests = isRecord(usage) && isRecord(usage.server_tool_use)
            ? usage.server_tool_use.web_search_requests
            : undefined;
          if (typeof requests === "number" && Number.isFinite(requests) && requests >= 0) {
            anthropic = Math.max(anthropic, Math.trunc(requests));
          }
          const item = event.type === "response.output_item.done" ? event.item : undefined;
          if (isRecord(item) && item.type === "web_search_call" && item.status === "completed" && typeof item.id === "string") {
            openai.add(item.id);
          }
        })),
        { status: response.status, statusText: response.statusText, headers: response.headers },
      );
    },
  };
}

// Adds the searches' fee to the message's cost, which is what a managed key
// is billed. Keys the customer owns and subscriptions are not billed here.
export function messageWithWebSearchFee(
  message: Record<string, unknown>,
  searches: number,
): Record<string, unknown> {
  if (searches <= 0 || !isRecord(message.usage) || !isRecord(message.usage.cost)) return message;
  const cost = message.usage.cost;
  const total = typeof cost.total === "number" && Number.isFinite(cost.total) ? cost.total : 0;
  return {
    ...message,
    usage: { ...message.usage, cost: { ...cost, total: total + searches * WEB_SEARCH_USD_PER_SEARCH } },
  };
}

// Aborted and failed calls end in an error event carrying the partial
// message; a search the provider completed before the end is still charged.
export async function* eventsWithWebSearchFee(
  events: AsyncIterable<Record<string, unknown>>,
  tap: WebSearchCountTap,
): AsyncIterable<Record<string, unknown>> {
  for await (const event of events) {
    if (event.type === "done" && isRecord(event.message)) {
      yield { ...event, message: messageWithWebSearchFee(event.message, tap.searches()) };
      continue;
    }
    if (event.type === "error" && isRecord(event.error)) {
      yield { ...event, error: messageWithWebSearchFee(event.error, tap.searches()) };
      continue;
    }
    yield event;
  }
}
