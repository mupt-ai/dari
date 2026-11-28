import { CLIENT_HARNESSES, HARNESSES, OWN_PLAN_HARNESSES, type ClientHarness } from "../harnesses/index.js";

export const CLIENT_HARNESS_HEADER = "x-dari-client-harness";

// Every coding agent's own headers. harness_request.ts reads every one of them.
const CLIENT_HEADERS = HARNESSES.flatMap((harness) => harness.headers);

/**
 * The headers of `CLIENT_HEADERS` the request carries, as the client sent
 * them, so hosted Dari serving it for a connected gateway sees the same
 * agent, session, and kind of request.
 */
export function clientHeaders(headers: Headers): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of CLIENT_HEADERS) {
    const value = headers.get(name);
    if (value !== null) found[name] = value;
  }
  return found;
}

/**
 * The coding agent `x-dari-client-harness` names, as the Dari CLI does for a
 * model list. The header is a claim, not proof.
 */
export function namedClientHarness(headers: Headers): ClientHarness | undefined {
  const value = headers.get(CLIENT_HARNESS_HEADER)?.trim();
  return value !== undefined && CLIENT_HARNESSES.includes(value) ? (value as ClientHarness) : undefined;
}

/**
 * The coding agent a request with none of an agent's own headers claims to
 * come from. A Claude Code or Muse Code plan serves only that agent, so a
 * claim never names those two.
 */
export function claimedClientHarness(headers: Headers): ClientHarness | undefined {
  const named = namedClientHarness(headers);
  return named === undefined || OWN_PLAN_HARNESSES.includes(named) ? undefined : named;
}
