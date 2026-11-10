import { HttpError } from "../../http/errors.js";
import type { AgentRequestContext, AgentRequestClass } from "../../interaction/types.js";

const REQUEST_CLASSES = new Set<AgentRequestClass>([
  "main", "subagent", "workflow", "auxiliary", "compaction", "side_reply",
]);

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
