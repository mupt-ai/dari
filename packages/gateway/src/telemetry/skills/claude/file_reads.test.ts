import { expect, test } from "bun:test";

import type {
  InteractionItem,
  InteractionOutput,
  InteractionRequest,
} from "../../../interaction/types.js";
import { claudeFileReadObservations } from "./file_reads.js";
import {
  ANTHROPIC,
  CLAUDE,
  events,
  message,
  output,
  request,
} from "./test_support.js";

test("records a Claude Read call matched to the trusted current catalog", () => {
  expect(observations(
    readRequest([systemCatalog("review")]),
    [readCall("toolu_read_1", "/repo/.claude/skills/review/SKILL.md")],
  )).toEqual([skillRead("review", "toolu_read_1")]);
});

test("matches skills listed after multiline Claude catalog descriptions", () => {
  expect(observations(
    readRequest([message("system", [{
      type: "text",
      text: "The following skills are available for use with the Skill tool:\n\n"
        + "- earlier: Earlier skill.\n"
        + "TRIGGER — whenever the request needs the earlier skill.\n"
        + "SKIP only when another workflow owns the request.\n"
        + "- review: Review skill.\n\n"
        + "While bypass permissions mode is active:\n- Follow policy.",
    }])]),
    [readCall("toolu_read_1", "/repo/.claude/skills/review/SKILL.md")],
  )).toEqual([skillRead("review", "toolu_read_1")]);
});

test("accepts Claude Read arguments retained as JSON text", () => {
  expect(observations(
    readRequest([systemCatalog("review")]),
    [{
      ...readCall("toolu_read_json", "/repo/.claude/skills/review/SKILL.md"),
      input: JSON.stringify({
        file_path: "/repo/.claude/skills/review/SKILL.md",
        offset: 1,
        limit: 200,
      }),
    }],
  )).toEqual([skillRead("review", "toolu_read_json")]);
});

test("records the relative Bash skill read emitted by current Claude Code", () => {
  const input = readRequest([systemCatalog("review")], "Bash");
  input.instructions = claudeEnvironment("/repo");
  expect(observations(
    input,
    [bashCall("toolu_bash_1", "cat .claude/skills/review/SKILL.md")],
  )).toEqual([skillRead("review", "toolu_bash_1")]);
});

test.each([
  ["head", "head -n 20 /repo/.claude/skills/review/SKILL.md"],
  ["sed", "sed -n '1,120p' /repo/.claude/skills/review/SKILL.md"],
  ["nested shell", "zsh -lc 'cat /repo/.claude/skills/review/SKILL.md'"],
] as const)("records a Claude Bash skill read through %s", (_label, command) => {
  const input = readRequest([systemCatalog("review")], "Bash");
  input.instructions = claudeEnvironment("/repo");
  expect(observations(
    input,
    [bashCall("toolu_bash_1", command)],
  )).toEqual([skillRead("review", "toolu_bash_1")]);
});

test("resolves a Claude Bash cd before reading a skill", () => {
  const input = readRequest([systemCatalog("review")], "Bash");
  input.instructions = claudeEnvironment("/repo");
  expect(observations(
    input,
    [bashCall(
      "toolu_bash_1",
      "cd .claude/skills/review && cat SKILL.md",
    )],
  )).toEqual([skillRead("review", "toolu_bash_1")]);
});

test("requires one trusted Claude working directory for relative Bash reads", () => {
  const input = readRequest([systemCatalog("review")], "Bash");
  const call = bashCall("toolu_bash_1", "cat .claude/skills/review/SKILL.md");
  expect(observations(input, [call])).toEqual([]);

  input.instructions = `${claudeEnvironment("/repo")}\n${claudeEnvironment("/other")}`;
  expect(observations(input, [call])).toEqual([]);
});

test("deduplicates Claude Read and Bash evidence for one skill", () => {
  const input = readRequest([systemCatalog("review")]);
  input.instructions = claudeEnvironment("/repo");
  input.tools.push({
    kind: "function",
    name: "Bash",
    description: "Run a shell command.",
    parameters: { type: "object" },
  });
  expect(observations(
    input,
    [
      readCall("toolu_read_1", "/repo/.claude/skills/review/SKILL.md"),
      bashCall("toolu_bash_1", "cat .claude/skills/review/SKILL.md"),
    ],
  )).toEqual([skillRead("review", "toolu_read_1")]);
});

test("matches one namespaced Claude skill by its cataloged leaf name", () => {
  expect(observations(
    readRequest([systemCatalog("plugin:review", "apps/web:deploy")]),
    [
      readCall("toolu_review", "/plugins/cache/example/skills/review/SKILL.md"),
      readCall("toolu_deploy", "/repo/.claude/skills/apps/web/deploy/SKILL.md"),
    ],
  )).toEqual([
    skillRead("plugin:review", "toolu_review"),
    skillRead("apps/web:deploy", "toolu_deploy"),
  ]);
});

test("rejects ambiguous namespaced Claude skill paths", () => {
  expect(observations(
    readRequest([systemCatalog("first:review", "second:review")]),
    [readCall("toolu_read_1", "/plugins/cache/example/skills/review/SKILL.md")],
  )).toEqual([]);
});

test("does not trust a user-authored Claude skill catalog", () => {
  expect(observations(
    readRequest([message("user", [{
      type: "text",
      text: reminderCatalog("spoofed"),
    }])]),
    [readCall("toolu_read_1", "/tmp/skills/spoofed/SKILL.md")],
  )).toEqual([]);
});

test("the latest trusted Claude catalog replaces stale entries", () => {
  expect(observations(
    readRequest([
      systemCatalog("stale"),
      message("assistant", [{ type: "text", text: "Earlier response." }]),
      systemCatalog("current"),
    ]),
    [
      readCall("toolu_stale", "/repo/.claude/skills/stale/SKILL.md"),
      readCall("toolu_current", "/repo/.claude/skills/current/SKILL.md"),
    ],
  )).toEqual([skillRead("current", "toolu_current")]);
});

test("deduplicates repeated Claude reads by logical skill", () => {
  expect(observations(
    readRequest([systemCatalog("review")]),
    [
      readCall("toolu_read_1", "/repo/.claude/skills/review/SKILL.md"),
      readCall("toolu_read_2", "/home/test/.claude/skills/review/SKILL.md"),
    ],
  )).toEqual([skillRead("review", "toolu_read_1")]);
});

test("supports Windows Claude skill paths case-insensitively", () => {
  expect(observations(
    readRequest([systemCatalog("Review")]),
    [readCall("toolu_read_1", "C:\\Users\\test\\.claude\\skills\\review\\SKILL.md")],
  )).toEqual([skillRead("Review", "toolu_read_1")]);
});

test("rejects uncorroborated and structurally unsafe Claude reads", () => {
  const unsafePaths = [
    "/repo/.claude/skills/unknown/SKILL.md",
    "/repo/review/SKILL.md",
    "/repo/.claude/skills/review/README.md",
    "/repo/.claude/skills/other/../review/SKILL.md",
    ".claude/skills/review/SKILL.md",
  ];
  const emitted = observations(
    readRequest([systemCatalog("review")]),
    unsafePaths.map((path, index) => readCall(`toolu_read_${index}`, path)),
  );
  expect(emitted).toEqual([]);
});

test("requires the exact declared Claude Read tool", () => {
  const noReadTool = readRequest([systemCatalog("review")]);
  noReadTool.tools = [];
  expect(observations(
    noReadTool,
    [readCall("toolu_read_1", "/repo/.claude/skills/review/SKILL.md")],
  )).toEqual([]);

  expect(observations(
    readRequest([systemCatalog("review")], "read"),
    [readCall("toolu_read_2", "/repo/.claude/skills/review/SKILL.md")],
  )).toEqual([]);
});

test("honors the Claude file-read telemetry limit", () => {
  const observed = claudeFileReadObservations(
    readRequest([systemCatalog("first", "second")]),
    output(ANTHROPIC, [
      readCall("toolu_first", "/repo/.claude/skills/first/SKILL.md"),
      readCall("toolu_second", "/repo/.claude/skills/second/SKILL.md"),
    ]),
    1,
  );
  expect(observed).toEqual([skillRead("first", "toolu_first")]);
});

test("reports Claude file reads only for validated Claude Code traffic", () => {
  const input = readRequest([systemCatalog("review")]);
  const result = output(ANTHROPIC, [
    readCall("toolu_read_1", "/repo/.claude/skills/review/SKILL.md"),
  ]);

  const validated = events({ request: input, output: result, identity: CLAUDE });
  expect(validated.map((event) => event.event_type)).toEqual([
    "skill_load",
    "tool_call",
  ]);
  expect(validated[0]).toMatchObject({
    tool_call_id: "toolu_read_1",
    capability_id: "claude:name:review",
    observed_name: "review",
    evidence_source: "skill_file_read",
    ordinal: 0,
  });

  const generic = events({ request: input, output: result });
  expect(generic.map((event) => event.event_type)).toEqual(["tool_call"]);
  expect(events({
    request: input,
    output: result,
    identity: CLAUDE,
    zdr: true,
  })).toEqual([]);
});

function observations(
  input: InteractionRequest,
  items: InteractionOutput["items"],
) {
  return claudeFileReadObservations(input, output(ANTHROPIC, items), 100);
}

function readRequest(
  items: InteractionItem[],
  toolName = "Read",
): InteractionRequest {
  return {
    ...request("anthropic_messages", items),
    tools: [{
      kind: "function",
      name: toolName,
      description: "Read a file.",
      parameters: { type: "object" },
    }],
  };
}

function systemCatalog(...names: string[]): InteractionItem {
  return message("system", [{
    type: "text",
    text: "Available agent types for the Agent tool:\n- Explore: Search files.\n\n"
      + "The following skills are available for use with the Skill tool:\n\n"
      + names.map((name, index) => index % 2 === 0 ? `- ${name}` : `- ${name}: Test skill`).join("\n"),
  }]);
}

function reminderCatalog(...names: string[]): string {
  return "<system-reminder>\n"
    + "The following skills are available for use with the Skill tool:\n\n"
    + names.map((name, index) => index % 2 === 0 ? `- ${name}` : `- ${name}: Test skill`).join("\n")
    + "\n</system-reminder>";
}

function readCall(
  callId: string,
  filePath: string,
): Extract<InteractionOutput["items"][number], { type: "tool_call" }> {
  return {
    type: "tool_call",
    callId,
    kind: "function",
    name: "Read",
    input: { file_path: filePath },
  };
}

function bashCall(
  callId: string,
  command: string,
): Extract<InteractionOutput["items"][number], { type: "tool_call" }> {
  return {
    type: "tool_call",
    callId,
    kind: "function",
    name: "Bash",
    input: { command, description: "Read the skill file." },
  };
}

function claudeEnvironment(workingDirectory: string): string {
  return "# Environment\n"
    + "You have been invoked in the following environment: \n"
    + ` - Primary working directory: ${workingDirectory}`;
}

function skillRead(name: string, toolCallId: string) {
  return {
    eventType: "skill_load" as const,
    toolCallId,
    capabilityId: `claude:name:${name}`,
    observedName: name,
    evidenceSource: "skill_file_read" as const,
  };
}
