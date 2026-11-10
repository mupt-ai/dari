import { expect, test } from "bun:test";

import type {
  InteractionContent,
  InteractionItem,
  InteractionOutput,
  InteractionRequest,
  ProviderIdentity,
} from "../../../interaction/types.js";
import type { HarnessConversationIdentity } from "../../../runtime/harness_identity/index.js";
import { toolSkillEvents } from "../../tools/observations.js";
import { codexExplicitSkillObservations } from "./explicit.js";

const OPENAI: ProviderIdentity = {
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.5",
};
const CODEX: HarnessConversationIdentity = {
  kind: "codex_thread",
  value: "11111111-2222-4333-8444-555555555555",
  userTurnId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
};

test("records current-turn Codex skill injections in wire order", () => {
  const emitted = events({
    request: request([
      message("user", [{ type: "text", text: "$first $second answer now" }]),
      codexSkill("second", "/repo/.agents/skills/second/SKILL.md"),
      codexSkill("first", "/repo/.agents/skills/first/SKILL.md"),
    ]),
    output: output(),
    identity: CODEX,
  });

  expect(emitted).toEqual([
    skillEvent("second", 0),
    skillEvent("first", 1),
  ]);
});

test("Codex accepts current-turn tagged skill wrappers without prompt syntax", () => {
  const emitted = events({
    request: request([
      message("user", [{ type: "text", text: "Review this change" }], CODEX.userTurnId),
      codexSkill(
        "review",
        "/repo/.agents/skills/review/SKILL.md",
        "Instructions",
        CODEX.userTurnId,
      ),
    ]),
    output: output(),
    identity: CODEX,
  });

  expect(emitted).toEqual([skillEvent("review", 0)]);
});

test("Codex matches item turn UUIDs regardless of letter casing", () => {
  const uppercaseTurnId = CODEX.userTurnId!.toUpperCase();
  const emitted = events({
    request: request([
      message("user", [{ type: "text", text: "Review this change" }], uppercaseTurnId),
      codexSkill(
        "review",
        "/repo/review/SKILL.md",
        "Instructions",
        uppercaseTurnId,
      ),
    ]),
    output: output(),
    identity: CODEX,
  });

  expect(emitted).toEqual([skillEvent("review", 0)]);
});

test("Codex reconciles mixed tagged and mention-correlated wrappers in wire order", () => {
  const emitted = events({
    request: request([
      message("user", [{ type: "text", text: "$fallback then review" }]),
      codexSkill("fallback", "/repo/fallback/SKILL.md"),
      codexSkill(
        "review",
        "/repo/review/SKILL.md",
        "Instructions",
        CODEX.userTurnId,
      ),
    ]),
    output: output(),
    identity: CODEX,
  });

  expect(emitted).toEqual([
    skillEvent("fallback", 0),
    skillEvent("review", 1),
  ]);
});

test("Codex rejects a skill wrapper tagged for another turn", () => {
  expect(events({
    request: request([
      message("user", [{ type: "text", text: "$review this change" }]),
      codexSkill("review", "/repo/review/SKILL.md", "Instructions", "turn_other"),
    ]),
    output: output(),
    identity: CODEX,
  })).toEqual([]);
});

test("Codex fallback tolerates later plugin and extension injections", () => {
  const emitted = events({
    request: request([
      message("user", [{ type: "text", text: "$review this change" }]),
      codexSkill("review", "/repo/.agents/skills/review/SKILL.md"),
      message("user", [{ type: "text", text: "<plugin_instructions>plugin</plugin_instructions>" }]),
      message("user", [{ type: "text", text: "<extension_instructions>extension</extension_instructions>" }]),
    ]),
    output: output(),
    identity: CODEX,
  });

  expect(emitted).toEqual([skillEvent("review", 0)]);
});

test("Codex name identity is stable across installation paths", () => {
  const before = events({
    request: request([
      message("user", [{ type: "text", text: "$review" }]),
      codexSkill("review", "/repo/.agents/skills/review/SKILL.md", "Original instructions"),
    ]),
    output: output(),
    identity: CODEX,
  });
  const after = events({
    request: request([
      message("user", [{ type: "text", text: "$review" }]),
      codexSkill("review", "/Users/alex/.codex/skills/review/SKILL.md", "Revised instructions"),
    ]),
    output: output(),
    identity: CODEX,
  });

  expect(before[0]?.capability_id).toBe(after[0]?.capability_id);
  expect(before[0]?.capability_id).toBe("codex:name:review");
  expect(before[0]?.observed_name).toBe("review");
  expect(after[0]?.observed_name).toBe("review");
  expect(after[0]?.skill_version).toBeNull();
});

test("Codex deduplicates repeated wrappers for the same injected skill", () => {
  const emitted = events({
    request: request([
      message("user", [{ type: "text", text: "$review" }]),
      codexSkill("review", "/repo/.agents/skills/review/SKILL.md"),
      codexSkill("review", "/repo/.agents/skills/review/SKILL.md"),
    ]),
    output: output(),
    identity: CODEX,
  });

  expect(emitted).toHaveLength(1);
  expect(emitted[0]?.capability_id).toBe("codex:name:review");
});

test("Codex retains separate same-name invocations from distinct skill paths", () => {
  const emitted = events({
    request: request([
      message("user", [{
        type: "text",
        text: "$review /repo/.agents/skills/review/SKILL.md /Users/alex/.agents/skills/review/SKILL.md",
      }]),
      codexSkill("review", "/repo/.agents/skills/review/SKILL.md"),
      codexSkill("review", "/Users/alex/.agents/skills/review/SKILL.md"),
    ]),
    output: output(),
    identity: CODEX,
  });

  expect(emitted.map((event) => event.capability_id)).toEqual([
    "codex:name:review",
    "codex:name:review",
  ]);
  expect(emitted.map((event) => event.ordinal)).toEqual([0, 1]);
});

test("Codex injection detection fails closed without validated current-turn identity", () => {
  const input = request([
    message("user", [{ type: "text", text: "$probe" }]),
    codexSkill("probe", "/repo/probe/SKILL.md"),
  ]);

  expect(events({ request: input, output: output() })).toEqual([]);
  expect(events({
    request: input,
    output: output(),
    identity: { kind: "codex_thread", value: CODEX.value },
  })).toEqual([]);
});

test("literal Codex skill markup is not treated as an invocation", () => {
  expect(events({
    request: request([
      message("user", [{ type: "text", text: "Explain this markup" }]),
      codexSkill("spoofed", "/tmp/spoofed/SKILL.md"),
    ]),
    output: output(),
    identity: CODEX,
  })).toEqual([]);
});

test("historical Codex injections are not replayed on tool continuations", () => {
  expect(events({
    request: {
      ...request([
        message("user", [{ type: "text", text: "$probe" }]),
        codexSkill("probe", "/repo/probe/SKILL.md"),
        {
          type: "tool_call",
          callId: "call_1",
          kind: "function",
          name: "read_file",
          input: { path: "README.md" },
        },
        {
          type: "tool_result",
          callId: "call_1",
          kind: "function",
          output: "contents",
          outputShape: "string",
        },
      ]),
      requestPurpose: "tool_continuation",
    },
    output: output(),
    identity: CODEX,
  })).toEqual([]);
});

test("tagged Codex injections are not replayed from a full-context continuation", () => {
  expect(events({
    request: request([
      message("user", [{ type: "text", text: "Run the review" }], CODEX.userTurnId),
      codexSkill(
        "review",
        "/repo/review/SKILL.md",
        "Instructions",
        CODEX.userTurnId,
      ),
      {
        type: "tool_call",
        callId: "call_1",
        kind: "function",
        name: "read_file",
        input: { path: "README.md" },
      },
      {
        type: "tool_result",
        callId: "call_1",
        kind: "function",
        output: "contents",
        outputShape: "string",
      },
    ]),
    output: output(),
    identity: CODEX,
  })).toEqual([]);
});

test("malformed Codex wrappers are ignored without dropping valid output tools", () => {
  const emitted = events({
    request: request([
      message("user", [{ type: "text", text: "$probe" }]),
      message("user", [{
        type: "text",
        text: "<skill>\n<name>probe</name>\n<path>/repo/probe/SKILL.md</path>\n\n</skill>",
      }]),
    ]),
    output: output([{
      type: "tool_call",
      callId: "call_1",
      kind: "function",
      name: "read_file",
      input: {},
    }]),
    identity: CODEX,
  });

  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({
    event_type: "tool_call",
    observed_name: "read_file",
    ordinal: 0,
  });
});

test("output tool calls retain priority at the shared telemetry cap", () => {
  const emitted = events({
    request: request([
      message("user", [{ type: "text", text: "$first $second" }]),
      codexSkill("first", "/repo/first/SKILL.md"),
      codexSkill("second", "/repo/second/SKILL.md"),
    ]),
    output: output(Array.from({ length: 999 }, (_, index) => ({
      type: "tool_call" as const,
      callId: `call_${index}`,
      kind: "function" as const,
      name: "read_file",
      input: { index },
    }))),
    identity: CODEX,
  });

  expect(emitted).toHaveLength(1000);
  expect(emitted.filter((event) => event.event_type === "tool_call")).toHaveLength(999);
  expect(emitted.filter((event) => event.event_type === "skill_use")).toEqual([
    skillEvent("first", 0),
  ]);
});

test("Codex scans a large trailing user group without replaying old wrappers", () => {
  const observed = codexExplicitSkillObservations(request([
    message("user", [{ type: "text", text: "$probe" }]),
    ...Array.from({ length: 5_000 }, (_, index) =>
      message("user", [{ type: "text", text: `<plugin_instructions>${index}</plugin_instructions>` }])
    ),
    codexSkill("probe", "/repo/probe/SKILL.md"),
  ]), CODEX.userTurnId!, 1_000);

  expect(observed).toEqual([{
    eventType: "skill_use",
    toolCallId: null,
    capabilityId: "codex:name:probe",
    observedName: "probe",
    evidenceSource: "skill_content_injection",
  }]);
});

function events(args: {
  request: InteractionRequest;
  output: InteractionOutput;
  identity?: HarnessConversationIdentity;
}) {
  return toolSkillEvents({
    routerId: "rtr_1",
    request: args.request,
    output: args.output,
    harnessConversationIdentity: args.identity,
    zdr: false,
  });
}

function request(items: InteractionItem[]): InteractionRequest {
  return {
    sourceProtocol: "openai_responses",
    items,
    tools: [],
    generation: {},
    stream: true,
  };
}

function output(
  items: InteractionOutput["items"] = [
    message("assistant", [{ type: "text", text: "done" }]),
  ],
): InteractionOutput {
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
    stopReason: "stop",
  };
}

function message(
  role: "system" | "developer" | "user" | "assistant",
  content: InteractionContent[],
  clientTurnId?: string,
): Extract<InteractionItem, { type: "message" }> {
  return {
    type: "message",
    role,
    content,
    contentShape: "parts",
    ...(clientTurnId === undefined ? {} : { clientTurnId }),
  };
}

function codexSkill(
  name: string,
  path: string,
  body = "Instructions",
  clientTurnId?: string,
) {
  return message("user", [{
    type: "text",
    text: `<skill>\n<name>${name}</name>\n<path>${path}</path>\n---\nname: ${name}\n---\n\n${body}\n\n</skill>`,
  }], clientTurnId);
}

function skillEvent(name: string, ordinal: number) {
  return {
    event_type: "skill_use" as const,
    tool_call_id: null,
    exchange_context_hash: null,
    capability_id: `codex:name:${name}`,
    observed_name: name,
    skill_version: null,
    evidence_source: "skill_content_injection" as const,
    ordinal,
  };
}
