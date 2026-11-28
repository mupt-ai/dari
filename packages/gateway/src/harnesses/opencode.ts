import type { AgentRequestClass, AgentRequestContext } from "../interaction/types.js";
import { boundedIdentity } from "../runtime/harness_identity/ids.js";
import type { Harness } from "./index.js";

export const opencode = {
  id: "opencode",
  // With the `dari opencode` plugin's request kind and agent.
  headers: [
    "x-opencode-session-id",
    "x-opencode-parent-session-id",
    "x-opencode-request-kind",
    "x-opencode-agent",
    "x-session-affinity",
  ],
} as const satisfies Harness;

// OpenCode names the session behind every request, and a subagent's parent
// session too. The `dari opencode` plugin adds the request kind and agent,
// which OpenCode does not send itself. Like Claude Code's headers, these are
// client-supplied routing hints, never inferred from prompt text.
export function openCodeRequestContext(headers: Headers): AgentRequestContext | undefined {
  if (boundedIdentity(headers.get("x-opencode-session-id"), "x-opencode-session-id") === undefined) {
    return undefined;
  }
  const kind = headers.get("x-opencode-request-kind")?.trim();
  const subagentId = openCodeSubagentId(headers);
  const requestClass: AgentRequestClass = kind === "compaction" ? "compaction"
    : kind === "title" || kind === "generate" ? "auxiliary"
    : subagentId === undefined ? "main" : "subagent";
  return {
    requestClass,
    ...(subagentId === undefined ? {} : {
      agentId: subagentId,
      parentAgentId: boundedIdentity(
        headers.get("x-opencode-parent-session-id"),
        "x-opencode-parent-session-id",
      ),
    }),
    agentType: boundedIdentity(headers.get("x-opencode-agent"), "x-opencode-agent"),
  };
}

export function openCodeSubagentId(headers: Headers): string | undefined {
  const parent = boundedIdentity(
    headers.get("x-opencode-parent-session-id"),
    "x-opencode-parent-session-id",
  );
  return parent === undefined
    ? undefined
    : boundedIdentity(headers.get("x-opencode-session-id"), "x-opencode-session-id");
}
