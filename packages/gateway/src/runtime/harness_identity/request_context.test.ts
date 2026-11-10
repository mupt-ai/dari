import { expect, test } from "bun:test";
import { codexConversationIdentity, codexRequestContext } from "./extract.js";

for (const [kind, requestClass] of [["turn", "main"], ["prewarm", "auxiliary"], ["memory", "auxiliary"], ["compaction", "compaction"], ["future", "unknown"]] as const) {
  test(`Codex ${kind} is ${requestClass}`, () => {
    expect(codexRequestContext(new Headers({ "x-codex-turn-metadata": JSON.stringify({ request_kind: kind }) }), {})?.requestClass).toBe(requestClass);
  });
}

test("Codex actual task subagents remain routable, maintenance agents do not", () => {
  for (const [agentKind, requestClass] of [["collab_spawn", "subagent"], ["review", "subagent"], ["compact", "compaction"], ["memory_consolidation", "auxiliary"]] as const) {
    expect(codexRequestContext(new Headers(), { client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", subagent_kind: agentKind,
        thread_id: "11111111-2222-4333-8444-555555555555" }),
    } })?.requestClass).toBe(requestClass);
  }
});

test("Codex classification projections must agree", () => {
  expect(() => codexRequestContext(new Headers({ "x-codex-turn-metadata": '{"request_kind":"turn"}' }), {
    client_metadata: { "x-codex-turn-metadata": '{"request_kind":"memory"}' },
  })).toThrow("agree");
});


test("Codex parent browsing identity is extracted without replacing the child thread", () => {
  const metadata = { request_kind: "turn", subagent_kind: "thread_spawn",
    thread_id: "11111111-2222-4333-8444-555555555555",
    parent_thread_id: "22222222-2222-4333-8444-555555555555" };
  const headers = new Headers({ "x-codex-turn-metadata": JSON.stringify(metadata) });
  expect(codexConversationIdentity(headers, {})).toEqual({
    kind: "codex_thread", value: metadata.thread_id, parentThreadId: metadata.parent_thread_id,
  });
  expect(() => codexConversationIdentity(headers, { client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ ...metadata,
      parent_thread_id: "33333333-2222-4333-8444-555555555555" }),
  } })).toThrow("parent thread identity fields must agree");
});
