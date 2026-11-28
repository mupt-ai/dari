import { isRecord } from "@mupt-ai/dari-router/policy-engine";

import { HttpError } from "../http/errors.js";
import type { AgentRequestContext, InteractionRequestPurpose } from "../interaction/types.js";
import { boundedIdentity, uuidIdentity } from "../runtime/harness_identity/ids.js";
import type { HarnessConversationIdentity } from "../runtime/harness_identity/conversation.js";
import type { Harness } from "./index.js";

export const codex = {
  id: "codex",
  headers: ["x-codex-turn-metadata", "thread-id"],
} as const satisfies Harness;

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
  // Clients can carry a stale projection after a resume or fork. Conflicts
  // must not fail the request, and fields must not mix across projections:
  // take thread, turn, and parent from one turn metadata projection, header
  // first, falling back to the standalone thread fields only for the thread.
  const entry = turnMetadata.find((metadata) => metadata.thread_id !== undefined)
    ?? turnMetadata[0]!;
  const threadId = uuidIdentity(entry.thread_id, "x-codex-turn-metadata.thread_id")
    ?? uuidIdentity(headers.get("thread-id"), "thread-id")
    ?? uuidIdentity(clientMetadata?.thread_id, "client_metadata.thread_id");
  if (threadId === undefined) {
    return undefined;
  }
  const userTurnId = uuidIdentity(entry.turn_id, "x-codex-turn-metadata.turn_id");
  const parentThreadId = uuidIdentity(entry.parent_thread_id,
    "x-codex-turn-metadata.parent_thread_id");
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
  // Classify from one projection, header first, skipping one that omits the
  // request kind so a partial header falls back to a complete body.
  const entry = metadata.find((candidate) => candidate.request_kind !== undefined)
    ?? metadata[0]!;
  const kind = entry.request_kind;
  const agentKind = entry.subagent_kind;
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
