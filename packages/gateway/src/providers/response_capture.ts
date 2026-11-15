export type CapturedProviderResponse = {
  status: number;
  headers: Headers;
  bodyText: string;
};

export type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ProviderResponseCapture = {
  fetch: ProviderFetch;
  last: CapturedProviderResponse | undefined;
  // Headers of the last successful provider response, which carry a
  // subscription's remaining usage.
  succeeded: Headers | undefined;
  // The `subscription` of the last successful stream's
  // `response.subscription_usage` event, which Meta's Muse Code plans send
  // last instead of usage headers; null once a stream ends without one.
  streamedSubscriptionUsage: Promise<unknown>;
};

const SUBSCRIPTION_USAGE_EVENT = "response.subscription_usage";
const MAX_SCANNED_LINE = 64 * 1024;

const CAPTURED_BODY_MAX_BYTES = 64 * 1024;

/**
 * A fetch wrapper that remembers the last failed provider response, and the
 * headers of the last successful one. pi-ai
 * flattens provider errors into one message string before they reach the
 * runtime, so this is the only place the status, rate-limit headers, and
 * structured error body of a rejected call can still be read.
 */
export function createProviderResponseCapture(
  options: { watchSubscriptionUsage?: boolean } = {},
): ProviderResponseCapture {
  const capture: ProviderResponseCapture = {
    last: undefined,
    succeeded: undefined,
    streamedSubscriptionUsage: Promise.resolve(null),
    fetch: async (input, init) => {
      const response = await globalThis.fetch(input, init);
      if (response.ok) {
        capture.succeeded = response.headers;
        if (
          options.watchSubscriptionUsage !== true
          || response.body === null
          || !response.headers.get("content-type")?.includes("text/event-stream")
        ) {
          return response;
        }
        const watched = watchSubscriptionUsage(response.body);
        capture.streamedSubscriptionUsage = watched.usage;
        return new Response(watched.body, response);
      }
      const bodyText = await readBodyPrefix(response.clone());
      capture.last = { status: response.status, headers: response.headers, bodyText };
      return response;
    },
  };
  return capture;
}

/**
 * Passes a server-sent event stream through unchanged while watching for its
 * subscription usage event. The usage resolves when the stream ends or is
 * cancelled.
 */
function watchSubscriptionUsage(source: ReadableStream<Uint8Array>): {
  body: ReadableStream<Uint8Array>;
  usage: Promise<unknown>;
} {
  let found: unknown = null;
  let settle: (usage: unknown) => void = () => undefined;
  const usage = new Promise<unknown>((resolve) => { settle = resolve; });
  const decoder = new TextDecoder();
  const reader = source.getReader();
  // The usage event is small; a longer line (an image, a large output item)
  // is skipped rather than buffered.
  let line = "";
  let skipping = false;
  const take = (complete: string) => {
    if (!complete.startsWith("data:") || !complete.includes(SUBSCRIPTION_USAGE_EVENT)) return;
    try {
      const event = JSON.parse(complete.slice(5)) as { type?: unknown; subscription?: unknown };
      if (event.type === SUBSCRIPTION_USAGE_EVENT) found = event.subscription ?? null;
    } catch {
      // Not this event; the stream itself is the client's to parse.
    }
  };
  const scan = (text: string) => {
    const pieces = text.split("\n");
    for (let index = 0; index < pieces.length; index += 1) {
      if (!skipping) line += pieces[index];
      if (line.length > MAX_SCANNED_LINE) {
        line = "";
        skipping = true;
      }
      if (index < pieces.length - 1) {
        if (!skipping) take(line.trimEnd());
        line = "";
        skipping = false;
      }
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          scan(decoder.decode() + "\n");
          settle(found);
          controller.close();
          return;
        }
        scan(decoder.decode(value, { stream: true }));
        controller.enqueue(value);
      } catch (error) {
        settle(found);
        controller.error(error);
      }
    },
    async cancel(reason) {
      settle(found);
      await reader.cancel(reason);
    },
  });
  return { body, usage };
}

async function readBodyPrefix(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > CAPTURED_BODY_MAX_BYTES ? text.slice(0, CAPTURED_BODY_MAX_BYTES) : text;
  } catch {
    return "";
  }
}

const CAPTURE_KEY = Symbol("providerResponseCapture");

/**
 * A provider call that throws before returning a stream loses its capture with
 * the started state, so the error carries it to the attempt runner instead.
 */
export function attachProviderResponseCapture(
  error: unknown,
  capture: ProviderResponseCapture | undefined,
): unknown {
  if (capture !== undefined && typeof error === "object" && error !== null) {
    (error as Record<symbol, unknown>)[CAPTURE_KEY] = capture;
  }
  return error;
}

export function providerResponseCaptureFromError(error: unknown): ProviderResponseCapture | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const capture = (error as Record<symbol, unknown>)[CAPTURE_KEY];
  return capture === undefined ? undefined : (capture as ProviderResponseCapture);
}
