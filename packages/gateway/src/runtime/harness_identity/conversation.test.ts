import { expect, test } from "bun:test";

import {
  scopedHarnessConversationId,
  scopedHarnessSessionId,
  type HarnessConversationScope,
} from "./conversation.js";

const SCOPE: HarnessConversationScope = {
  organizationId: "org_1",
  routerId: "rtr_canonical",
  apiKeyId: "oak_1",
  attributedUserId: "usr_1",
};

const THREAD_ID = "019f930c-1ddf-7692-9c16-d09acb4e98fb";

test("scoped conversation ids are deterministic, opaque, and tenant-bound", () => {
  const identity = { kind: "codex_thread", value: THREAD_ID } as const;
  const first = scopedHarnessConversationId({
    identity,
    sourceProtocol: "openai_responses",
    scope: SCOPE,
    conversationPrefix: "prefix-1",
  });
  const repeated = scopedHarnessConversationId({
    identity,
    sourceProtocol: "openai_responses",
    scope: SCOPE,
    conversationPrefix: "prefix-1",
  });
  const otherKey = scopedHarnessConversationId({
    identity,
    sourceProtocol: "openai_responses",
    scope: { ...SCOPE, apiKeyId: "oak_2" },
    conversationPrefix: "prefix-1",
  });
  const otherProtocol = scopedHarnessConversationId({
    identity,
    sourceProtocol: "anthropic_messages",
    scope: SCOPE,
    conversationPrefix: "prefix-1",
  });
  const otherOrganization = scopedHarnessConversationId({
    identity,
    sourceProtocol: "openai_responses",
    scope: { ...SCOPE, organizationId: "org_2" },
    conversationPrefix: "prefix-1",
  });
  const otherRouter = scopedHarnessConversationId({
    identity,
    sourceProtocol: "openai_responses",
    scope: { ...SCOPE, routerId: "rtr_other" },
    conversationPrefix: "prefix-1",
  });

  expect(first).toBe(repeated);
  expect(first).toMatch(/^hconv_[0-9a-f]{58}$/);
  // The id doubles as the provider prompt_cache_key when the caller sends
  // none; OpenAI rejects keys longer than 64 characters.
  expect(first.length).toBeLessThanOrEqual(64);
  expect(first).not.toContain(identity.value);
  expect(otherKey).not.toBe(first);
  expect(otherProtocol).not.toBe(first);
  expect(otherOrganization).not.toBe(first);
  expect(otherRouter).not.toBe(first);
});

test("session ids survive compaction while conversation ids separate context runs", () => {
  const identity = { kind: "claude_code_session", value: THREAD_ID } as const;
  const session = scopedHarnessSessionId({
    identity,
    sourceProtocol: "anthropic_messages",
    scope: SCOPE,
  });
  const repeatedSession = scopedHarnessSessionId({
    identity,
    sourceProtocol: "anthropic_messages",
    scope: SCOPE,
  });
  const firstRun = scopedHarnessConversationId({
    identity,
    sourceProtocol: "anthropic_messages",
    scope: SCOPE,
    conversationPrefix: "prefix-before-compaction",
  });
  const compactedRun = scopedHarnessConversationId({
    identity,
    sourceProtocol: "anthropic_messages",
    scope: SCOPE,
    conversationPrefix: "prefix-after-compaction",
  });

  expect(session).toBe(repeatedSession);
  expect(session).toMatch(/^hconv_[0-9a-f]{58}$/);
  expect(firstRun).not.toBe(compactedRun);
  expect(session).not.toBe(firstRun);
});

test("conversation prefixes separate unrelated work within one harness session", () => {
  const identity = { kind: "claude_code_session", value: THREAD_ID } as const;
  const first = scopedHarnessConversationId({
    identity,
    sourceProtocol: "anthropic_messages",
    scope: SCOPE,
    conversationPrefix: "prefix-1",
  });
  const repeated = scopedHarnessConversationId({
    identity,
    sourceProtocol: "anthropic_messages",
    scope: SCOPE,
    conversationPrefix: "prefix-1",
  });
  const unrelated = scopedHarnessConversationId({
    identity,
    sourceProtocol: "anthropic_messages",
    scope: SCOPE,
    conversationPrefix: "prefix-2",
  });

  expect(first).toBe(repeated);
  expect(unrelated).not.toBe(first);
});

test("Claude Code subagents are separate from their parent and each other", () => {
  const main = scopedHarnessConversationId({
    identity: { kind: "claude_code_session", value: THREAD_ID },
    sourceProtocol: "anthropic_messages",
    scope: SCOPE,
    conversationPrefix: "prefix-1",
  });
  const firstSubagent = scopedHarnessConversationId({
    identity: {
      kind: "claude_code_session",
      value: THREAD_ID,
      qualifiers: ["a176918a3b6ce544b"],
    },
    sourceProtocol: "anthropic_messages",
    scope: SCOPE,
    conversationPrefix: "prefix-1",
  });
  const repeatedSubagent = scopedHarnessConversationId({
    identity: {
      kind: "claude_code_session",
      value: THREAD_ID,
      qualifiers: ["a176918a3b6ce544b"],
    },
    sourceProtocol: "anthropic_messages",
    scope: SCOPE,
    conversationPrefix: "prefix-1",
  });
  const otherSubagent = scopedHarnessConversationId({
    identity: {
      kind: "claude_code_session",
      value: THREAD_ID,
      qualifiers: ["b176918a3b6ce544b"],
    },
    sourceProtocol: "anthropic_messages",
    scope: SCOPE,
    conversationPrefix: "prefix-1",
  });

  expect(firstSubagent).toBe(repeatedSubagent);
  expect(firstSubagent).not.toBe(main);
  expect(otherSubagent).not.toBe(firstSubagent);
});

test("runtime-token identities are scoped to their effective user or organization", () => {
  const identity = { kind: "claude_code_session", value: THREAD_ID } as const;
  const user = scopedHarnessConversationId({
    identity,
    sourceProtocol: "anthropic_messages",
    scope: { ...SCOPE, apiKeyId: null },
    conversationPrefix: "prefix-1",
  });
  const otherUser = scopedHarnessConversationId({
    identity,
    sourceProtocol: "anthropic_messages",
    scope: { ...SCOPE, apiKeyId: null, attributedUserId: "usr_2" },
    conversationPrefix: "prefix-1",
  });
  const organizationRuntime = scopedHarnessConversationId({
    identity,
    sourceProtocol: "anthropic_messages",
    scope: { ...SCOPE, apiKeyId: null, attributedUserId: null },
    conversationPrefix: "prefix-1",
  });

  expect(otherUser).not.toBe(user);
  expect(organizationRuntime).not.toBe(user);
});


test("Codex child threads share the parent browsing session, never routing identity", () => {
  const common = { sourceProtocol: "openai_responses" as const, scope: SCOPE };
  const main = { kind: "codex_thread" as const, value: THREAD_ID };
  const child = { ...main, value: "11111111-2222-4333-8444-555555555555", parentThreadId: THREAD_ID };
  const sibling = { ...child, value: "22222222-2222-4333-8444-555555555555" };
  const session = scopedHarnessSessionId({ ...common, identity: main });
  expect(scopedHarnessSessionId({ ...common, identity: child })).toBe(session);
  expect(scopedHarnessSessionId({ ...common, identity: sibling })).toBe(session);
  const route = (identity: typeof main) => scopedHarnessConversationId({
    ...common, identity, conversationPrefix: "same-history",
  });
  expect(route(child)).not.toBe(route(main));
  expect(route(child)).not.toBe(route(sibling));
  expect(scopedHarnessSessionId({ ...common, identity: child,
    scope: { ...SCOPE, apiKeyId: "other-key" } })).not.toBe(session);
});
