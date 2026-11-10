import { isRecord } from "@mupt-ai/dari-router/policy-engine";

import { gatewayFor } from "../models/gateways.js";
import { providerFailureFromCaught } from "../runtime/provider_stream_outcome.js";
import type { ProviderFetch } from "./response_capture.js";

// Gateways bill per call and say what they billed: OpenRouter as `usage.cost`
// on the final chunk (plus the provider's charge on a BYOK call), Vercel AI
// Gateway as `providerMetadata.gateway.cost`.
// Pi prices usage from model rates and drops both, so the amount is read off
// the raw response bytes and replaces the priced total.

export function reportsProviderCost(model: Record<string, unknown>): boolean {
  return gatewayFor(model.provider) !== undefined;
}

export type ProviderReportedCostTap = {
  fetch: ProviderFetch;
  cost: () => number | undefined;
};

export function providerReportedCostTap(
  fetch: ProviderFetch = globalThis.fetch,
): ProviderReportedCostTap {
  let cost: number | undefined;
  return {
    cost: () => cost,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (!response.ok || response.body === null) return response;
      cost = undefined;
      return new Response(
        response.body.pipeThrough(costScanner((value) => {
          cost = value;
        })),
        { status: response.status, statusText: response.statusText, headers: response.headers },
      );
    },
  };
}

export function messageWithProviderReportedCost(
  message: Record<string, unknown>,
  cost: number | undefined,
): Record<string, unknown> {
  if (cost === undefined) return message;
  // A thrown error (or other record without a stop reason) becomes a failure
  // message first: spreading an Error drops its non-enumerable `message`, and
  // failure handling keeps usage only on messages that stopped in error.
  const base = message.stopReason === undefined
    ? { ...providerFailureFromCaught(message), ...(isRecord(message.usage) ? { usage: message.usage } : {}) }
    : message;
  const usage = isRecord(base.usage) ? base.usage : {};
  return {
    ...base,
    usage: {
      ...usage,
      cost: { ...(isRecord(usage.cost) ? usage.cost : {}), total: cost },
      costSource: "provider",
    },
  };
}

// Aborted and failed calls end in an error event carrying the partial
// message; it keeps whatever cost the provider reported before the end.
export async function* eventsWithProviderReportedCost(
  events: AsyncIterable<Record<string, unknown>>,
  tap: ProviderReportedCostTap,
): AsyncIterable<Record<string, unknown>> {
  for await (const event of events) {
    if (event.type === "done" && isRecord(event.message)) {
      yield { ...event, message: messageWithProviderReportedCost(event.message, tap.cost()) };
      continue;
    }
    if (event.type === "error" && isRecord(event.error)) {
      yield { ...event, error: messageWithProviderReportedCost(event.error, tap.cost()) };
      continue;
    }
    yield event;
  }
}

export function reportedCost(body: unknown): number | undefined {
  if (!isRecord(body)) return undefined;
  const gateway = isRecord(body.providerMetadata) && isRecord(body.providerMetadata.gateway)
    ? body.providerMetadata.gateway
    : undefined;
  return openRouterCost(body.usage) ?? usd(gateway?.cost);
}

// On a BYOK call OpenRouter bills the provider's charge to the org's own key:
// `usage.cost` is only its fee (often 0), and the charge is in
// `cost_details.upstream_inference_cost`.
function openRouterCost(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;
  const cost = usd(usage.cost);
  if (cost === undefined || usage.is_byok !== true) return cost;
  const upstream = isRecord(usage.cost_details)
    ? usd(usage.cost_details.upstream_inference_cost)
    : undefined;
  return cost + (upstream ?? 0);
}

function usd(value: unknown): number | undefined {
  const amount = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof amount === "number" && Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

// Reads SSE `data:` lines and plain JSON bodies alike; the last reported
// amount wins.
function costScanner(onCost: (cost: number) => void): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  let body = "";
  let sse = false;
  const scan = (line: string) => {
    if (!line.startsWith("data:") || !line.includes("cost")) return;
    try {
      const cost = reportedCost(JSON.parse(line.slice("data:".length)));
      if (cost !== undefined) onCost(cost);
    } catch {
      // Not JSON: [DONE] or a keep-alive.
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      const text = decoder.decode(chunk, { stream: true });
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed.startsWith("data:")) sse = true;
        scan(trimmed);
      }
      if (!sse && body.length < 1024 * 1024) body += text;
    },
    flush() {
      const tail = decoder.decode();
      scan((pending + tail).trimEnd());
      body += tail;
      if (sse || !body.includes("cost")) return;
      try {
        const cost = reportedCost(JSON.parse(body));
        if (cost !== undefined) onCost(cost);
      } catch {
        // Not a JSON body.
      }
    },
  });
}
