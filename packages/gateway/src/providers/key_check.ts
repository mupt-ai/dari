import { getBuiltinModels } from "@mupt-ai/pi-ai/providers/all";

const CHECK_TIMEOUT_MS = 10_000;

/**
 * - `valid`: the provider accepted the key.
 * - `rejected`: the provider refused it (401 or 403).
 * - `unchecked`: no answer either way, such as a network error, an outage, or
 *   a provider without a known check. Callers treat this as not rejected so a
 *   provider outage never blocks a key.
 */
export type ProviderKeyCheckResult =
  | { result: "valid" }
  | { result: "rejected"; status: number }
  | { result: "unchecked" };

// A provider endpoint outside the model catalog, such as a self-run server.
export type ProviderKeyEndpoint = { api: string; baseUrl: string };

/**
 * Ask a provider whether an API key works, with the cheapest authenticated
 * request its wire API offers: list models, or, where listing models needs
 * no key, an endpoint that does. The self-hosted gateway runs this at startup
 * and the hosted control plane before it saves a key.
 */
export async function checkProviderKey(args: {
  provider: string;
  key: string;
  endpoint?: ProviderKeyEndpoint;
  fetch: typeof fetch;
}): Promise<ProviderKeyCheckResult> {
  const check = keyCheckRequest(args.provider, args.key, args.endpoint);
  if (check === null) return { result: "unchecked" };
  try {
    const response = await args.fetch(check.url, {
      headers: check.headers,
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) {
      return { result: "rejected", status: response.status };
    }
    return response.ok ? { result: "valid" } : { result: "unchecked" };
  } catch {
    return { result: "unchecked" };
  }
}

function keyCheckRequest(
  provider: string,
  key: string,
  endpoint: ProviderKeyEndpoint | undefined,
): { url: string; headers: Record<string, string> } | null {
  const bearer = { authorization: `Bearer ${key}` };
  if (endpoint === undefined) {
    if (provider === "openrouter") return { url: "https://openrouter.ai/api/v1/key", headers: bearer };
    if (provider === "vercel-ai-gateway") return { url: "https://ai-gateway.vercel.sh/v1/credits", headers: bearer };
  }
  const target = endpoint
    ?? (getBuiltinModels(provider as never) as unknown as ProviderKeyEndpoint[] | undefined)?.[0];
  if (target === undefined || !URL.canParse(target.baseUrl)) return null;
  const base = target.baseUrl.replace(/\/+$/, "");
  switch (target.api) {
    case "anthropic-messages":
      return { url: `${base}/v1/models`, headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } };
    case "google-generative-ai":
      return { url: `${base}/models`, headers: { "x-goog-api-key": key } };
    case "mistral-conversations":
      return { url: `${base}/v1/models`, headers: bearer };
    case "openai-completions":
    case "openai-responses":
      return { url: `${base}/models`, headers: bearer };
    default:
      return null;
  }
}
