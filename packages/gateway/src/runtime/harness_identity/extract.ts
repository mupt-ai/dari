import { openCodeSubagentId } from "../../harnesses/opencode.js";
import type { HarnessConversationIdentity } from "./conversation.js";
import { boundedIdentity } from "./ids.js";

export function chatCompletionsConversationIdentity(
  headers: Headers,
  promptCacheKey?: string,
): HarnessConversationIdentity | undefined {
  // Pi summaries use fresh cache/affinity IDs. Its explicit session header
  // groups them with the main turns without changing provider cache affinity.
  // Other callers use x-session-affinity, falling back to prompt_cache_key.
  const sessionId = boundedIdentity(headers.get("x-pi-session-id"), "x-pi-session-id") ?? boundedIdentity(
    headers.get("x-session-affinity"),
    "x-session-affinity",
  ) ?? boundedIdentity(promptCacheKey, "prompt_cache_key");
  if (sessionId === undefined) return undefined;
  // OpenCode sends a subagent's parent session as its affinity, so subagents
  // share the parent's session. Scope each one to its own composite identity,
  // as Claude Code subagents are, so it keeps its own conversation and lease.
  const subagentId = openCodeSubagentId(headers);
  return {
    kind: "openai_chat_session",
    value: sessionId,
    ...(subagentId === undefined ? {} : { qualifiers: [subagentId] }),
  };
}
