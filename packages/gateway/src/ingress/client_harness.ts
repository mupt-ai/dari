import type { ClientHarness } from "../types.js";

const CLIENT_HARNESS_HEADER = "x-dari-client-harness";

export const CLIENT_HARNESSES: readonly string[] = [
  "claude_code",
  "codex",
  "muse_code",
  "opencode",
  "pi",
  "openclaw",
  "hermes",
] satisfies ClientHarness[];

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
