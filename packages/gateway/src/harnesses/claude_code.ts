import { HttpError } from "../http/errors.js";
import type { AgentRequestContext, AgentRequestClass } from "../interaction/types.js";
import { boundedIdentity, uuidIdentity } from "../runtime/harness_identity/ids.js";
import type { HarnessConversationIdentity } from "../runtime/harness_identity/conversation.js";
import type { Harness } from "./index.js";

export const claudeCode = {
  id: "claude_code",
  headers: [
    "user-agent",
    "x-app",
    "anthropic-beta",
    "x-claude-code-session-id",
    "x-claude-code-request-class",
    "x-claude-code-agent-id",
    "x-claude-code-parent-agent-id",
    "x-claude-code-agent-type",
  ],
  // A Claude Code plan serves only Claude Code.
  ownPlanOnly: true,
} as const satisfies Harness;

const REQUEST_CLASSES = new Set<AgentRequestClass>([
  "main", "subagent", "workflow", "auxiliary", "compaction", "side_reply",
]);

const LEGACY_CLAUDE_CODE_BETA = "claude-code-20250219";

/** Whether a request carries Claude Code's own headers. */
export function isClaudeCodeRequest(headers: Headers): boolean {
  const userAgent = headers.get("user-agent")?.trim().toLowerCase() ?? "";
  const app = headers.get("x-app")?.trim().toLowerCase();
  const betas = (headers.get("anthropic-beta") ?? "").toLowerCase().split(",").map((beta) => beta.trim());
  return (
    userAgent.startsWith("claude-cli/") &&
    (app === "cli" || app === "cli-bg") &&
    (
      Boolean(headers.get("x-claude-code-session-id")?.trim()) ||
      betas.includes(LEGACY_CLAUDE_CODE_BETA)
    )
  );
}

// These are client-supplied routing hints, not authentication claims. Never
// infer them from prompt text: a user can legitimately paste any such prompt.
export function claudeCodeRequestContext(headers: Headers): AgentRequestContext {
  const value = headers.get("x-claude-code-request-class")?.trim();
  const requestClass = REQUEST_CLASSES.has(value as AgentRequestClass)
    ? value as AgentRequestClass
    : "unknown";
  const agentId = identifier(headers, "x-claude-code-agent-id");
  if ((requestClass === "subagent" || requestClass === "workflow") && !agentId) {
    throw new HttpError(400, "Agent requests require x-claude-code-agent-id.",
      "invalid_request_error", "x-claude-code-agent-id");
  }
  return {
    requestClass,
    ...(agentId === undefined ? {} : { agentId }),
    parentAgentId: identifier(headers, "x-claude-code-parent-agent-id"),
    agentType: identifier(headers, "x-claude-code-agent-type"),
  };
}

function identifier(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim();
  if (!value) return undefined;
  if (value.length > 200) {
    throw new HttpError(400, `${name} must not exceed 200 characters.`,
      "invalid_request_error", name);
  }
  return value;
}

export function claudeCodeConversationIdentity(
  headers: Headers,
  metadataSessionId?: string,
): HarnessConversationIdentity | undefined {
  const candidates = [
    uuidIdentity(
      headers.get("x-claude-code-session-id"),
      "x-claude-code-session-id",
    ),
    uuidIdentity(
      metadataSessionId,
      "metadata.user_id.session_id",
    ),
  ].filter((value): value is string => value !== undefined);
  if (candidates.length === 0) return undefined;
  // Claude Code can carry a stale metadata session after a resume or fork.
  // The header names the live session, so it wins over the metadata.
  const [sessionId] = candidates;
  // Claude Code reuses the parent session UUID for every subagent, but gives
  // each subagent a stable agent header. Keep the parent thread on the bare
  // session identity and scope each subagent to its own composite identity.
  // Treat this as an opaque Claude identifier. Besides ordinary subagent IDs,
  // Claude may send labeled agents or Agent Teams identities such as
  // `reviewer@backend`; Dari only needs a stable, bounded value to hash.
  const agentId = boundedIdentity(
    headers.get("x-claude-code-agent-id"),
    "x-claude-code-agent-id",
  );
  return {
    kind: "claude_code_session",
    value: sessionId,
    ...(agentId === undefined ? {} : { qualifiers: [agentId] }),
  };
}
