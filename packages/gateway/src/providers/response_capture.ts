export type CapturedProviderResponse = {
  status: number;
  headers: Headers;
  bodyText: string;
};

export type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ProviderResponseCapture = {
  fetch: ProviderFetch;
  last: CapturedProviderResponse | undefined;
};

const CAPTURED_BODY_MAX_BYTES = 64 * 1024;

/**
 * A fetch wrapper that remembers the last failed provider response. pi-ai
 * flattens provider errors into one message string before they reach the
 * runtime, so this is the only place the status, rate-limit headers, and
 * structured error body of a rejected call can still be read.
 */
export function createProviderResponseCapture(): ProviderResponseCapture {
  const capture: ProviderResponseCapture = {
    last: undefined,
    fetch: async (input, init) => {
      const response = await globalThis.fetch(input, init);
      if (response.ok) return response;
      const bodyText = await readBodyPrefix(response.clone());
      capture.last = { status: response.status, headers: response.headers, bodyText };
      return response;
    },
  };
  return capture;
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
