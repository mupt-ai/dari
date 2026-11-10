import { isRecord } from "@mupt-ai/dari-router/policy-engine";

import type { AnthropicSafeguards, InteractionRequest } from "../interaction/types.js";
import type { ProviderFetch } from "./response_capture.js";

// Claude Code's auto mode asks the Anthropic API to run its dangerous-tool-use
// classifier server-side, at no charge, by sending `safeguards` with a paired
// beta. The API answers with `safeguard_results`, keyed by tool_use ID, on the
// final message_delta. Pi drops both, so the request is patched at the payload
// boundary and the results are read off the raw SSE bytes. Other providers
// never see the field; Claude Code then runs its own classifier for that turn.

export function forwardsAnthropicSafeguards(
  request: Pick<InteractionRequest, "anthropicSafeguards">,
  model: Record<string, unknown>,
): boolean {
  return (
    request.anthropicSafeguards !== undefined &&
    model.provider === "anthropic" &&
    model.api === "anthropic-messages"
  );
}

export function payloadWithSafeguards(
  payload: Record<string, unknown>,
  safeguards: AnthropicSafeguards,
): Record<string, unknown> {
  const betas = Array.isArray(payload.betas) ? payload.betas : [];
  return {
    ...payload,
    safeguards: safeguards.safeguards,
    betas: [...new Set([...betas, ...safeguards.betas])],
  };
}

export type SafeguardResultsTap = {
  fetch: ProviderFetch;
  results: () => unknown[] | undefined;
};

export function safeguardResultsTap(
  fetch: ProviderFetch = globalThis.fetch,
): SafeguardResultsTap {
  let results: unknown[] | undefined;
  return {
    results: () => results,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (!response.ok || response.body === null) return response;
      results = undefined;
      return new Response(
        response.body.pipeThrough(safeguardResultsScanner((value) => {
          results = value;
        })),
        { status: response.status, statusText: response.statusText, headers: response.headers },
      );
    },
  };
}

export function messageWithSafeguardResults(
  message: Record<string, unknown>,
  results: unknown[] | undefined,
): Record<string, unknown> {
  return results === undefined ? message : { ...message, safeguardResults: results };
}

export async function* eventsWithSafeguardResults(
  events: AsyncIterable<Record<string, unknown>>,
  tap: SafeguardResultsTap,
): AsyncIterable<Record<string, unknown>> {
  for await (const event of events) {
    if (event.type === "done" && isRecord(event.message)) {
      yield { ...event, message: messageWithSafeguardResults(event.message, tap.results()) };
      continue;
    }
    yield event;
  }
}

function safeguardResultsScanner(
  onResults: (results: unknown[]) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  const scan = (line: string) => {
    if (!line.startsWith("data:") || !line.includes("\"safeguard_results\"")) return;
    let event: unknown;
    try {
      event = JSON.parse(line.slice("data:".length));
    } catch {
      return;
    }
    if (
      isRecord(event) &&
      event.type === "message_delta" &&
      isRecord(event.delta) &&
      Array.isArray(event.delta.safeguard_results)
    ) {
      onResults(event.delta.safeguard_results);
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) scan(line.trimEnd());
    },
    flush() {
      scan((pending + decoder.decode()).trimEnd());
    },
  });
}
