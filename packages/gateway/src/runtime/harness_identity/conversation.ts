import { createHash } from "node:crypto";

import type { SourceProtocol } from "../../interaction/types.js";

export type HarnessConversationIdentity =
  | {
      kind: "codex_thread";
      value: string;
      parentThreadId?: string;
      qualifiers?: string[];
      userTurnId?: string;
    }
  | {
      kind: "claude_code_session";
      value: string;
      qualifiers?: string[];
    }
  | {
      kind: "openai_chat_session";
      value: string;
      qualifiers?: string[];
    }
  | {
      kind: "muse_code_thread";
      value: string;
      qualifiers?: string[];
    };

export type HarnessConversationScope = {
  organizationId: string;
  routerId: string;
  apiKeyId: string | null;
  attributedUserId: string | null;
};

const PREFIX = "hconv_";
// The conversation id is the fallback provider prompt_cache_key for callers
// that send none (Codex sends thread metadata, not a cache key). OpenAI rejects
// a prompt_cache_key longer than 64 characters, so the id must fit that budget.
const MAX_CONVERSATION_ID_CHARS = 64;
const DIGEST_CHARS = MAX_CONVERSATION_ID_CHARS - PREFIX.length;

export function scopedHarnessSessionId(args: {
  identity: HarnessConversationIdentity;
  sourceProtocol: SourceProtocol;
  scope: HarnessConversationScope;
}): string {
  const identity = args.identity.kind === "codex_thread" && args.identity.parentThreadId
    ? { ...args.identity, value: args.identity.parentThreadId }
    : args.identity;
  return scopedHarnessId({ ...args, identity });
}

// One agent of a session: the main agent on the bare session, each subagent
// on its own qualifier or thread. Unlike the conversation id, it survives
// compaction.
export function scopedHarnessAgentId(args: {
  identity: HarnessConversationIdentity;
  sourceProtocol: SourceProtocol;
  scope: HarnessConversationScope;
}): string {
  return scopedHarnessId(args);
}

export function scopedHarnessConversationId(args: {
  identity: HarnessConversationIdentity;
  sourceProtocol: SourceProtocol;
  scope: HarnessConversationScope;
  conversationPrefix: string;
}): string {
  return scopedHarnessId(args, args.conversationPrefix);
}

function scopedHarnessId(
  args: {
    identity: HarnessConversationIdentity;
    sourceProtocol: SourceProtocol;
    scope: HarnessConversationScope;
  },
  conversationPrefix?: string,
): string {
  const subject = args.scope.apiKeyId !== null
    ? ["api_key", args.scope.apiKeyId]
    : args.scope.attributedUserId !== null
      ? ["user", args.scope.attributedUserId]
      : ["organization_runtime", args.scope.organizationId];
  const identity = [
    args.identity.kind,
    args.identity.value,
    ...(args.identity.qualifiers ?? []),
  ];
  const digest = createHash("sha256")
    .update(JSON.stringify([
      args.scope.organizationId,
      args.scope.routerId,
      subject,
      args.sourceProtocol,
      ...identity,
      ...(conversationPrefix === undefined ? [] : [conversationPrefix]),
    ]))
    .digest("hex");
  return `${PREFIX}${digest.slice(0, DIGEST_CHARS)}`;
}
