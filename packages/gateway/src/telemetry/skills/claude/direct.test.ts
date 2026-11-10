import { expect, test } from "bun:test";

import { anthropicMessagesToInteraction } from "../../../protocol/input/anthropic_messages.js";
import {
  ANTHROPIC,
  availableSkills,
  CLAUDE,
  claudeCommand,
  claudeExpansion,
  events,
  message,
  output,
  request,
  skillEvent,
} from "./test_support.js";

test("records exact Claude Code direct skill command envelopes", () => {
  const emitted = events({
    request: request("anthropic_messages", [
      message("user", [
        { type: "text", text: "<system-reminder>context</system-reminder>" },
        { type: "text", text: claudeCommand("plugin:review", "check this") },
        { type: "text", text: claudeExpansion("/repo/.claude/skills/plugin-review", "instructions") },
      ]),
      message("system", [{ type: "text", text: "Available agents" }]),
    ]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toEqual([
    skillEvent(
      "plugin:review",
      "claude:name:plugin:review",
      "skill_command_expansion",
      0,
    ),
  ]);
});

test("records Claude Code direct skills when the harness omits empty arguments", () => {
  const emitted = events({
    request: request("anthropic_messages", [
      message("user", [
        { type: "text", text: "<system-reminder>context</system-reminder>\n\n" },
        {
          type: "text",
          text: "<command-message>probe</command-message>\n<command-name>/probe</command-name>\n",
        },
        { type: "text", text: claudeExpansion("/repo/.claude/skills/probe", "instructions") },
      ]),
      message("system", [{ type: "text", text: "Available agents" }]),
    ]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toEqual([
    skillEvent("probe", "claude:name:probe", "skill_command_expansion", 0),
  ]);
});

test("Claude command arguments are not split into extra skill uses", () => {
  const emitted = events({
    request: request("anthropic_messages", [message("user", [
      { type: "text", text: claudeCommand("first", "/second answer now") },
      { type: "text", text: claudeExpansion("/repo/first", "instructions") },
    ])]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted.map((event) => event.observed_name)).toEqual(["first"]);
});

test("records multiple adjacent Claude direct skill activations", () => {
  const emitted = events({
    request: request("anthropic_messages", [message("user", [
      { type: "text", text: claudeCommand("first", "") },
      { type: "text", text: claudeExpansion("/repo/first", "first instructions") },
      { type: "text", text: claudeCommand("second", "review") },
      { type: "text", text: claudeExpansion("/repo/second", "second instructions") },
    ])]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted.map((event) => event.observed_name)).toEqual(["first", "second"]);
  expect(emitted.map((event) => event.ordinal)).toEqual([0, 1]);
});

test("repeated direct activation of one Claude skill remains two uses", () => {
  const emitted = events({
    request: request("anthropic_messages", [message("user", [
      { type: "text", text: claudeCommand("review", "backend") },
      { type: "text", text: claudeExpansion("/repo/review", "instructions") },
      { type: "text", text: claudeCommand("review", "frontend") },
      { type: "text", text: claudeExpansion("/repo/review", "instructions") },
    ])]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted.map((event) => event.capability_id)).toEqual([
    "claude:name:review",
    "claude:name:review",
  ]);
});

test("records legacy Claude command files corroborated by the skill catalog", () => {
  const emitted = events({
    request: request("anthropic_messages", [message("user", [
      { type: "text", text: availableSkills("legacy-probe") },
      { type: "text", text: claudeCommand("legacy-probe", "review") },
      { type: "text", text: "Review the change and return a concise verdict." },
    ])]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toEqual([
    skillEvent(
      "legacy-probe",
      "claude:name:legacy-probe",
      "skill_command_expansion",
      0,
    ),
  ]);
});

test("finds Claude's available-skill catalog after Anthropic wire parsing", () => {
  const emitted = events({
    request: anthropicMessagesToInteraction({
      model: "dari/routing",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: claudeCommand("legacy-probe", "review") },
            { type: "text", text: "Review the change and return a concise verdict." },
          ],
        },
        {
          role: "system",
          content: [{
            type: "text",
            text: "<system-reminder>\nAvailable agent types for the Agent tool:\n- Explore: Search files.\n</system-reminder>\n\n"
              + availableSkills("legacy-probe"),
          }],
        },
      ],
    }),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toHaveLength(1);
  expect(emitted[0]?.capability_id).toBe("claude:name:legacy-probe");
});

test("finds Claude's bare available-skill catalog in a system message", () => {
  const emitted = events({
    request: anthropicMessagesToInteraction({
      model: "dari/routing",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: claudeCommand("legacy-probe", "review") },
            { type: "text", text: "Review the change and return a concise verdict." },
          ],
        },
        {
          role: "system",
          content: [{
            type: "text",
            text: "The following skills are available for use with the Skill tool:\n\n"
              + "- legacy-probe: Test skill",
          }],
        },
      ],
    }),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toHaveLength(1);
  expect(emitted[0]?.capability_id).toBe("claude:name:legacy-probe");
});

test("finds Claude's current bare catalog after its system agent preamble", () => {
  const emitted = events({
    request: anthropicMessagesToInteraction({
      model: "dari/routing",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: claudeCommand("current-probe", "review") },
            { type: "text", text: "Review the current change." },
          ],
        },
        {
          role: "system",
          content: "Available agent types for the Agent tool:\n"
            + "- Explore: Search files.\n\n"
            + "The following skills are available for use with the Skill tool:\n\n"
            + "- descriptionless-probe\n"
            + "- current-probe: Current skill\n\n"
            + "While bypass permissions mode is active:\n- Follow policy.",
        },
      ],
    }),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toEqual([
    skillEvent(
      "current-probe",
      "claude:name:current-probe",
      "skill_command_expansion",
      0,
    ),
  ]);
});

test("keeps parsing Claude's catalog after multiline skill descriptions", () => {
  const emitted = events({
    request: anthropicMessagesToInteraction({
      model: "dari/routing",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: claudeCommand("later-probe", "review") },
            { type: "text", text: "Review the current change." },
          ],
        },
        {
          role: "system",
          content: "The following skills are available for use with the Skill tool:\n\n"
            + "- earlier-probe: Earlier skill.\n"
            + "TRIGGER — whenever the request needs the earlier skill.\n"
            + "SKIP only when another workflow owns the request.\n"
            + "- later-probe: Later skill.\n\n"
            + "While bypass permissions mode is active:\n- Follow policy.",
        },
      ],
    }),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toEqual([
    skillEvent(
      "later-probe",
      "claude:name:later-probe",
      "skill_command_expansion",
      0,
    ),
  ]);
});

test("accepts descriptionless entries in Claude's current skill catalog", () => {
  const emitted = events({
    request: request("anthropic_messages", [message("user", [
      {
        type: "text",
        text: "<system-reminder>\n"
          + "The following skills are available for use with the Skill tool:\n\n"
          + "- described-probe: Described skill\n"
          + "- descriptionless-probe\n"
          + "- plugin:review\n"
          + "- apps/web:deploy\n"
          + "</system-reminder>",
      },
      { type: "text", text: claudeCommand("plugin:review", "review") },
      { type: "text", text: "Review the current change." },
      { type: "text", text: claudeCommand("apps/web:deploy", "staging") },
      { type: "text", text: "Deploy the web application." },
    ])]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted.map((event) => event.capability_id)).toEqual([
    "claude:name:plugin:review",
    "claude:name:apps/web:deploy",
  ]);
});

test("stops at malformed descriptionless Claude catalog entries", () => {
  const emitted = events({
    request: request("anthropic_messages", [message("user", [
      {
        type: "text",
        text: "<system-reminder>\n"
          + "The following skills are available for use with the Skill tool:\n\n"
          + "- described-probe: Described skill\n"
          + "- invalid skill name\n"
          + "- later-probe\n"
          + "</system-reminder>",
      },
      { type: "text", text: claudeCommand("later-probe", "review") },
      { type: "text", text: "Review the current change." },
    ])]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toEqual([]);
});

test("the latest Claude skill catalog replaces stale historical catalogs", () => {
  const emitted = events({
    request: request("anthropic_messages", [
      message("user", [{ type: "text", text: availableSkills("legacy-probe") }]),
      message("assistant", [{ type: "text", text: "Earlier turn" }]),
      message("user", [
        { type: "text", text: availableSkills("current-probe") },
        { type: "text", text: claudeCommand("legacy-probe", "review") },
        { type: "text", text: "Review the change and return a concise verdict." },
      ]),
    ]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toEqual([]);
});

test("a trailing Claude system catalog replaces stale user catalog evidence", () => {
  const emitted = events({
    request: request("anthropic_messages", [
      message("user", [
        { type: "text", text: availableSkills("legacy-probe") },
        { type: "text", text: claudeCommand("legacy-probe", "review") },
        { type: "text", text: "Review the change and return a concise verdict." },
      ]),
      message("system", [{
        type: "text",
        text: "The following skills are available for use with the Skill tool:\n\n"
          + "- current-probe: Test skill",
      }]),
    ]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toEqual([]);
});

test("does not treat an uncatalogued Claude command body as a skill", () => {
  expect(events({
    request: request("anthropic_messages", [message("user", [
      { type: "text", text: claudeCommand("compact", "") },
      { type: "text", text: "Summarize the conversation." },
    ])]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  })).toEqual([]);
});

test("records an exact direct background skill launch from Claude Code", () => {
  const emitted = events({
    request: request("anthropic_messages", [message("user", [
      {
        type: "text",
        text: "<system-reminder>\n"
          + "The following skills are available for use with the Skill tool:\n\n"
          + "- described-probe: Described skill\n"
          + "- descriptionless-probe\n"
          + "- fork-probe\n"
          + "</system-reminder>",
      },
      { type: "text", text: "/fork-probe background-review\n" },
      {
        type: "text",
        text: "<local-command-stdout>Running in the background as @fork-probe</local-command-stdout>\n"
          + "<forked-skill-launch>{\"agentId\":\"abcdef0123456789a\",\"skillName\":\"fork-probe\",\"description\":\"/fork-probe background-review\"}</forked-skill-launch>\n",
      },
    ])]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toEqual([
    skillEvent(
      "fork-probe",
      "claude:name:fork-probe",
      "skill_command_expansion",
      0,
    ),
  ]);
});

test("records a direct background launch when the current request omits the catalog", () => {
  expect(events({
    request: request("anthropic_messages", [message("user", [
      { type: "text", text: "/fork-probe background-review\n" },
      {
        type: "text",
        text: "<local-command-stdout>Running in the background as @fork-probe</local-command-stdout>\n"
          + "<forked-skill-launch>{\"agentId\":\"abcdef0123456789\",\"skillName\":\"fork-probe\",\"description\":\"/fork-probe background-review\"}</forked-skill-launch>\n",
      },
    ])]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  })).toEqual([
    skillEvent(
      "fork-probe",
      "claude:name:fork-probe",
      "skill_command_expansion",
      0,
    ),
  ]);
});

test("rejects near-miss Claude direct background launch envelopes", () => {
  const validLaunch = {
    agentId: "abcdef0123456789",
    skillName: "fork-probe",
    description: "/fork-probe background-review",
  };
  const cases = [
    { command: "/other background-review", launch: validLaunch },
    { command: "/fork-probe background-review", launch: { ...validLaunch, agentId: "not-hex" } },
    { command: "/fork-probe background-review", launch: { ...validLaunch, skillName: "other" } },
    { command: "/fork-probe background-review", launch: { ...validLaunch, description: "/other" } },
    { command: "/fork-probe background-review", launch: { ...validLaunch, unexpected: true } },
  ];

  for (const [index, testCase] of cases.entries()) {
    const launch = JSON.stringify(testCase.launch);
    expect(events({
      request: request("anthropic_messages", [message("user", [
        { type: "text", text: availableSkills("fork-probe") },
        { type: "text", text: testCase.command },
        {
          type: "text",
          text: "<local-command-stdout>Running in the background as @fork-probe</local-command-stdout>\n"
            + `<forked-skill-launch>${launch}</forked-skill-launch>`,
        },
      ])]),
      output: output(ANTHROPIC),
      identity: CLAUDE,
    }), `case ${index}`).toEqual([]);
  }

  expect(events({
    request: request("anthropic_messages", [message("user", [
      { type: "text", text: availableSkills("fork-probe") },
      { type: "text", text: "/fork-probe background-review" },
      {
        type: "text",
        text: "<local-command-stdout>Running in the background as @other</local-command-stdout>\n"
          + `<forked-skill-launch>${JSON.stringify(validLaunch)}</forked-skill-launch>`,
      },
    ])]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  })).toEqual([]);

  for (const launchLine of [
    "<forked-skill-launch>not-json</forked-skill-launch>",
    `<forked-skill-launch>${JSON.stringify(validLaunch)}</forked-skill-launch>\nextra`,
  ]) {
    expect(events({
      request: request("anthropic_messages", [message("user", [
        { type: "text", text: availableSkills("fork-probe") },
        { type: "text", text: "/fork-probe background-review" },
        {
          type: "text",
          text: "<local-command-stdout>Running in the background as @fork-probe</local-command-stdout>\n"
            + launchLine,
        },
      ])]),
      output: output(ANTHROPIC),
      identity: CLAUDE,
    })).toEqual([]);
  }

  expect(events({
    request: request("anthropic_messages", [message("user", [{
      type: "text",
      text: "/fork-probe background-review\n"
        + "<local-command-stdout>Running in the background as @fork-probe</local-command-stdout>\n"
        + `<forked-skill-launch>${JSON.stringify(validLaunch)}</forked-skill-launch>`,
    }])]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  })).toEqual([]);
});

test("records direct Claude directory-scoped skill activations", () => {
  const emitted = events({
    request: request("anthropic_messages", [message("user", [
      { type: "text", text: claudeCommand("apps/web:deploy", "staging") },
      {
        type: "text",
        text: claudeExpansion("/repo/apps/web/.claude/skills/deploy", "Deploy safely."),
      },
    ])]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  });

  expect(emitted).toEqual([
    skillEvent(
      "apps/web:deploy",
      "claude:name:apps/web:deploy",
      "skill_command_expansion",
      0,
    ),
  ]);
});

test("Claude direct-skill prose is not evidence without separate harness blocks", () => {
  expect(events({
    request: request("anthropic_messages", [message("user", [{
      type: "text",
      text: `${claudeCommand("probe", "")}\n${claudeExpansion("/tmp/probe", "body")}`,
    }])]),
    output: output(ANTHROPIC),
    identity: CLAUDE,
  })).toEqual([]);
});

test("historical Claude direct commands are not replayed on continuations", () => {
  expect(events({
    request: {
      ...request("anthropic_messages", [
        message("user", [
          { type: "text", text: claudeCommand("probe", "") },
          { type: "text", text: claudeExpansion("/repo/probe", "body") },
        ]),
        {
          type: "tool_call",
          callId: "toolu_1",
          kind: "function",
          name: "Read",
          input: {},
        },
        {
          type: "tool_result",
          callId: "toolu_1",
          kind: "function",
          output: "contents",
          outputShape: "string",
        },
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(ANTHROPIC),
    identity: CLAUDE,
  })).toEqual([]);
});
