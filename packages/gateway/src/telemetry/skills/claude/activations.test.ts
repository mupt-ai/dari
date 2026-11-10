import { expect, test } from "bun:test";

import type {
  InteractionContent,
  InteractionItem,
  InteractionRequest,
} from "../../../interaction/types.js";
import { claudeSkillObservations } from "./observations.js";
import {
  ANTHROPIC,
  CLAUDE,
  claudeCommand,
  claudeExpansion,
  events,
  message,
  output,
  request,
} from "./test_support.js";

test("Claude Code Skill attempts remain ordinary tool calls until activation", () => {
  const emitted = events({
    request: request("anthropic_messages", [
      message("user", [{ type: "text", text: "Review this UI" }]),
    ]),
    output: output(ANTHROPIC, [{
      type: "tool_call",
      callId: "toolu_skill",
      kind: "function",
      name: "Skill",
      input: { skill: "frontend-design", args: "dashboard" },
    }]),
    identity: CLAUDE,
  });

  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({
    event_type: "tool_call",
    tool_call_id: "toolu_skill",
    capability_id: "Skill",
    observed_name: "Skill",
    evidence_source: "model_tool_call",
  });
});

test("successful Claude Code Skill results become correlated skill uses", () => {
  const emitted = events({
    request: {
      ...request("anthropic_messages", [
        message("user", [{ type: "text", text: "Review this UI" }]),
        {
          type: "tool_call",
          callId: "toolu_skill",
          kind: "function",
          name: "Skill",
          input: { skill: "/frontend-design", args: "dashboard" },
        },
        {
          type: "tool_result",
          callId: "toolu_skill",
          kind: "function",
          output: "Launching skill: frontend-design",
          outputShape: "string",
          isError: false,
        },
        message("user", [{
          type: "text",
          text: claudeExpansion("/repo/.claude/skills/frontend-design", "instructions"),
        }]),
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toEqual([{
    event_type: "skill_use",
    tool_call_id: "toolu_skill",
    exchange_context_hash: null,
    capability_id: "claude:name:frontend-design",
    observed_name: "frontend-design",
    skill_version: null,
    evidence_source: "skill_tool_activation",
    ordinal: 0,
  }]);
});

test("accepts Claude Skill confirmations with exact budget reminders", () => {
  const emitted = events({
    request: {
      ...request("anthropic_messages", [
        message("user", [{ type: "text", text: "Use model-probe" }]),
        {
          type: "tool_call",
          callId: "toolu_budget",
          kind: "function",
          name: "Skill",
          input: { skill: "model-probe" },
        },
        {
          type: "tool_result",
          callId: "toolu_budget",
          kind: "function",
          output: "Launching skill: model-probe\n\n"
            + "<system-reminder>\nUSD budget: $0/$1; $1 remaining\n</system-reminder>\n\n"
            + "<system-reminder>\nUSD budget: $0.008185/$1; $0.991815 remaining\n</system-reminder>",
          outputShape: "string",
        },
        message("user", [{
          type: "text",
          text: claudeExpansion("/repo/model-probe", "instructions"),
        }]),
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({
    capability_id: "claude:name:model-probe",
    tool_call_id: "toolu_budget",
  });
});

test("accepts Claude Skill confirmations followed by a budget status message", () => {
  const emitted = events({
    request: {
      ...request("anthropic_messages", [
        {
          type: "tool_call",
          callId: "toolu_budget_message",
          kind: "function",
          name: "Skill",
          input: { skill: "model-probe", args: "live-budget" },
        },
        {
          type: "tool_result",
          callId: "toolu_budget_message",
          kind: "function",
          output: "Launching skill: model-probe",
          outputShape: "string",
        },
        message("user", [{
          type: "text",
          text: claudeExpansion("/repo/model-probe", "instructions"),
        }]),
        message("system", [{
          type: "text",
          text: "USD budget: $0/$1; $1 remaining\n\n"
            + "USD budget: $0.00305/$1; $0.99695 remaining",
        }]),
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toEqual([expect.objectContaining({
    event_type: "skill_use",
    capability_id: "claude:name:model-probe",
    tool_call_id: "toolu_budget_message",
  })]);
});

test("rejects Claude Skill confirmations followed by arbitrary system text", () => {
  const emitted = events({
    request: {
      ...request("anthropic_messages", [
        {
          type: "tool_call",
          callId: "toolu_system_suffix",
          kind: "function",
          name: "Skill",
          input: { skill: "model-probe" },
        },
        {
          type: "tool_result",
          callId: "toolu_system_suffix",
          kind: "function",
          output: "Launching skill: model-probe",
          outputShape: "string",
        },
        message("user", [{
          type: "text",
          text: claudeExpansion("/repo/model-probe", "instructions"),
        }]),
        message("system", [{ type: "text", text: "Unrelated system status" }]),
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toEqual([]);
});

test("rejects non-budget suffixes on Claude Skill confirmations", () => {
  expect(events({
    request: {
      ...request("anthropic_messages", [
        message("user", [{ type: "text", text: "Use model-probe" }]),
        {
          type: "tool_call",
          callId: "toolu_suffix",
          kind: "function",
          name: "Skill",
          input: { skill: "model-probe" },
        },
        {
          type: "tool_result",
          callId: "toolu_suffix",
          kind: "function",
          output: "Launching skill: model-probe\n\nnot harness evidence",
          outputShape: "string",
        },
        message("user", [{
          type: "text",
          text: claudeExpansion("/repo/model-probe", "instructions"),
        }]),
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  })).toEqual([]);
});

test("mixed inline and forked Claude Skill results are both recorded", () => {
  const emitted = events({
    request: {
      ...request("anthropic_messages", [
        message("user", [{ type: "text", text: "Use both skills" }]),
        {
          type: "tool_call",
          callId: "toolu_inline",
          kind: "function",
          name: "Skill",
          input: { skill: "review" },
        },
        {
          type: "tool_call",
          callId: "toolu_fork",
          kind: "function",
          name: "Skill",
          input: { skill: "research" },
        },
        {
          type: "tool_result",
          callId: "toolu_inline",
          kind: "function",
          output: "Launching skill: review",
          outputShape: "string",
        },
        {
          type: "tool_result",
          callId: "toolu_fork",
          kind: "function",
          output: "Skill \"research\" completed (forked execution).\n\nResult:\nfindings",
          outputShape: "string",
        },
        message("user", [{
          type: "text",
          text: claudeExpansion("/repo/review", "review instructions"),
        }]),
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted.map((event) => [event.observed_name, event.tool_call_id])).toEqual([
    ["review", "toolu_inline"],
    ["research", "toolu_fork"],
  ]);
});

test("failed Claude Code Skill results do not produce skill use", () => {
  const emitted = events({
    request: {
      ...request("anthropic_messages", [
        message("user", [{ type: "text", text: "Run missing skill" }]),
        {
          type: "tool_call",
          callId: "toolu_missing",
          kind: "function",
          name: "Skill",
          input: { skill: "missing" },
        },
        {
          type: "tool_result",
          callId: "toolu_missing",
          kind: "function",
          output: "Unknown skill: missing",
          outputShape: "string",
          isError: true,
        },
        message("user", [{ type: "text", text: "Skill failed to load." }]),
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toEqual([]);
});

test("Claude skill capability identities stay within the persistence limit", () => {
  const accepted = "a".repeat(500);
  const rejected = "b".repeat(501);
  const confirmed = (name: string, callId: string) => events({
    request: {
      ...request("anthropic_messages", [
        message("user", [{ type: "text", text: "Run it" }]),
        {
          type: "tool_call",
          callId,
          kind: "function",
          name: "Skill",
          input: { skill: name },
        },
        {
          type: "tool_result",
          callId,
          kind: "function",
          output: `Skill \"${name}\" launched (forked execution, running in the background).`,
          outputShape: "string",
        },
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(confirmed(accepted, "toolu_accepted")[0]?.capability_id).toHaveLength(512);
  expect(confirmed(rejected, "toolu_rejected")).toEqual([]);
});

test("Claude skill names accept plugin and directory-scoped namespaces", () => {
  const confirmed = (name: string) => events({
    request: {
      ...request("anthropic_messages", [
        message("user", [{ type: "text", text: "Run it" }]),
        {
          type: "tool_call",
          callId: "toolu_name",
          kind: "function",
          name: "Skill",
          input: { skill: name },
        },
        {
          type: "tool_result",
          callId: "toolu_name",
          kind: "function",
          output: `Skill \"${name}\" launched (forked execution, running in the background).`,
          outputShape: "string",
        },
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(confirmed("plugin-name:review")).toHaveLength(1);
  expect(confirmed("apps/web:deploy")).toHaveLength(1);
  expect(confirmed("apps/web/deploy")).toEqual([]);
  expect(confirmed("apps//web:deploy")).toEqual([]);
});

test("records a correlated completed Claude fork-context skill", () => {
  const emitted = events({
    request: {
      ...request("anthropic_messages", [
        message("user", [{ type: "text", text: "Run the fork probe" }]),
        {
          type: "tool_call",
          callId: "toolu_fork",
          kind: "function",
          name: "Skill",
          input: { skill: "dari-fork-probe" },
        },
        {
          type: "tool_result",
          callId: "toolu_fork",
          kind: "function",
          output: "Skill \"dari-fork-probe\" completed (forked execution).\n\nResult:\nDARI_FORK_SKILL_ACTIVE",
          outputShape: "string",
        },
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toEqual([{
    event_type: "skill_use",
    tool_call_id: "toolu_fork",
    exchange_context_hash: null,
    capability_id: "claude:name:dari-fork-probe",
    observed_name: "dari-fork-probe",
    skill_version: null,
    evidence_source: "skill_tool_activation",
    ordinal: 0,
  }]);
});

test("records a correlated background Claude fork-context skill launch", () => {
  const emitted = events({
    request: {
      ...request("anthropic_messages", [
        message("user", [{ type: "text", text: "Run the fork probe" }]),
        {
          type: "tool_call",
          callId: "toolu_fork",
          kind: "function",
          name: "Skill",
          input: { skill: "/dari-fork-probe" },
        },
        {
          type: "tool_result",
          callId: "toolu_fork",
          kind: "function",
          output: "Skill \"dari-fork-probe\" launched (forked execution, running in the background).",
          outputShape: "string",
        },
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({
    event_type: "skill_use",
    tool_call_id: "toolu_fork",
    capability_id: "claude:name:dari-fork-probe",
  });
});

test("records Claude's live background launch result with status text", () => {
  const emitted = events({
    request: {
      ...request("anthropic_messages", [
        message("user", [{ type: "text", text: "Run fork-probe" }]),
        {
          type: "tool_call",
          callId: "toolu_background",
          kind: "function",
          name: "Skill",
          input: { skill: "fork-probe", args: "background-review" },
        },
        {
          type: "tool_result",
          callId: "toolu_background",
          kind: "function",
          output: "Skill \"fork-probe\" launched (forked execution, running in the background).\n\n"
            + "Running in the background as @fork-probe",
          outputShape: "string",
        },
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({
    capability_id: "claude:name:fork-probe",
    tool_call_id: "toolu_background",
  });
});

test("historical Claude fork confirmations are not replayed", () => {
  expect(events({
    request: {
      ...request("anthropic_messages", [
        message("user", [{ type: "text", text: "Run the fork probe" }]),
        {
          type: "tool_call",
          callId: "toolu_fork",
          kind: "function",
          name: "Skill",
          input: { skill: "dari-fork-probe" },
        },
        {
          type: "tool_result",
          callId: "toolu_fork",
          kind: "function",
          output: "Skill \"dari-fork-probe\" completed (forked execution).\n\nResult:\nDARI_FORK_SKILL_ACTIVE",
          outputShape: "string",
        },
        message("assistant", [{ type: "text", text: "DARI_FORK_SKILL_ACTIVE" }]),
        message("user", [{ type: "text", text: "Continue" }]),
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  })).toEqual([]);
});

test("sequential Claude Skill confirmations retain each exact call id", () => {
  const emitted = events({
    request: {
      ...request("anthropic_messages", [
        message("user", [{ type: "text", text: "Use both skills" }]),
        {
          type: "tool_call",
          callId: "toolu_first",
          kind: "function",
          name: "Skill",
          input: { skill: "first" },
        },
        {
          type: "tool_call",
          callId: "toolu_second",
          kind: "function",
          name: "Skill",
          input: { skill: "second" },
        },
        {
          type: "tool_result",
          callId: "toolu_first",
          kind: "function",
          output: "Launching skill: first",
          outputShape: "string",
        },
        message("user", [{ type: "text", text: claudeExpansion("/repo/first", "body") }]),
        {
          type: "tool_result",
          callId: "toolu_second",
          kind: "function",
          output: "Launching skill: second",
          outputShape: "string",
        },
        message("user", [{
          type: "text",
          text: "Skill /second is already loaded above; instructions unchanged. Arguments: again",
        }]),
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted.map((event) => [event.observed_name, event.tool_call_id])).toEqual([
    ["first", "toolu_first"],
    ["second", "toolu_second"],
  ]);
  expect(emitted.map((event) => event.ordinal)).toEqual([0, 1]);
});

test("Claude already-loaded confirmation may omit an arguments suffix", () => {
  const emitted = events({
    request: {
      ...request("anthropic_messages", [
        message("user", [{ type: "text", text: "Use review" }]),
        {
          type: "tool_call",
          callId: "toolu_review",
          kind: "function",
          name: "Skill",
          input: { skill: "review" },
        },
        {
          type: "tool_result",
          callId: "toolu_review",
          kind: "function",
          output: "Launching skill: review",
          outputShape: "string",
        },
        message("user", [{
          type: "text",
          text: "Skill /review is already loaded above; instructions unchanged.",
        }]),
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({
    event_type: "skill_use",
    tool_call_id: "toolu_review",
    capability_id: "claude:name:review",
  });
});

test("does not double-count Claude's redundant Skill call after a direct command", () => {
  const emitted = events({
    request: {
      ...request("anthropic_messages", [
        message("user", [
          { type: "text", text: claudeCommand("parent-probe", "no-budget") },
          { type: "text", text: claudeExpansion("/repo/parent-probe", "body") },
        ]),
        {
          type: "tool_call",
          callId: "toolu_redundant",
          kind: "function",
          name: "Skill",
          input: { skill: "parent-probe", args: "no-budget" },
        },
        {
          type: "tool_result",
          callId: "toolu_redundant",
          kind: "function",
          output: "Launching skill: parent-probe",
          outputShape: "string",
        },
        message("user", [{
          type: "text",
          text: "Skill /parent-probe is already loaded above; instructions unchanged. Arguments: no-budget",
        }]),
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toEqual([]);
});

test("grouped parallel Claude Skill confirmations retain each exact call id", () => {
  const emitted = events({
    request: {
      ...request("anthropic_messages", [
        message("user", [{ type: "text", text: "Use both skills" }]),
        {
          type: "tool_call",
          callId: "toolu_first",
          kind: "function",
          name: "Skill",
          input: { skill: "first" },
        },
        {
          type: "tool_call",
          callId: "toolu_second",
          kind: "function",
          name: "Skill",
          input: { skill: "second" },
        },
        {
          type: "tool_result",
          callId: "toolu_first",
          kind: "function",
          output: "Launching skill: first",
          outputShape: "string",
        },
        {
          type: "tool_result",
          callId: "toolu_second",
          kind: "function",
          output: "Launching skill: second",
          outputShape: "string",
        },
        message("user", [
          { type: "text", text: claudeExpansion("/repo/first", "first body") },
          { type: "text", text: claudeExpansion("/repo/second", "second body") },
        ]),
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted.map((event) => [event.observed_name, event.tool_call_id])).toEqual([
    ["first", "toolu_first"],
    ["second", "toolu_second"],
  ]);
  expect(emitted.map((event) => event.ordinal)).toEqual([0, 1]);
});

test("parallel Claude activations of the same skill remain distinct uses", () => {
  const emitted = events({
    request: {
      ...request("anthropic_messages", [
        message("user", [{ type: "text", text: "Use review twice" }]),
        {
          type: "tool_call",
          callId: "toolu_review_first",
          kind: "function",
          name: "Skill",
          input: { skill: "review", args: "backend" },
        },
        {
          type: "tool_call",
          callId: "toolu_review_second",
          kind: "function",
          name: "Skill",
          input: { skill: "review", args: "frontend" },
        },
        {
          type: "tool_result",
          callId: "toolu_review_first",
          kind: "function",
          output: "Launching skill: review",
          outputShape: "string",
        },
        {
          type: "tool_result",
          callId: "toolu_review_second",
          kind: "function",
          output: "Launching skill: review",
          outputShape: "string",
        },
        message("user", [
          { type: "text", text: claudeExpansion("/repo/review", "body") },
          { type: "text", text: claudeExpansion("/repo/review", "body") },
        ]),
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted.map((event) => event.tool_call_id)).toEqual([
    "toolu_review_first",
    "toolu_review_second",
  ]);
  expect(emitted.map((event) => event.capability_id)).toEqual([
    "claude:name:review",
    "claude:name:review",
  ]);
});

test("Claude activation collection stops at the telemetry limit", () => {
  const count = 1_005;
  const calls: InteractionItem[] = Array.from({ length: count }, (_, index) => ({
    type: "tool_call" as const,
    callId: `toolu_skill_${index}`,
    kind: "function" as const,
    name: "Skill",
    input: { skill: `skill-${index}` },
  }));
  const results: InteractionItem[] = Array.from({ length: count }, (_, index) => ({
    type: "tool_result" as const,
    callId: `toolu_skill_${index}`,
    kind: "function" as const,
    output: `Launching skill: skill-${index}`,
    outputShape: "string" as const,
  }));
  const expansions: InteractionContent[] = Array.from({ length: count }, (_, index) => ({
    type: "text" as const,
    text: claudeExpansion(`/repo/skill-${index}`, "body"),
  }));
  const observed = claudeSkillObservations({
    ...request("anthropic_messages", [
      message("user", [{ type: "text", text: "Use every skill" }]),
      ...calls,
      ...results,
      message("user", expansions),
    ]),
    requestPurpose: "tool_continuation",
  }, 1_000);

  expect(observed).toHaveLength(1_000);
  expect(observed[0]?.observedName).toBe("skill-0");
  expect(observed.at(-1)?.observedName).toBe("skill-999");
});

test("generic Anthropic clients do not turn a tool named Skill into skill analytics", () => {
  const emitted = events({
    request: request("anthropic_messages", [
      message("user", [{ type: "text", text: "Run it" }]),
    ]),
    output: output(ANTHROPIC, [{
      type: "tool_call",
      callId: "toolu_skill",
      kind: "function",
      name: "Skill",
      input: { skill: "frontend-design" },
    }]),
  });

  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({
    event_type: "tool_call",
    capability_id: "Skill",
    evidence_source: "model_tool_call",
  });
});

test("malformed Claude Skill calls remain ordinary tool calls", () => {
  const emitted = events({
    request: request("anthropic_messages", [
      message("user", [{ type: "text", text: "Run it" }]),
    ]),
    output: output(ANTHROPIC, [{
      type: "tool_call",
      callId: "toolu_skill",
      kind: "function",
      name: "Skill",
      input: { skill: "frontend-design", unexpected: true },
    }]),
    identity: CLAUDE,
  });

  expect(emitted[0]).toMatchObject({
    event_type: "tool_call",
    capability_id: "Skill",
  });
});

test("input skills and output tools share one collision-free ordinal timeline", () => {
  const emitted = events({
    request: request("anthropic_messages", [message("user", [
      { type: "text", text: claudeCommand("probe", "") },
      { type: "text", text: claudeExpansion("/repo/probe", "body") },
    ])]),
    output: output(ANTHROPIC, [
      message("assistant", [{ type: "text", text: "Using it" }]),
      {
        type: "tool_call",
        callId: "toolu_read",
        kind: "function",
        name: "Read",
        input: {},
      },
    ]),
    identity: CLAUDE,
  });

  expect(emitted.map((event) => event.ordinal)).toEqual([0, 2]);
  expect(new Set(emitted.map((event) => event.ordinal)).size).toBe(2);
});

test("ZDR suppresses named skill events", () => {
  expect(events({
    request: request("anthropic_messages", [message("user", [
      { type: "text", text: claudeCommand("probe", "") },
      { type: "text", text: claudeExpansion("/repo/probe", "body") },
    ])]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
    zdr: true,
  })).toEqual([]);
});
