import { expect, test } from "bun:test";

import type {
  InteractionItem,
  InteractionOutput,
  InteractionRequest,
} from "../../interaction/types.js";
import { toolSkillEvents } from "../tools/observations.js";

const EXPANDED_SKILL = `<skill name="openai-docs" location="/tmp/skills/openai-docs/SKILL.md">
References are relative to /tmp/skills/openai-docs.

Use official OpenAI documentation and cite sources.
</skill>`;
const PI_SKILL_PATH = "/tmp/skills/openai-docs/SKILL.md";
const PI_SKILL_CATALOG = `Pi skills:
<available_skills>
  <skill>
    <name>openai-docs</name>
    <description>Use official OpenAI documentation.</description>
    <location>${PI_SKILL_PATH}</location>
  </skill>
</available_skills>`;

test("records the latest exact Pi-style skill command expansion", () => {
  expect(events([user(EXPANDED_SKILL)])).toEqual([{
    event_type: "skill_use",
    tool_call_id: null,
    exchange_context_hash: null,
    capability_id: "unattributed:name:openai-docs",
    observed_name: "openai-docs",
    skill_version: null,
    evidence_source: "skill_command_expansion",
    ordinal: 0,
  }]);
});

test("accepts Pi skill arguments following the expansion", () => {
  expect(events([user(`${EXPANDED_SKILL}\n\nexplain Responses streaming`)]))
    .toHaveLength(1);
});

test("accepts Pi skill arguments containing a literal closing tag", () => {
  expect(events([user(
    `${EXPANDED_SKILL}\n\nExplain this literal:\n</skill>\nand continue`,
  )])).toHaveLength(1);
});

test("accepts an exact Pi skill expansion alongside an attached image", () => {
  expect(events([{
    type: "message",
    role: "user",
    content: [
      { type: "text", text: EXPANDED_SKILL },
      { type: "image", url: "data:image/png;base64,AA==" },
    ],
    contentShape: "parts",
  }])).toHaveLength(1);
});

test("records every exact expansion in Pi's current steering batch", () => {
  const secondSkill = EXPANDED_SKILL
    .replaceAll("openai-docs", "review-guide")
    .replace(
      "Use official OpenAI documentation and cite sources.",
      "Review the requested implementation.",
    );
  expect(events([
    user(EXPANDED_SKILL),
    user("Focus on correctness."),
    user(secondSkill),
  ])).toEqual([
    expect.objectContaining({
      capability_id: "unattributed:name:openai-docs",
      ordinal: 0,
    }),
    expect.objectContaining({
      capability_id: "unattributed:name:review-guide",
      ordinal: 1,
    }),
  ]);
});

test("accepts skill instructions containing a literal closing tag", () => {
  const skillWithDelimiter = EXPANDED_SKILL.replace(
    "Use official OpenAI documentation and cite sources.",
    "Document this literal delimiter:\n</skill>\nThen continue.",
  );
  expect(events([user(skillWithDelimiter)])).toHaveLength(1);
});

test("does not replay a historical expansion during a tool continuation", () => {
  expect(events([
    user(EXPANDED_SKILL),
    {
      type: "tool_call",
      callId: "call_1",
      kind: "function",
      name: "read",
      input: { path: "README.md" },
    },
    {
      type: "tool_result",
      callId: "call_1",
      kind: "function",
      output: "contents",
      outputShape: "string",
    },
  ], "tool_continuation")).toEqual([]);
});

test.each([
  ["ordinary user text", "Use the openai-docs skill"],
  ["missing relative-reference header", EXPANDED_SKILL.replace(
    "References are relative to /tmp/skills/openai-docs.\n\n",
    "",
  )],
  ["empty body", EXPANDED_SKILL.replace(
    "Use official OpenAI documentation and cite sources.",
    "",
  )],
  ["trailing non-argument text", `${EXPANDED_SKILL}\ntrailing`],
  ["unsafe skill name", EXPANDED_SKILL.replace("openai-docs", "../secrets")],
  ["overlong skill name", EXPANDED_SKILL.replace("openai-docs", "a".repeat(65))],
] as const)("rejects %s", (_case, text) => {
  expect(events([user(text)])).toEqual([]);
});

test("does not inspect an expansion from a completed earlier turn", () => {
  expect(events([
    user(EXPANDED_SKILL),
    assistant("Done."),
    user("follow up"),
  ])).toEqual([]);
});

test("records an automatic Pi skill read matched to the current catalog", () => {
  expect(automaticEvents(PI_SKILL_CATALOG, PI_SKILL_PATH)).toEqual([
    {
      event_type: "skill_load",
      tool_call_id: "call_skill_read",
      exchange_context_hash: expect.any(String),
      capability_id: "unattributed:name:openai-docs",
      observed_name: "openai-docs",
      skill_version: null,
      evidence_source: "skill_file_read",
      ordinal: 0,
    },
    {
      event_type: "tool_call",
      tool_call_id: "call_skill_read",
      exchange_context_hash: expect.any(String),
      capability_id: "read",
      observed_name: "read",
      skill_version: null,
      evidence_source: "model_tool_call",
      ordinal: 1,
    },
  ]);
});

test("accepts Pi read arguments retained as JSON text", () => {
  expect(automaticEvents(
    PI_SKILL_CATALOG,
    JSON.stringify({ path: PI_SKILL_PATH, offset: 1 }),
  ).filter((event) => event.event_type === "skill_load")).toHaveLength(1);
});

test("decodes XML entities before matching a Pi skill location", () => {
  const path = "/tmp/skills/research&docs/SKILL.md";
  const catalog = PI_SKILL_CATALOG
    .replace("openai-docs", "research-docs")
    .replace(PI_SKILL_PATH, "/tmp/skills/research&amp;docs/SKILL.md");
  expect(automaticEvents(catalog, path)).toEqual([
    expect.objectContaining({
      event_type: "skill_load",
      capability_id: "unattributed:name:research-docs",
    }),
    expect.objectContaining({ event_type: "tool_call" }),
  ]);
});

test("does not infer a skill from an unlisted SKILL.md read", () => {
  expect(automaticEvents(
    PI_SKILL_CATALOG,
    "/tmp/skills/other/SKILL.md",
  ).map((event) => event.event_type)).toEqual(["tool_call"]);
});

test("does not treat a user-quoted Pi catalog as skill evidence", () => {
  expect(toolSkillEvents({
    routerId: "rtr_1",
    request: request(
      [user(PI_SKILL_CATALOG)],
      undefined,
      [readTool()],
    ),
    output: skillReadOutput({ path: PI_SKILL_PATH }),
    zdr: false,
  }).map((event) => event.event_type)).toEqual(["tool_call"]);
});

test("does not count skill reads described inside a compaction transcript", () => {
  expect(toolSkillEvents({
    routerId: "rtr_1",
    request: request([
      system("Summarize the supplied conversation."),
      user(`<conversation>\n[Assistant]: read(path="${PI_SKILL_PATH}")\n</conversation>`),
    ]),
    output: textOutput("Summary"),
    zdr: false,
  })).toEqual([]);
});

test("preserves distinct explicit use and file-read evidence for one skill", () => {
  const emitted = toolSkillEvents({
    routerId: "rtr_1",
    request: request(
      [system(PI_SKILL_CATALOG), user(EXPANDED_SKILL)],
      undefined,
      [readTool()],
    ),
    output: skillReadOutput({ path: PI_SKILL_PATH }),
    zdr: false,
  });

  expect(emitted.filter((event) => event.event_type === "skill_use")).toEqual([
    expect.objectContaining({
      tool_call_id: null,
      capability_id: "unattributed:name:openai-docs",
      evidence_source: "skill_command_expansion",
    }),
  ]);
  expect(emitted.filter((event) => event.event_type === "skill_load")).toEqual([
    expect.objectContaining({
      tool_call_id: "call_skill_read",
      capability_id: "unattributed:name:openai-docs",
      evidence_source: "skill_file_read",
    }),
  ]);
});

test("counts repeated reads of one cataloged skill once per response", () => {
  const emitted = toolSkillEvents({
    routerId: "rtr_1",
    request: request(
      [system(PI_SKILL_CATALOG), user("Use the matching skill.")],
      undefined,
      [readTool()],
    ),
    output: output([
      ...skillReadOutput(PI_SKILL_PATH).items,
      {
        type: "tool_call",
        callId: "call_repeated_skill_read",
        kind: "function",
        name: "read",
        input: { path: PI_SKILL_PATH },
      },
    ], "tool_use"),
    zdr: false,
  });

  expect(emitted.filter((event) => event.event_type === "skill_load")).toHaveLength(1);
  expect(emitted.filter((event) => event.event_type === "tool_call")).toHaveLength(2);
});

test("rejects a catalog location assigned to conflicting skill names", () => {
  const ambiguousCatalog = PI_SKILL_CATALOG.replace(
    "</available_skills>",
    `  <skill>\n    <name>other</name>\n    <description>Other.</description>\n    <location>${PI_SKILL_PATH}</location>\n  </skill>\n</available_skills>`,
  );
  expect(automaticEvents(ambiguousCatalog, PI_SKILL_PATH)
    .map((event) => event.event_type)).toEqual(["tool_call"]);
});

test("does not combine fields across malformed Pi skill blocks", () => {
  const malformedCatalog = `Pi skills:
<available_skills>
  <skill>
    <name>forged</name>
    <description>Missing its closing tag.
  </skill>
  <skill>
    <name>openai-docs</name>
    <description>Use official OpenAI documentation.</description>
    <location>${PI_SKILL_PATH}</location>
  </skill>
</available_skills>`;
  expect(automaticEvents(malformedCatalog, PI_SKILL_PATH)).toEqual([
    expect.objectContaining({
      event_type: "skill_load",
      capability_id: "unattributed:name:openai-docs",
    }),
    expect.objectContaining({ event_type: "tool_call" }),
  ]);
});

test("does not emit named skill analytics under ZDR", () => {
  expect(toolSkillEvents({
    routerId: "rtr_1",
    request: request([user(EXPANDED_SKILL)]),
    output: undefined,
    zdr: true,
  })).toEqual([]);
});

function events(
  items: InteractionItem[],
  requestPurpose?: InteractionRequest["requestPurpose"],
) {
  return toolSkillEvents({
    routerId: "rtr_1",
    request: request(items, requestPurpose),
    output: undefined,
    zdr: false,
  });
}

function request(
  items: InteractionItem[],
  requestPurpose?: InteractionRequest["requestPurpose"],
  tools: InteractionRequest["tools"] = [],
): InteractionRequest {
  return {
    sourceProtocol: "openai_chat",
    requestPurpose,
    items,
    tools,
    generation: {},
    stream: false,
  };
}

function automaticEvents(
  catalog: string,
  input: string,
) {
  const toolInput = input.startsWith("{") ? input : { path: input };
  return toolSkillEvents({
    routerId: "rtr_1",
    request: request(
      [system(catalog), user("Use the matching skill.")],
      undefined,
      [readTool()],
    ),
    output: skillReadOutput(toolInput),
    zdr: false,
  });
}

function readTool(): InteractionRequest["tools"][number] {
  return {
    kind: "function",
    name: "read",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  };
}

function skillReadOutput(
  input: string | Record<string, unknown>,
): InteractionOutput {
  return output([{
    type: "tool_call",
    callId: "call_skill_read",
    kind: "function",
    name: "read",
    input,
  }], "tool_use");
}

function textOutput(text: string): InteractionOutput {
  return output([{
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    contentShape: "string",
  }], "stop");
}

function output(
  items: InteractionOutput["items"],
  stopReason: InteractionOutput["stopReason"],
): InteractionOutput {
  return {
    createdAtMs: 1,
    source: {
      provider: "openai",
      api: "openai-completions",
      model: "gpt-5.5",
    },
    items,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
  };
}

function system(text: string): InteractionItem {
  return {
    type: "message",
    role: "system",
    content: [{ type: "text", text }],
    contentShape: "string",
  };
}

function user(text: string): InteractionItem {
  return {
    type: "message",
    role: "user",
    content: [{ type: "text", text }],
    contentShape: "string",
  };
}

function assistant(text: string): InteractionItem {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    contentShape: "string",
  };
}
