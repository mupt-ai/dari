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

// The headers a coding agent describes itself and each request with: which
// agent it is, its session, and what the request is for. harness_request.ts
// reads every one of them.
const CLIENT_HEADERS = [
  // Claude Code
  "user-agent",
  "x-app",
  "anthropic-beta",
  "x-claude-code-session-id",
  "x-claude-code-request-class",
  "x-claude-code-agent-id",
  "x-claude-code-parent-agent-id",
  "x-claude-code-agent-type",
  // Codex
  "x-codex-turn-metadata",
  "thread-id",
  // Muse Code
  "x-client-id",
  "x-tbh-thread-id",
  // OpenCode, with the `dari opencode` plugin's request kind and agent
  "x-opencode-session-id",
  "x-opencode-parent-session-id",
  "x-opencode-request-kind",
  "x-opencode-agent",
  "x-session-affinity",
  // Pi
  "x-pi-session-id",
  "x-pi-request-kind",
];

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
  return named === "claude_code" || named === "muse_code" ? undefined : named;
}
