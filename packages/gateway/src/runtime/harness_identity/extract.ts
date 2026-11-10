import { isRecord } from "@mupt-ai/dari-router/policy-engine";

import { HttpError } from "../../http/errors.js";
import type {
  AgentRequestClass,
  AgentRequestContext,
  InteractionRequestPurpose,
} from "../../interaction/types.js";
import type { HarnessConversationIdentity } from "./conversation.js";

const MAX_ID_CHARS = 200;

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

export function piRequestContext(headers: Headers): AgentRequestContext | undefined {
  if (boundedIdentity(headers.get("x-pi-session-id"), "x-pi-session-id") === undefined) {
    return undefined;
  }
  const kind = headers.get("x-pi-request-kind")?.trim();
  return {
    requestClass: kind === "turn" ? "main" : kind === "compaction" ? "compaction" : "unknown",
  };
}

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

function openCodeSubagentId(headers: Headers): string | undefined {
  const parent = boundedIdentity(
    headers.get("x-opencode-parent-session-id"),
    "x-opencode-parent-session-id",
  );
  return parent === undefined
    ? undefined
    : boundedIdentity(headers.get("x-opencode-session-id"), "x-opencode-session-id");
}

export function codexConversationIdentity(
  headers: Headers,
  payload: Record<string, unknown>,
): HarnessConversationIdentity | undefined {
  const clientMetadata = isRecord(payload.client_metadata)
    ? payload.client_metadata
    : undefined;
  const turnMetadata = codexTurnMetadataCollection(headers, payload);
  if (turnMetadata.length === 0) {
    return undefined;
  }
  const candidates = [
    ...turnMetadata.map((metadata) => uuidIdentity(
      metadata.thread_id,
      "x-codex-turn-metadata.thread_id",
    )),
    uuidIdentity(headers.get("thread-id"), "thread-id"),
    uuidIdentity(clientMetadata?.thread_id, "client_metadata.thread_id"),
  ].filter((value): value is string => value !== undefined);
  if (candidates.length === 0) {
    return undefined;
  }
  const [threadId] = candidates;
  if (candidates.some((candidate) => candidate !== threadId)) {
    throw new HttpError(
      400,
      "Codex thread identity fields must agree.",
      "invalid_request_error",
      "thread-id",
    );
  }
  const userTurnIds = turnMetadata
    .map((metadata) => uuidIdentity(
      metadata.turn_id,
      "x-codex-turn-metadata.turn_id",
    ))
    .filter((value): value is string => value !== undefined);
  const [userTurnId] = userTurnIds;
  if (userTurnIds.some((candidate) => candidate !== userTurnId)) {
    throw new HttpError(
      400,
      "Codex turn identity fields must agree.",
      "invalid_request_error",
      "x-codex-turn-metadata.turn_id",
    );
  }
  const parentThreadIds = turnMetadata
    .map((metadata) => uuidIdentity(metadata.parent_thread_id,
      "x-codex-turn-metadata.parent_thread_id"))
    .filter((value): value is string => value !== undefined);
  const [parentThreadId] = parentThreadIds;
  if (parentThreadIds.some((candidate) => candidate !== parentThreadId)) {
    throw new HttpError(400, "Codex parent thread identity fields must agree.",
      "invalid_request_error", "x-codex-turn-metadata.parent_thread_id");
  }
  return {
    kind: "codex_thread",
    value: threadId,
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    ...(userTurnId === undefined ? {} : { userTurnId }),
  };
}

export function codexRequestPurpose(
  headers: Headers,
  payload: Record<string, unknown>,
): InteractionRequestPurpose | undefined {
  const turnMetadata = codexTurnMetadataCollection(headers, payload);
  return turnMetadata.length > 0 && turnMetadata.every(isCodexMemoryExtraction)
    ? "memory_extraction"
    : undefined;
}

export function codexRequestContext(
  headers: Headers,
  payload: Record<string, unknown>,
): AgentRequestContext | undefined {
  const metadata = codexTurnMetadataCollection(headers, payload);
  if (metadata.length === 0) return undefined;
  // HTTP and body projections must agree before either can classify a turn.
  const kinds = new Set(metadata.map((entry) => entry.request_kind));
  const agents = new Set(metadata.map((entry) => entry.subagent_kind));
  if (kinds.size > 1 || agents.size > 1) {
    throw new HttpError(400, "Codex request classification fields must agree.",
      "invalid_request_error", "x-codex-turn-metadata");
  }
  const [kind] = kinds;
  const [agentKind] = agents;
  const entry = metadata[0]!;
  const agentId = uuidIdentity(entry.thread_id, "x-codex-turn-metadata.thread_id");
  const requestClass = kind === "compaction" ? "compaction"
    : kind === "memory" || kind === "prewarm" ? "auxiliary"
    : kind === "turn" && agentKind === "memory_consolidation" ? "auxiliary"
    : kind === "turn" && agentKind === "compact" ? "compaction"
    : kind === "turn" && agentKind !== undefined ? "subagent"
    : kind === "turn" ? "main" : "unknown";
  return {
    requestClass,
    ...(requestClass === "subagent" && agentId !== undefined ? { agentId } : {}),
    parentAgentId: uuidIdentity(entry.parent_thread_id, "x-codex-turn-metadata.parent_thread_id"),
    agentType: boundedIdentity(agentKind, "x-codex-turn-metadata.subagent_kind"),
  };
}

// Muse Code sends its thread on every Responses request. The main agent's
// thread is its session, and each subagent has its own thread, so each keeps
// its own conversation and lease.
export function museCodeConversationIdentity(
  headers: Headers,
): HarnessConversationIdentity | undefined {
  const threadId = boundedIdentity(headers.get("x-tbh-thread-id"), "x-tbh-thread-id");
  return threadId === undefined ? undefined : { kind: "muse_code_thread", value: threadId };
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
  const [sessionId] = candidates;
  if (candidates.some((candidate) => candidate !== sessionId)) {
    throw new HttpError(
      400,
      "Claude Code session identity fields must agree.",
      "invalid_request_error",
      "x-claude-code-session-id",
    );
  }
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

function isCodexMemoryExtraction(
  metadata: Record<string, unknown>,
): boolean {
  if (
    metadata.request_kind !== "memory" ||
    metadata.thread_source !== "memory_consolidation"
  ) {
    return false;
  }
  // Codex deliberately omits canonical turn identity for detached phase-1
  // memory jobs, while compatibility projections still carry the live root
  // thread UUID. Phase-2 consolidation agents use ordinary turn metadata and
  // their own thread identities, so they do not match this shape.
  return [
    "session_id",
    "thread_id",
    "turn_id",
    "root_turn_id",
    "window_id",
    "forked_from_thread_id",
  ].every((field) => metadata[field] === undefined);
}

function codexTurnMetadataCollection(
  headers: Headers,
  payload: Record<string, unknown>,
): Record<string, unknown>[] {
  const clientMetadata = isRecord(payload.client_metadata)
    ? payload.client_metadata
    : undefined;
  return [
    codexTurnMetadata(
      headers.get("x-codex-turn-metadata"),
      "x-codex-turn-metadata",
    ),
    codexTurnMetadata(
      clientMetadata?.["x-codex-turn-metadata"],
      "client_metadata.x-codex-turn-metadata",
    ),
  ].filter((value): value is Record<string, unknown> => value !== undefined);
}

function boundedIdentity(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(
      400,
      `${field} must be a string.`,
      "invalid_request_error",
      field,
    );
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > MAX_ID_CHARS) {
    throw new HttpError(
      400,
      `${field} must not exceed ${MAX_ID_CHARS} characters.`,
      "invalid_request_error",
      field,
    );
  }
  return normalized;
}

function uuidIdentity(value: unknown, field: string): string | undefined {
  const normalized = boundedIdentity(value, field);
  if (normalized === undefined) return undefined;
  const canonical = normalized.toLowerCase();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(canonical)) {
    throw new HttpError(
      400,
      `${field} must be a UUID.`,
      "invalid_request_error",
      field,
    );
  }
  return canonical;
}

function codexTurnMetadata(
  raw: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new HttpError(
      400,
      `${field} must be a JSON string.`,
      "invalid_request_error",
      field,
    );
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new HttpError(
      400,
      `${field} must contain a JSON object.`,
      "invalid_request_error",
      field,
    );
  }
}
