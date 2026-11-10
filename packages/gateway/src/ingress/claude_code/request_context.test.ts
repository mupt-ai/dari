import { expect, test } from "bun:test";
import { claudeCodeRequestContext } from "./request_context.js";

for (const requestClass of ["main", "subagent", "workflow", "auxiliary", "compaction", "side_reply"] as const) {
  test(`Claude header classifies ${requestClass}`, () => {
    const headers = new Headers({
      "x-claude-code-request-class": requestClass,
      "x-claude-code-agent-id": "agent-1",
      "x-claude-code-parent-agent-id": "parent-1",
      "x-claude-code-agent-type": "Explore",
    });
    expect(claudeCodeRequestContext(headers)).toEqual({
      requestClass, agentId: "agent-1", parentAgentId: "parent-1", agentType: "Explore",
    });
  });
}

test("missing and future classes stay unknown, not main", () => {
  expect(claudeCodeRequestContext(new Headers()).requestClass).toBe("unknown");
  expect(claudeCodeRequestContext(new Headers({ "x-claude-code-request-class": "future" })).requestClass).toBe("unknown");
});

test("agent loops require stable IDs and reject oversized metadata", () => {
  expect(() => claudeCodeRequestContext(new Headers({ "x-claude-code-request-class": "subagent" }))).toThrow("require");
  expect(() => claudeCodeRequestContext(new Headers({ "x-claude-code-agent-id": "a".repeat(201) }))).toThrow("200");
});
