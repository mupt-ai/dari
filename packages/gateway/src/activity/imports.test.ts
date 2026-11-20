import { expect, test } from "bun:test";

import { importedRequestReport } from "./imports.js";

const text = (role: string, value: string) =>
  ({ type: "message" as const, role, content: [{ type: "text" as const, text: value }], contentShape: "string" as const });

function session(agent: string, agentId?: string) {
  return {
    agent,
    session_id: "session-1",
    ...(agentId === undefined ? {} : { agent_id: agentId }),
    items: [
      text("user", "hello"),
      { type: "reasoning" as const, summary: [], content: ["thinking"] },
      text("assistant", "hi"),
      { type: "tool_call" as const, callId: "call_1", kind: "function" as const, name: "read", input: "{}" },
    ] as any,
    turns: [{
      request_id: `imp_${"c".repeat(32)}`,
      input_items: 1,
      output_items: 3,
      model: "openai/gpt-5.5",
      provider: "openai",
      received_at: "2026-03-02T01:00:00Z",
      completed_at: "2026-03-02T01:00:02Z",
      stop_reason: "tool_use" as const,
      usage: { input_tokens: 7, output_tokens: 3, cache_read_tokens: 40, cache_write_tokens: 0 },
    }],
  };
}

const report = (agent: string, agentId?: string) => {
  const imported = session(agent, agentId);
  return importedRequestReport("org_1", imported, imported.turns[0]!);
};

// The router fee is owed for a selector decision with billing facts, and
// spend comes from usage costs: an imported request carries none of them.
test("an imported request has tokens and nothing to bill", () => {
  const imported = report("pi");
  expect(imported).toMatchObject({
    request_id: `imp_${"c".repeat(32)}`,
    organization_id: "org_1",
    conversation_id: "session-1",
    agent_session_id: "session-1",
    request_kind: "user_message",
    status: "completed",
    selected_model: "openai/gpt-5.5",
    provider_call: {
      stop_reason: "tool_use",
      usage: {
        input_tokens: 7, output_tokens: 3, cache_read_tokens: 40, cache_write_tokens: 0,
        total_tokens: 50, pricing_known: false,
      },
    },
  });
  for (const field of ["router_id", "selector", "billing_terminal_outcome", "billing_provider_attempts", "prefix_entry", "link"]) {
    expect(imported).not.toHaveProperty(field);
  }
  expect(JSON.stringify(imported)).not.toContain("cost");
});

test("each agent's response is stored in the protocol it speaks", () => {
  const response = (agent: string) => JSON.parse(report(agent).client_response_json as string);
  expect(report("claude").source_protocol).toBe("anthropic_messages");
  expect(response("claude").content.map((block: any) => block.type)).toEqual(["thinking", "text", "tool_use"]);
  expect(report("codex").source_protocol).toBe("openai_responses");
  expect(response("codex").output.map((item: any) => item.type)).toEqual(["reasoning", "message", "function_call"]);
  for (const agent of ["opencode", "pi"]) {
    expect(report(agent).source_protocol).toBe("openai_chat");
    expect(response(agent).choices[0]).toMatchObject({
      finish_reason: "tool_calls",
      message: { content: "hi", tool_calls: [{ id: "call_1", function: { name: "read" } }] },
    });
  }
});

test("a subagent's calls are filed as its own loop of the session", () => {
  expect((report("claude", "agent-a").request_metadata as any).agent_context).toEqual({
    requestClass: "subagent",
    agentId: "agent-a",
  });
  expect((report("claude").request_metadata as any).agent_context).toBeUndefined();
});
