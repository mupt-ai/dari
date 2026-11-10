import { expect, test } from "bun:test";

import {
  chatCompletionsConversationIdentity,
  claudeCodeConversationIdentity,
  codexConversationIdentity,
  codexRequestPurpose,
  openCodeRequestContext,
} from "./extract.js";

const THREAD_ID = "019f930c-1ddf-7692-9c16-d09acb4e98fb";
const OTHER_THREAD_ID = "019f930c-9394-7ca2-b53b-fde828de11ff";
const TURN_ID = "019f930c-d1bb-75c3-a04d-5748442c220e";
const OTHER_TURN_ID = "019f930c-ee08-7490-b06e-8f51fa605e09";
const CLAUDE_AGENT_ID = "a176918a3b6ce544b";

test("Codex identity accepts agreeing canonical, header, and flat thread projections", () => {
  expect(codexConversationIdentity(
    new Headers({
      "thread-id": THREAD_ID,
      "session-id": "session-header",
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: THREAD_ID,
        turn_id: TURN_ID,
      }),
    }),
    {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: THREAD_ID,
          turn_id: TURN_ID,
        }),
        thread_id: THREAD_ID,
        session_id: "session-metadata",
      },
    },
  )).toEqual({
    kind: "codex_thread",
    value: THREAD_ID,
    userTurnId: TURN_ID,
  });
});

test("Codex identity accepts individual thread projections", () => {
  expect(codexConversationIdentity(
    new Headers(),
    {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: THREAD_ID }),
      },
    },
  )).toEqual({ kind: "codex_thread", value: THREAD_ID });

  expect(codexConversationIdentity(
    new Headers({
      "thread-id": THREAD_ID,
      "x-codex-turn-metadata": JSON.stringify({}),
    }),
    {},
  )).toEqual({ kind: "codex_thread", value: THREAD_ID });
});

test("Codex identifies detached phase-1 memory extraction metadata", () => {
  const memoryMetadata = JSON.stringify({
    request_kind: "memory",
    thread_source: "memory_consolidation",
  });
  expect(codexRequestPurpose(
    new Headers({
      "thread-id": THREAD_ID,
      "x-codex-turn-metadata": memoryMetadata,
    }),
    {
      client_metadata: {
        "x-codex-turn-metadata": memoryMetadata,
        thread_id: THREAD_ID,
      },
    },
  )).toBe("memory_extraction");
});

test("Codex does not classify ordinary memory-consolidation turns as extraction", () => {
  expect(codexRequestPurpose(
    new Headers({
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn",
        thread_source: "memory_consolidation",
        thread_id: THREAD_ID,
      }),
    }),
    {},
  )).toBeUndefined();

  expect(codexRequestPurpose(
    new Headers({
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "memory",
        thread_source: "memory_consolidation",
        thread_id: THREAD_ID,
      }),
    }),
    {},
  )).toBeUndefined();
});

test("generic Responses metadata and Codex session ids are not conversation identities", () => {
  expect(codexConversationIdentity(
    new Headers({
      "thread-id": THREAD_ID,
      "session-id": "session-header",
    }),
    {
      client_metadata: {
        thread_id: THREAD_ID,
        session_id: "session-metadata",
      },
    },
  )).toBeUndefined();
});

test("Codex rejects malformed or conflicting thread projections", () => {
  expect(() => codexConversationIdentity(
    new Headers({
      "thread-id": "not-a-uuid",
      "x-codex-turn-metadata": JSON.stringify({}),
    }),
    {},
  )).toThrow("thread-id must be a UUID");

  expect(() => codexConversationIdentity(
    new Headers({
      "thread-id": THREAD_ID,
      "x-codex-turn-metadata": JSON.stringify({ thread_id: THREAD_ID }),
    }),
    { client_metadata: { thread_id: OTHER_THREAD_ID } },
  )).toThrow("Codex thread identity fields must agree");

  expect(() => codexConversationIdentity(
    new Headers({ "x-codex-turn-metadata": "not-json" }),
    {},
  )).toThrow("must contain a JSON object");

  expect(() => codexConversationIdentity(
    new Headers(),
    { client_metadata: { "x-codex-turn-metadata": "not-json" } },
  )).toThrow("must contain a JSON object");

  expect(() => codexConversationIdentity(
    new Headers({
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: THREAD_ID,
        turn_id: TURN_ID,
      }),
    }),
    {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: THREAD_ID,
          turn_id: OTHER_TURN_ID,
        }),
      },
    },
  )).toThrow("Codex turn identity fields must agree");
});

test("Claude Code identity accepts canonical UUID syntax and normalizes case", () => {
  expect(claudeCodeConversationIdentity(
    new Headers({ "x-claude-code-session-id": ` ${THREAD_ID.toUpperCase()} ` }),
    THREAD_ID,
  )).toEqual({ kind: "claude_code_session", value: THREAD_ID });

  expect(claudeCodeConversationIdentity(
    new Headers(),
    "00000000-0000-0000-0000-000000000000",
  )).toEqual({
    kind: "claude_code_session",
    value: "00000000-0000-0000-0000-000000000000",
  });
});

test("Claude Code includes opaque subagent ids in conversation identity", () => {
  for (const agentId of [
    CLAUDE_AGENT_ID,
    "a-reviewer176918a3b6ce544b",
    "reviewer@backend",
  ]) {
    expect(claudeCodeConversationIdentity(
      new Headers({
        "x-claude-code-session-id": THREAD_ID,
        "x-claude-code-agent-id": ` ${agentId} `,
      }),
      THREAD_ID,
    )).toEqual({
      kind: "claude_code_session",
      value: THREAD_ID,
      qualifiers: [agentId],
    });
  }
});

test("Claude Code rejects conflicting header and metadata sessions", () => {
  expect(() => claudeCodeConversationIdentity(
    new Headers({ "x-claude-code-session-id": THREAD_ID }),
    OTHER_THREAD_ID,
  )).toThrow("Claude Code session identity fields must agree");
});

test("Chat Completions identity reads the session affinity header", () => {
  expect(chatCompletionsConversationIdentity(
    new Headers({ "x-session-affinity": ` ${THREAD_ID} ` }),
  )).toEqual({ kind: "openai_chat_session", value: THREAD_ID });

  // Session affinity is an opaque client token, not a Codex/Claude Code UUID.
  expect(chatCompletionsConversationIdentity(
    new Headers({ "x-session-affinity": "pi-session-42" }),
  )).toEqual({ kind: "openai_chat_session", value: "pi-session-42" });
});

test("Chat Completions identity falls back to prompt_cache_key", () => {
  expect(chatCompletionsConversationIdentity(
    new Headers(),
    ` ${THREAD_ID} `,
  )).toEqual({ kind: "openai_chat_session", value: THREAD_ID });

  expect(chatCompletionsConversationIdentity(
    new Headers({ "x-session-affinity": "affinity-session" }),
    "different-cache-key",
  )).toEqual({ kind: "openai_chat_session", value: "affinity-session" });
});

test("Chat Completions identity ignores non-affinity session headers", () => {
  // Underscored `session_id` is dropped by common proxies, and
  // `x-client-request-id` is per-request scoped, so neither can group turns.
  expect(chatCompletionsConversationIdentity(
    new Headers({
      session_id: THREAD_ID,
      "x-client-request-id": THREAD_ID,
    }),
  )).toBeUndefined();

  expect(chatCompletionsConversationIdentity(new Headers())).toBeUndefined();
  expect(chatCompletionsConversationIdentity(
    new Headers({ "x-session-affinity": "   " }),
    "   ",
  )).toBeUndefined();
});

const OPENCODE_SESSION = "ses_eb7a49f2fffeivd9pUpHrYPxzQ";
const OPENCODE_CHILD = "ses_eb7a2d11effe5Wq0kPz8mT1vAb";

test("OpenCode subagents share the parent session but get their own conversation", () => {
  expect(chatCompletionsConversationIdentity(new Headers({
    "x-session-affinity": OPENCODE_SESSION,
    "x-opencode-session-id": OPENCODE_SESSION,
  }))).toEqual({ kind: "openai_chat_session", value: OPENCODE_SESSION });

  expect(chatCompletionsConversationIdentity(new Headers({
    "x-session-affinity": OPENCODE_SESSION,
    "x-opencode-session-id": OPENCODE_CHILD,
    "x-opencode-parent-session-id": OPENCODE_SESSION,
  }))).toEqual({
    kind: "openai_chat_session",
    value: OPENCODE_SESSION,
    qualifiers: [OPENCODE_CHILD],
  });
});

test("OpenCode request context classifies main, subagent, and background requests", () => {
  expect(openCodeRequestContext(new Headers({ "x-session-affinity": "pi-session" }))).toBeUndefined();

  expect(openCodeRequestContext(new Headers({
    "x-opencode-session-id": OPENCODE_SESSION,
    "x-opencode-request-kind": "primary",
    "x-opencode-agent": "build",
  }))).toEqual({ requestClass: "main", agentType: "build" });

  expect(openCodeRequestContext(new Headers({
    "x-opencode-session-id": OPENCODE_CHILD,
    "x-opencode-parent-session-id": OPENCODE_SESSION,
    "x-opencode-request-kind": "primary",
    "x-opencode-agent": "explore",
  }))).toEqual({
    requestClass: "subagent",
    agentId: OPENCODE_CHILD,
    parentAgentId: OPENCODE_SESSION,
    agentType: "explore",
  });

  for (const [kind, requestClass] of [
    ["title", "auxiliary"], ["generate", "auxiliary"], ["compaction", "compaction"],
  ] as const) {
    expect(openCodeRequestContext(new Headers({
      "x-opencode-session-id": OPENCODE_SESSION,
      "x-opencode-request-kind": kind,
    }))?.requestClass).toBe(requestClass);
  }

  // Without the Dari plugin, OpenCode still names the session and its parent.
  expect(openCodeRequestContext(new Headers({
    "x-opencode-session-id": OPENCODE_SESSION,
  }))).toEqual({ requestClass: "main", agentType: undefined });
});

test("client identity fields reject malformed and overlong values", () => {
  expect(() => claudeCodeConversationIdentity(
    new Headers({ "x-claude-code-session-id": "not-a-uuid" }),
  )).toThrow("x-claude-code-session-id must be a UUID");

  const overlong = "x".repeat(201);
  expect(() => codexConversationIdentity(
    new Headers({
      "thread-id": overlong,
      "x-codex-turn-metadata": JSON.stringify({}),
    }),
    {},
  )).toThrow("thread-id must not exceed 200 characters");
  expect(() => claudeCodeConversationIdentity(
    new Headers({ "x-claude-code-session-id": overlong }),
  )).toThrow("x-claude-code-session-id must not exceed 200 characters");
  expect(() => claudeCodeConversationIdentity(
    new Headers(),
    overlong,
  )).toThrow("metadata.user_id.session_id must not exceed 200 characters");
  expect(() => claudeCodeConversationIdentity(
    new Headers({
      "x-claude-code-session-id": THREAD_ID,
      "x-claude-code-agent-id": overlong,
    }),
  )).toThrow("x-claude-code-agent-id must not exceed 200 characters");
  expect(() => chatCompletionsConversationIdentity(
    new Headers({ "x-session-affinity": overlong }),
  )).toThrow("x-session-affinity must not exceed 200 characters");
  expect(() => openCodeRequestContext(
    new Headers({ "x-opencode-session-id": OPENCODE_SESSION, "x-opencode-agent": overlong }),
  )).toThrow("x-opencode-agent must not exceed 200 characters");
  expect(() => chatCompletionsConversationIdentity(
    new Headers(),
    overlong,
  )).toThrow("prompt_cache_key must not exceed 200 characters");
});
