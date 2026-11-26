import type { ClientHarness } from "../types.js";

export const CLIENT_HARNESS_HEADER = "x-dari-client-harness";

export const CLIENT_HARNESSES: readonly string[] = [
  "claude_code",
  "codex",
  "muse_code",
  "opencode",
  "pi",
  "openclaw",
  "hermes",
] satisfies ClientHarness[];

// The headers a coding agent names itself with: Claude Code's user agent,
// app, session, and betas, and Muse Code's client id.
const CLIENT_HEADERS = ["user-agent", "x-app", "x-claude-code-session-id", "anthropic-beta", "x-client-id"];

/**
 * The headers of `CLIENT_HEADERS` the request carries, as the client sent
 * them, so hosted Dari serving it for a connected gateway sees the same client.
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
  return named === "claude_code" || named === "muse_code" ? undefined : named;
}
