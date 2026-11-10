// TypeSafe Jev System One transport. Jev (docs.typesafe.ai) is a System One
// model: it answers typed questions about a state instead of generating
// text, and the answers come back as calibrated probabilities. Callers own
// the questions; this module owns the connection, retries, and errors.

import { RouterCoreError } from "./errors.js";
import { RouterFrameworkError } from "./framework_error.js";
import type { JsonValue } from "./json.js";

export const DEFAULT_JEV_ENDPOINT = "https://api.typesafe.ai/v1";
export const DEFAULT_JEV_MODEL = "jev-latest";
const DEFAULT_JEV_TIMEOUT_MS = 30_000;

// Rate-limit and overload responses get one backoff retry; anything else is
// the caller's failure to surface.
const JEV_RETRY_STATUSES = new Set([429, 529]);
const JEV_ATTEMPTS = 2;
const JEV_RETRY_DELAY_MS = 500;
const JEV_RETRY_MAX_DELAY_MS = 5_000;

export type JevConfig = {
  apiKey: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
};

export type ResolvedJevConfig = {
  apiKey: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
};

export type JevTokenUsage = { input_tokens: number; output_tokens: number };

// Jev answered 200 with a body the caller cannot use. Token counts are on
// the body even then, so hosts can still bill the call.
export class JevOutputError extends RouterCoreError {
  readonly usage: JevTokenUsage | null;

  constructor(message: string, code: string, usage: JevTokenUsage | null = null) {
    super("selector_output", message, code);
    this.name = "JevOutputError";
    this.usage = usage;
  }
}

export function resolveJevConfig(input: JevConfig): ResolvedJevConfig {
  const apiKey = input.apiKey?.trim() ?? "";
  if (!apiKey) throw configurationError("Jev requires an apiKey.", "apiKey");
  const endpoint = (input.endpoint ?? DEFAULT_JEV_ENDPOINT).trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw configurationError("Jev endpoint must be a valid URL.", "endpoint");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw configurationError(
      "Jev endpoint must be an HTTP(S) URL without embedded credentials.",
      "endpoint",
    );
  }
  const model = (input.model ?? DEFAULT_JEV_MODEL).trim();
  if (!model) throw configurationError("Jev model must not be empty.", "model");
  const timeoutMs = input.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw configurationError("Jev timeoutMs must be a positive integer.", "timeoutMs");
  }
  return { apiKey, endpoint, model, timeoutMs };
}

// One System One call: POSTs the request, retries once on rate limits and
// overload, and returns the parsed body for the caller to interpret.
export async function postSystemOne(
  request: { model: string; state: JsonValue; questions: Record<string, unknown> },
  config: ResolvedJevConfig,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetchSystemOne(request, config, signal);
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw invalidJevResponse("Jev returned a non-JSON response body.");
      }
    }
    if (attempt < JEV_ATTEMPTS && JEV_RETRY_STATUSES.has(response.status)) {
      await delay(retryDelayMs(response.headers.get("retry-after")), signal);
      continue;
    }
    const body = await response.text().catch(() => "");
    throw new RouterFrameworkError(
      "policy",
      `Jev returned HTTP ${response.status}: ${body}`,
      "jev_http_error",
    );
  }
}

export function invalidJevResponse(
  message: string,
  usage: JevTokenUsage | null = null,
): JevOutputError {
  return new JevOutputError(message, "selector_invalid_response", usage);
}

async function fetchSystemOne(
  request: unknown,
  config: ResolvedJevConfig,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  try {
    return await fetch(`${config.endpoint}/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new RouterFrameworkError(
      "policy",
      `Jev request failed: ${error instanceof Error ? error.message : String(error)}`,
      "jev_request_failed",
      undefined,
      { cause: error },
    );
  }
}

function retryDelayMs(retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  if (retryAfter === null || !Number.isFinite(seconds) || seconds <= 0) return JEV_RETRY_DELAY_MS;
  return Math.min(seconds * 1000, JEV_RETRY_MAX_DELAY_MS);
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function configurationError(message: string, param: string): RouterCoreError {
  return new RouterCoreError("configuration", message, "jev_configuration_invalid", param);
}
