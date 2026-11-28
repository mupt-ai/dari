import type { AgentRequestContext } from "../interaction/types.js";
import { boundedIdentity } from "../runtime/harness_identity/ids.js";
import type { Harness } from "./index.js";

export const pi = {
  id: "pi",
  headers: ["x-pi-session-id", "x-pi-request-kind"],
} as const satisfies Harness;

export function piRequestContext(headers: Headers): AgentRequestContext | undefined {
  if (boundedIdentity(headers.get("x-pi-session-id"), "x-pi-session-id") === undefined) {
    return undefined;
  }
  const kind = headers.get("x-pi-request-kind")?.trim();
  return {
    requestClass: kind === "turn" ? "main"
      : kind === "compaction" ? "compaction"
      // The Dari extension's web search tool: one request beside the turn,
      // served as background work like Claude Code's own search.
      : kind === "search" ? "auxiliary"
      : "unknown",
  };
}

// OpenCode names the session behind every request, and a subagent's parent
// session too. The `dari opencode` plugin adds the request kind and agent,
// which OpenCode does not send itself. Like Claude Code's headers, these are
// client-supplied routing hints, never inferred from prompt text.
