import { isRecord } from "@mupt-ai/dari-router/policy-engine";

import { anthropicWebSearchTool } from "../interaction/capabilities.js";
import type { InteractionRequest, ServerTool } from "../interaction/types.js";
import { sseEventScanner } from "./anthropic_safeguards.js";
import type { ProviderFetch } from "./response_capture.js";

// Anthropic runs web search inside the Claude API: the request carries the
// client's `web_search` tool, and the answer a `web_search_tool_result` block
// per search (titles, URLs, encrypted page content). Pi sends a server tool by
// type and name only and drops the result block, so the tool's own definition
// is restored at the payload boundary and the results are read off the raw SSE
// bytes. They are appended after the content Pi kept: clients such as Claude
// Code read them by type, not position.

// The request's web search tool when `model` is one Anthropic's API serves.
export function anthropicWebSearchFor(
  request: Pick<InteractionRequest, "tools">,
  model: Record<string, unknown>,
): ServerTool | undefined {
  return model.provider === "anthropic" && model.api === "anthropic-messages"
    ? anthropicWebSearchTool(request)
    : undefined;
}

export function payloadWithWebSearchTool(
  payload: Record<string, unknown>,
  tool: ServerTool,
): Record<string, unknown> {
  if (!Array.isArray(payload.tools) || tool.definition === undefined) return payload;
  return {
    ...payload,
    tools: payload.tools.map((entry) =>
      isRecord(entry) && entry.type === tool.type
        ? { ...tool.definition, ...(entry.cache_control === undefined ? {} : { cache_control: entry.cache_control }) }
        : entry
    ),
  };
}

type WebSearchResult = { toolUseId: string; content: unknown };

export type WebSearchResultsTap = {
  fetch: ProviderFetch;
  results: () => WebSearchResult[];
};

export function webSearchResultsTap(
  fetch: ProviderFetch = globalThis.fetch,
): WebSearchResultsTap {
  let results: WebSearchResult[] = [];
  return {
    results: () => results,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (!response.ok || response.body === null) return response;
      results = [];
      return new Response(
        response.body.pipeThrough(sseEventScanner("\"web_search_tool_result\"", (event) => {
          const block = event.type === "content_block_start" ? event.content_block : undefined;
          if (isRecord(block) && block.type === "web_search_tool_result" && typeof block.tool_use_id === "string") {
            results.push({ toolUseId: block.tool_use_id, content: block.content });
          }
        })),
        { status: response.status, statusText: response.statusText, headers: response.headers },
      );
    },
  };
}

export function messageWithWebSearchResults(
  message: Record<string, unknown>,
  results: WebSearchResult[],
): Record<string, unknown> {
  if (results.length === 0 || !Array.isArray(message.content)) return message;
  return {
    ...message,
    content: [...message.content, ...results.map((result) => ({ type: "webSearchResult", ...result }))],
  };
}

// Emits each result as its own content block just before the stream ends.
export async function* eventsWithWebSearchResults(
  events: AsyncIterable<Record<string, unknown>>,
  tap: WebSearchResultsTap,
): AsyncIterable<Record<string, unknown>> {
  for await (const event of events) {
    if (event.type === "done" && isRecord(event.message) && Array.isArray(event.message.content)) {
      const first = event.message.content.length;
      const message = messageWithWebSearchResults(event.message, tap.results());
      for (const [offset, webSearchResult] of tap.results().entries()) {
        yield { type: "web_search_result", contentIndex: first + offset, webSearchResult, partial: message };
      }
      yield { ...event, message };
      continue;
    }
    yield event;
  }
}
