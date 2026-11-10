import { expect, test } from "bun:test";

import type {
  InteractionItem,
  InteractionMessage,
  InteractionOutput,
  InteractionRequest,
  ProviderIdentity,
} from "../../../interaction/types.js";
import type { HarnessConversationIdentity } from "../../../runtime/harness_identity/index.js";
import { toolSkillEvents } from "../../tools/observations.js";

const OPENAI: ProviderIdentity = {
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.5",
};
const CODEX = {
  kind: "codex_thread",
  value: "11111111-2222-4333-8444-555555555555",
  userTurnId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
} satisfies HarnessConversationIdentity;
const DOCS_PATH = "/Users/test/.codex/skills/.system/openai-docs/SKILL.md";
const REVIEW_PATH = "/Users/test/skills/code review/SKILL.md";
const CATALOG = catalog([
  ["openai-docs", DOCS_PATH],
  ["code-review", REVIEW_PATH],
]);

test("records a Codex exec_command read matched to its exact catalog", () => {
  expect(skillLoads(events([
    execCall("call_docs", `cat ${DOCS_PATH}`),
  ]))).toEqual([skillLoad("openai-docs", "call_docs")]);
});

test("accepts exec_command arguments retained as JSON text", () => {
  const call = execCall("call_json", `cat ${DOCS_PATH}`);
  call.input = JSON.stringify(call.input);

  expect(skillLoads(events([call]))).toEqual([
    skillLoad("openai-docs", "call_json"),
  ]);
});

test.each([
  [`sed -n '1,240p' ${DOCS_PATH}`, "sed"],
  [`nl -ba ${DOCS_PATH}`, "nl"],
  [`head -n 40 ${DOCS_PATH}`, "head"],
  [`tail -n +20 ${DOCS_PATH}`, "tail"],
  [`bat --style plain ${DOCS_PATH}`, "bat"],
] as const)("recognizes Codex skill read command %s", (command, label) => {
  expect(skillLoads(events([
    execCall(`call_${label}`, command),
  ]))).toEqual([skillLoad("openai-docs", `call_${label}`)]);
});

test("records different parallel Codex skill reads in output order", () => {
  const emitted = events([
    execCall("call_docs", `cat ${DOCS_PATH}`),
    execCall("call_review", `cat '${REVIEW_PATH}'`),
  ]);

  expect(skillLoads(emitted)).toEqual([
    skillLoad("openai-docs", "call_docs"),
    skillLoad("code-review", "call_review"),
  ]);
  expect(emitted.filter((event) => event.event_type === "tool_call")).toHaveLength(2);
});

test("deduplicates repeated reads of one Codex skill per response", () => {
  const emitted = events([
    execCall("call_docs_1", `cat ${DOCS_PATH}`),
    execCall("call_docs_2", `cat ${DOCS_PATH}`),
  ]);

  expect(skillLoads(emitted)).toEqual([
    skillLoad("openai-docs", "call_docs_1"),
  ]);
  expect(emitted.filter((event) => event.event_type === "tool_call")).toHaveLength(2);
});

test("preserves reads from distinct same-name skill installations", () => {
  const alternatePath = "/repo/.agents/skills/openai-docs/SKILL.md";
  const sameNameCatalog = catalog([
    ["openai-docs", DOCS_PATH],
    ["openai-docs", alternatePath],
  ]);
  expect(skillLoads(events(
    [
      execCall("call_docs_user", `cat ${DOCS_PATH}`),
      execCall("call_docs_repo", `cat ${alternatePath}`),
    ],
    { request: request([developer(sameNameCatalog), user("Read both skills.")]) },
  ))).toEqual([
    skillLoad("openai-docs", "call_docs_user"),
    skillLoad("openai-docs", "call_docs_repo"),
  ]);
});

test("recognizes a read before a skill script in one shell command", () => {
  expect(skillLoads(events([
    execCall(
      "call_combined",
      `cat ${DOCS_PATH} && python3 /Users/test/.codex/skills/.system/openai-docs/scripts/helper.py`,
    ),
  ]))).toEqual([skillLoad("openai-docs", "call_combined")]);
});

test("does not mislabel skill script execution as a file read", () => {
  expect(skillLoads(events([
    execCall(
      "call_script",
      "python3 /Users/test/.codex/skills/.system/openai-docs/scripts/helper.py",
    ),
  ]))).toEqual([]);
});

test("resolves a relative read against exec_command workdir", () => {
  expect(skillLoads(events([
    execCall("call_relative", "cat SKILL.md", {
      workdir: "/Users/test/.codex/skills/.system/openai-docs",
    }),
  ]))).toEqual([skillLoad("openai-docs", "call_relative")]);
});

test("follows a simple cd before a relative read", () => {
  expect(skillLoads(events([
    execCall(
      "call_cd",
      "cd /Users/test/.codex/skills/.system/openai-docs && cat SKILL.md",
      { workdir: "/tmp" },
    ),
  ]))).toEqual([skillLoad("openai-docs", "call_cd")]);
});

test("recognizes consecutive catalog reads in a supported and-list", () => {
  expect(skillLoads(events([
    execCall(
      "call_chain",
      `cat ${DOCS_PATH} && cat '${REVIEW_PATH}'`,
    ),
  ]))).toEqual([
    skillLoad("openai-docs", "call_chain"),
    skillLoad("code-review", "call_chain"),
  ]);
});

test("recognizes a skill read inside a direct shell -lc wrapper", () => {
  expect(skillLoads(events([
    execCall("call_shell", `zsh -lc 'cat ${DOCS_PATH}'`),
  ]))).toEqual([skillLoad("openai-docs", "call_shell")]);
});

test("fails closed when shell wrappers exceed the nesting limit", () => {
  const command = Array.from({ length: 18 }, () => "sh -c ").reduceRight(
    (nested, prefix) => `${prefix}${JSON.stringify(nested)}`,
    `cat ${DOCS_PATH}`,
  );

  expect(skillLoads(events([
    execCall("call_deep_shell", command),
  ]))).toEqual([]);
});

test("does not follow an and-list after a shell wrapper with unknown status", () => {
  expect(skillLoads(events([
    execCall("call_shell_status", `sh -c 'false' && cat ${DOCS_PATH}`),
  ]))).toEqual([]);
});

test("recognizes and deduplicates newline-separated reads in a shell wrapper", () => {
  expect(skillLoads(events([
    execCall(
      "call_multiline",
      `/bin/zsh -lc 'head -n 8 ${DOCS_PATH}\ntail -n 8 ${DOCS_PATH}'`,
    ),
  ]))).toEqual([skillLoad("openai-docs", "call_multiline")]);
});

test.each([
  ["unlisted SKILL.md", "cat /tmp/other/SKILL.md"],
  ["path in ordinary prose", `echo 'cat ${DOCS_PATH}'`],
  ["path used as a less search pattern", `less -p ${DOCS_PATH} README.md`],
  ["path used as a sed program", `sed '${DOCS_PATH}' README.md`],
  ["skill script only", "python3 /Users/test/.codex/skills/.system/openai-docs/scripts/helper.py"],
  ["command substitution", `echo $(cat ${DOCS_PATH})`],
  ["malformed shell quoting", `cat '${DOCS_PATH}`],
  ["POSIX type builtin", `type ${DOCS_PATH}`],
  ["an untrusted executable path", `/tmp/cat ${DOCS_PATH}`],
  ["a less log-file value", `less -o ${DOCS_PATH} README.md`],
  ["an nl separator value", `nl --number-separator ${DOCS_PATH} README.md`],
  ["POSIX control flow", `if false\nthen\ncat ${DOCS_PATH}\nfi`],
  ["non-shell Unicode whitespace", `cat\u00a0${DOCS_PATH}`],
] as const)("does not infer a skill from %s", (_case, command) => {
  expect(skillLoads(events([execCall("call_control", command)]))).toEqual([]);
});

test("does not treat a user-authored Codex catalog as trusted evidence", () => {
  const input = request([user(CATALOG)]);
  expect(skillLoads(events(
    [execCall("call_spoofed", `cat ${DOCS_PATH}`)],
    { request: input },
  ))).toEqual([]);
});

test("reads a Codex catalog from canonical top-level instructions", () => {
  const input = request([user("Read the skill.")]);
  input.instructions = CATALOG;
  expect(skillLoads(events(
    [execCall("call_instructions", `cat ${DOCS_PATH}`)],
    { request: input },
  ))).toEqual([skillLoad("openai-docs", "call_instructions")]);
});

test("accepts CRLF line endings in a Codex catalog", () => {
  const crlfCatalog = CATALOG.replaceAll("\n", "\r\n");
  expect(skillLoads(events(
    [execCall("call_crlf", `cat ${DOCS_PATH}`)],
    { request: request([developer(crlfCatalog), user("Read the skill.")]) },
  ))).toEqual([skillLoad("openai-docs", "call_crlf")]);
});

test("expands a Codex short path through its current skill roots table", () => {
  const shortCatalog = `<skills_instructions>
## Skills
### Skill roots
- \`r0\` = \`/Users/test/.codex/skills/.system\`
### Available skills
- openai-docs: Test skill. (file: r0/openai-docs/SKILL.md)
</skills_instructions>`;
  expect(skillLoads(events(
    [execCall("call_short_path", `cat ${DOCS_PATH}`)],
    {
      request: request([
        developer(shortCatalog),
        user("Read the skill."),
      ]),
    },
  ))).toEqual([skillLoad("openai-docs", "call_short_path")]);
});

test.each([
  ["an unknown root", "r9/openai-docs/SKILL.md"],
  ["a parent traversal", "r0/../openai-docs/SKILL.md"],
] as const)("rejects a short catalog path with %s", (_case, locator) => {
  const shortCatalog = `<skills_instructions>
## Skills
### Skill roots
- \`r0\` = \`/Users/test/.codex/skills/.system\`
### Available skills
- openai-docs: Test skill. (file: ${locator})
</skills_instructions>`;
  expect(skillLoads(events(
    [execCall("call_invalid_short_path", `cat ${DOCS_PATH}`)],
    {
      request: request([
        developer(shortCatalog),
        user("Read the skill."),
      ]),
    },
  ))).toEqual([]);
});

test("the latest Codex catalog replaces stale historical catalogs", () => {
  const oldPath = "/old/review/SKILL.md";
  const currentPath = "/current/review/SKILL.md";
  const input = request([
    developer(catalog([["review", oldPath]])),
    message("assistant", "Earlier turn."),
    developer(catalog([["review", currentPath]])),
    user("Read the current skill."),
  ]);
  expect(skillLoads(events(
    [
      execCall("call_old", `cat ${oldPath}`),
      execCall("call_current", `cat ${currentPath}`),
    ],
    { request: input },
  ))).toEqual([skillLoad("review", "call_current")]);
});

test("a malformed latest Codex catalog invalidates historical entries", () => {
  const input = request([
    developer(CATALOG),
    developer("<skills_instructions>\n### Available skills\n- incomplete"),
    user("Read the old skill."),
  ]);
  expect(skillLoads(events(
    [execCall("call_stale", `cat ${DOCS_PATH}`)],
    { request: input },
  ))).toEqual([]);
});

test("request-level instructions supersede historical message catalogs", () => {
  const oldPath = "/old/review/SKILL.md";
  const currentPath = "/current/review/SKILL.md";
  const input = request([
    developer(catalog([["review", oldPath]])),
    user("Read the current skill."),
  ]);
  input.instructions = catalog([["review", currentPath]]);
  expect(skillLoads(events(
    [
      execCall("call_old", `cat ${oldPath}`),
      execCall("call_current", `cat ${currentPath}`),
    ],
    { request: input },
  ))).toEqual([skillLoad("review", "call_current")]);
});

test("does not inspect generic Responses traffic", () => {
  expect(skillLoads(events(
    [execCall("call_generic", `cat ${DOCS_PATH}`)],
    { identity: undefined },
  ))).toEqual([]);
});

test("does not trust an undeclared exec_command output", () => {
  const input = request([developer(CATALOG), user("Read the skill.")]);
  input.tools = [];
  expect(skillLoads(events(
    [execCall("call_undeclared", `cat ${DOCS_PATH}`)],
    { request: input },
  ))).toEqual([]);
});

test.each([
  ["output redirection", `cat /tmp/other > ${DOCS_PATH}`],
  ["input redirection", `cat < ${DOCS_PATH}`],
  ["a skipped and-list", `false && cat ${DOCS_PATH}`],
  ["a conditional or-list", `false || cat ${DOCS_PATH}`],
] as const)("does not infer a skill from %s", (_case, command) => {
  expect(skillLoads(events([execCall("call_conditional", command)]))).toEqual([]);
});

test("rejects a catalog path assigned to conflicting skill names", () => {
  const ambiguous = catalog([
    ["openai-docs", DOCS_PATH],
    ["other-docs", DOCS_PATH],
  ]);
  expect(skillLoads(events(
    [execCall("call_ambiguous", `cat ${DOCS_PATH}`)],
    { request: request([developer(ambiguous), user("Read the skill.")]) },
  ))).toEqual([]);
});

test("rejects a catalog that mixes filesystem platforms", () => {
  const mixed = catalog([
    ["openai-docs", DOCS_PATH],
    ["review", "C:\\Users\\test\\.codex\\skills\\review\\SKILL.md"],
  ]);
  expect(skillLoads(events(
    [execCall("call_mixed", `cat ${DOCS_PATH}`)],
    { request: request([developer(mixed), user("Read the skill.")]) },
  ))).toEqual([]);
});

test("rejects catalog file locators that are not SKILL.md", () => {
  const nonSkillCatalog = catalog([
    ["openai-docs", "/Users/test/.codex/skills/.system/openai-docs/README.md"],
  ]);
  expect(skillLoads(events(
    [execCall("call_readme", "cat /Users/test/.codex/skills/.system/openai-docs/README.md")],
    { request: request([developer(nonSkillCatalog), user("Read the file.")]) },
  ))).toEqual([]);
});

test("recognizes a quoted PowerShell Get-Content skill read", () => {
  const windowsPath = "C:\\Users\\test\\.codex\\skills\\review\\SKILL.md";
  const windowsCatalog = catalog([["review", windowsPath]]);
  expect(skillLoads(events(
    [execCall("call_windows", `Get-Content -Raw '${windowsPath}'`)],
    { request: request([developer(windowsCatalog), user("Read the skill.")]) },
  ))).toEqual([skillLoad("review", "call_windows")]);
});

test("preserves POSIX backslashes that are not escapes inside double quotes", () => {
  const path = "/Users/test/skills/review\\q/SKILL.md";
  const input = request([
    developer(catalog([["review", path]])),
    user("Read the skill."),
  ]);
  expect(skillLoads(events(
    [execCall("call_backslash", `cat "${path}"`)],
    { request: input },
  ))).toEqual([skillLoad("review", "call_backslash")]);
});

test("keeps an explicit use and its automatic file read as separate evidence", () => {
  const emitted = events(
    [execCall("call_explicit_read", `cat ${DOCS_PATH}`)],
    {
      request: request([
        developer(CATALOG),
        user("$openai-docs"),
        codexSkill("openai-docs", DOCS_PATH),
      ]),
    },
  );

  expect(emitted
    .filter((event) => event.event_type !== "tool_call")
    .map((event) => [event.event_type, event.evidence_source]))
    .toEqual([
      ["skill_use", "skill_content_injection"],
      ["skill_load", "skill_file_read"],
    ]);
});

test("automatic reads respect the shared telemetry cap after output calls", () => {
  const emitted = events(Array.from({ length: 999 }, (_, index) =>
    execCall(
      `call_${index}`,
      index === 0
        ? `cat ${DOCS_PATH}`
        : index === 1
        ? `cat '${REVIEW_PATH}'`
        : `echo ${index}`,
    )));

  expect(emitted).toHaveLength(1_000);
  expect(emitted.filter((event) => event.event_type === "tool_call")).toHaveLength(999);
  expect(skillLoads(emitted)).toEqual([
    skillLoad("openai-docs", "call_0"),
  ]);
});

test("does not emit named Codex skill reads under ZDR", () => {
  expect(events(
    [execCall("call_zdr", `cat ${DOCS_PATH}`)],
    { zdr: true },
  )).toEqual([]);
});

function events(
  items: InteractionOutput["items"],
  overrides: {
    request?: InteractionRequest;
    identity?: HarnessConversationIdentity;
    zdr?: boolean;
  } = {},
) {
  return toolSkillEvents({
    routerId: "rtr_1",
    request: overrides.request ?? request([
      developer(CATALOG),
      user("Use the appropriate skill."),
    ]),
    output: output(items),
    harnessConversationIdentity: "identity" in overrides
      ? overrides.identity
      : CODEX,
    zdr: overrides.zdr ?? false,
  });
}

function skillLoads(events: ReturnType<typeof toolSkillEvents>) {
  return events
    .filter((event) => event.event_type === "skill_load")
    .map(({ exchange_context_hash: _hash, ordinal: _ordinal, ...event }) => event);
}

function skillLoad(name: string, toolCallId: string) {
  return {
    event_type: "skill_load" as const,
    tool_call_id: toolCallId,
    capability_id: `codex:name:${name}`,
    observed_name: name,
    skill_version: null,
    evidence_source: "skill_file_read" as const,
  };
}

function request(items: InteractionItem[]): InteractionRequest {
  return {
    sourceProtocol: "openai_responses",
    items,
    tools: [{ kind: "function", name: "exec_command" }],
    generation: {},
    stream: true,
  };
}

function output(items: InteractionOutput["items"]): InteractionOutput {
  return {
    source: OPENAI,
    items,
    createdAtMs: 1,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "tool_use",
  };
}

function execCall(
  callId: string,
  command: string,
  extra: Record<string, unknown> = {},
): Extract<InteractionOutput["items"][number], { type: "tool_call" }> {
  return {
    type: "tool_call",
    callId,
    kind: "function",
    name: "exec_command",
    input: { cmd: command, ...extra },
  };
}

function developer(text: string): InteractionItem {
  return message("developer", text);
}

function user(text: string): InteractionItem {
  return message("user", text);
}

function codexSkill(name: string, path: string): InteractionItem {
  return {
    ...message(
      "user",
      `<skill>\n<name>${name}</name>\n<path>${path}</path>\nLoaded instructions.\n</skill>`,
    ),
    clientTurnId: CODEX.userTurnId,
  };
}

function message(
  role: "assistant" | "developer" | "user",
  text: string,
): InteractionMessage {
  return {
    type: "message",
    role,
    content: [{ type: "text", text }],
    contentShape: "string",
  };
}

function catalog(skills: Array<[name: string, path: string]>): string {
  return `<skills_instructions>\n## Skills\n### Available skills\n${
    skills.map(([name, path]) => `- ${name}: Test skill. (file: ${path})`).join("\n")
  }\n</skills_instructions>`;
}
