import { expect, test } from "bun:test";

import type {
  InteractionItem,
  InteractionOutput,
  InteractionRequest,
  ProviderIdentity,
} from "../../interaction/types.js";
import { internalChatCompletionsToInteraction } from "../../protocol/input/chat_completions.js";
import { assistantMessagePayload } from "../../protocol/output/chat_completions.js";
import { toolResultObservations, toolSkillEvents } from "./observations.js";

const OPENAI: ProviderIdentity = {
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.5",
};

function request(
  sourceProtocol: InteractionRequest["sourceProtocol"],
  items: InteractionItem[]
): InteractionRequest {
  return {
    sourceProtocol,
    items,
    tools: [],
    generation: {},
    stream: false,
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

const user = {
  type: "message" as const,
  role: "user" as const,
  content: [{ type: "text" as const, text: "Inspect both files." }],
  contentShape: "string" as const,
};

const calls: InteractionOutput["items"] = [
  {
    type: "tool_call",
    id: "fc_read",
    callId: "call_read",
    kind: "function",
    name: "read_file",
    input: '{"path":"README.md"}',
  },
  {
    type: "tool_call",
    id: "fc_list",
    callId: "call_list",
    kind: "function",
    name: "list_files",
    input: "{}",
  },
];

test.each(["openai_chat", "openai_responses"] as const)(
  "%s emitted calls and trailing results share an exact exchange context",
  (sourceProtocol) => {
    const firstRequest = request(sourceProtocol, [user]);
    const emitted = toolSkillEvents({
      routerId: "rtr_1",
      request: firstRequest,
      output: output(calls),
      zdr: false,
    });
    const continuation = request(sourceProtocol, [
      user,
      ...calls,
      {
        type: "tool_result",
        callId: "call_read",
        kind: "function",
        output: "contents",
        outputShape: "string",
      },
      {
        type: "tool_result",
        callId: "call_list",
        kind: "function",
        output: "README.md",
        outputShape: "string",
      },
    ]);
    const observed = toolResultObservations({
      routerId: "rtr_1",
      request: continuation,
      zdr: false,
    });

    expect(emitted).toHaveLength(2);
    expect(observed).toEqual([
      {
        tool_call_id: "call_read",
        exchange_context_hash: emitted[0].exchange_context_hash,
        ordinal: 3,
      },
      {
        tool_call_id: "call_list",
        exchange_context_hash: emitted[0].exchange_context_hash,
        ordinal: 4,
      },
    ]);
    expect(emitted[0].exchange_context_hash).toBeString();
    expect(emitted[1].exchange_context_hash).toBe(
      emitted[0].exchange_context_hash
    );
  }
);

test("exchange correlation ignores request-level instructions and tools", () => {
  const firstRequest: InteractionRequest = {
    ...request("openai_responses", [user]),
    instructions: "Use repository tools.",
    tools: [{
      kind: "function",
      name: "read_file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    }],
  };
  const emitted = toolSkillEvents({
    routerId: "rtr_1",
    request: firstRequest,
    output: output([calls[0]]),
    zdr: false,
  });
  const observed = toolResultObservations({
    routerId: "rtr_1",
    request: {
      ...request("openai_responses", [
        user,
        calls[0],
        {
          type: "tool_result",
          callId: "call_read",
          kind: "function",
          output: "contents",
          outputShape: "string",
        },
      ]),
      instructions: "Different request-level instructions.",
      tools: [],
    },
    zdr: false,
  });

  expect(observed[0]?.exchange_context_hash).toBe(
    emitted[0]?.exchange_context_hash,
  );
});

test("skill-like tool names remain tool calls without explicit skill evidence", () => {
  const emitted = toolSkillEvents({
    routerId: "rtr_1",
    request: request("anthropic_messages", [user]),
    output: output([{
      type: "tool_call",
      callId: "toolu_skill_loader",
      kind: "function",
      name: "skill_loader",
      input: { skill: "implementation-journal" },
    }]),
    zdr: false,
  });

  expect(emitted).toEqual([
    {
      event_type: "tool_call",
      tool_call_id: "toolu_skill_loader",
      exchange_context_hash: expect.any(String),
      capability_id: "skill_loader",
      observed_name: "skill_loader",
      skill_version: null,
      evidence_source: "model_tool_call",
      ordinal: 0,
    },
  ]);
});

test("Chat correlation canonicalizes function argument key order", () => {
  const firstRequest = request("openai_chat", [user]);
  const call: InteractionOutput["items"][number] = {
    type: "tool_call",
    callId: "call_ordered",
    kind: "function",
    name: "inspect",
    input: { z: 1, a: 2 },
  };
  const emitted = toolSkillEvents({
    routerId: "rtr_1",
    request: firstRequest,
    output: output([call]),
    zdr: false,
  });
  const observed = toolResultObservations({
    routerId: "rtr_1",
    request: request("openai_chat", [
      user,
      { ...call, input: { a: 2, z: 1 } },
      {
        type: "tool_result",
        callId: "call_ordered",
        kind: "function",
        output: "done",
        outputShape: "string",
      },
    ]),
    zdr: false,
  });

  expect(observed[0]?.exchange_context_hash).toBe(
    emitted[0]?.exchange_context_hash,
  );
});

test("Chat correlation treats empty and null tool-only assistant content as equivalent", () => {
  const firstRequest = request("openai_chat", [user]);
  const call: InteractionOutput["items"][number] = {
    type: "tool_call",
    callId: "call_empty_content",
    kind: "function",
    name: "read_file",
    input: { path: "README.md" },
  };
  const emitted = toolSkillEvents({
    routerId: "rtr_1",
    request: firstRequest,
    output: output([call]),
    zdr: false,
  });
  const observed = toolResultObservations({
    routerId: "rtr_1",
    request: request("openai_chat", [
      user,
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "" }],
        contentShape: "string",
      },
      call,
      {
        type: "tool_result",
        callId: "call_empty_content",
        kind: "function",
        output: "contents",
        outputShape: "string",
      },
    ]),
    zdr: false,
  });

  expect(observed[0]?.exchange_context_hash).toBe(
    emitted[0]?.exchange_context_hash,
  );
});

test("Chat correlation follows serialized assistant text regrouping", () => {
  const firstRequest = request("openai_chat", [user]);
  const providerOutput = output([
    {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Checking " }],
      contentShape: "parts",
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "the file." }],
      contentShape: "parts",
    },
    calls[0],
  ]);
  const emitted = toolSkillEvents({
    routerId: "rtr_1",
    request: firstRequest,
    output: providerOutput,
    zdr: false,
  });
  const replay = internalChatCompletionsToInteraction({
    model: "dari/routing",
    messages: [assistantMessagePayload(providerOutput)],
  });
  const observed = toolResultObservations({
    routerId: "rtr_1",
    request: request("openai_chat", [
      user,
      ...replay.items,
      {
        type: "tool_result",
        callId: "call_read",
        kind: "function",
        output: "contents",
        outputShape: "string",
      },
    ]),
    zdr: false,
  });

  expect(observed[0]?.exchange_context_hash).toBe(
    emitted[0]?.exchange_context_hash,
  );
});

test("Chat correlation follows serialized reasoning regrouping", () => {
  const firstRequest = request("openai_chat", [user]);
  const providerOutput = output([
    {
      type: "reasoning",
      summary: ["Inspect the request."],
      content: [],
    },
    {
      type: "reasoning",
      summary: ["Choose the file tool."],
      content: [],
    },
    calls[0],
  ]);
  const emitted = toolSkillEvents({
    routerId: "rtr_1",
    request: firstRequest,
    output: providerOutput,
    zdr: false,
  });
  const replay = internalChatCompletionsToInteraction({
    model: "dari/routing",
    messages: [assistantMessagePayload(providerOutput)],
  });
  const observed = toolResultObservations({
    routerId: "rtr_1",
    request: request("openai_chat", [
      user,
      ...replay.items,
      {
        type: "tool_result",
        callId: "call_read",
        kind: "function",
        output: "contents",
        outputShape: "string",
      },
    ]),
    zdr: false,
  });

  expect(observed[0]?.exchange_context_hash).toBe(
    emitted[0]?.exchange_context_hash,
  );
});

test("Responses correlation ignores replayed provider item ids", () => {
  const firstRequest = request("openai_responses", [user]);
  const reasoning: InteractionOutput["items"][number] = {
    type: "reasoning",
    id: "rs_1",
    summary: ["Inspect the file."],
    content: [],
  };
  const call: InteractionOutput["items"][number] = {
    type: "tool_call",
    id: "fc_1",
    callId: "call_reasoning",
    kind: "function",
    name: "read_file",
    input: { path: "README.md" },
  };
  const emitted = toolSkillEvents({
    routerId: "rtr_1",
    request: firstRequest,
    output: output([reasoning, call]),
    zdr: false,
  });
  const observed = toolResultObservations({
    routerId: "rtr_1",
    request: request("openai_responses", [
      user,
      reasoning,
      call,
      {
        type: "tool_result",
        id: "out_1",
        callId: "call_reasoning",
        kind: "function",
        output: "contents",
        outputShape: "string",
      },
    ]),
    zdr: false,
  });

  expect(observed[0]?.exchange_context_hash).toBe(
    emitted[0]?.exchange_context_hash,
  );
});

test("Responses correlation treats string and text-part content as equivalent", () => {
  const firstRequest = request("openai_responses", [user]);
  const call: InteractionOutput["items"][number] = {
    type: "tool_call",
    id: "fc_shape",
    callId: "call_shape",
    kind: "function",
    name: "read_file",
    input: { path: "README.md" },
  };
  const emitted = toolSkillEvents({
    routerId: "rtr_1",
    request: firstRequest,
    output: output([call]),
    zdr: false,
  });
  const replayedUser = { ...user, contentShape: "parts" as const };
  const observed = toolResultObservations({
    routerId: "rtr_1",
    request: request("openai_responses", [
      replayedUser,
      call,
      {
        type: "tool_result",
        callId: "call_shape",
        kind: "function",
        output: "contents",
        outputShape: "string",
      },
    ]),
    zdr: false,
  });

  expect(observed[0]?.exchange_context_hash).toBe(
    emitted[0]?.exchange_context_hash,
  );
});

test("Responses correlation normalizes regenerated hosted search metadata", () => {
  const firstRequest = request("openai_responses", [user]);
  const hostedCall: InteractionOutput["items"][number] = {
    type: "hosted_tool_call",
    id: "ws_provider",
    tool: "web_search",
    providerType: "web_search_call",
    payload: {
      type: "web_search_call",
      id: "ws_provider",
      status: null,
      action: { type: "search", query: "Dari release notes" },
    },
    source: OPENAI,
  };
  const functionCall: InteractionOutput["items"][number] = {
    type: "tool_call",
    id: "fc_after_search",
    callId: "call_after_search",
    kind: "function",
    name: "read_file",
    input: { path: "README.md" },
  };
  const emitted = toolSkillEvents({
    routerId: "rtr_1",
    request: firstRequest,
    output: output([hostedCall, functionCall]),
    zdr: false,
  });
  expect(emitted).toEqual([
    {
      event_type: "tool_call",
      tool_call_id: "call_after_search",
      exchange_context_hash: expect.any(String),
      capability_id: "read_file",
      observed_name: "read_file",
      skill_version: null,
      evidence_source: "model_tool_call",
      ordinal: 1,
    },
  ]);
  const observed = toolResultObservations({
    routerId: "rtr_1",
    request: request("openai_responses", [
      user,
      {
        ...hostedCall,
        id: "ws_dari_regenerated",
        payload: {
          type: "web_search_call",
          id: "ws_dari_regenerated",
          action: { type: "search", query: "Dari release notes" },
        },
        source: undefined,
      },
      functionCall,
      {
        type: "tool_result",
        callId: "call_after_search",
        kind: "function",
        output: "contents",
        outputShape: "string",
      },
    ]),
    zdr: false,
  });

  expect(observed[0]?.exchange_context_hash).toBe(
    emitted[0]?.exchange_context_hash,
  );
});

test("Chat correlation tolerates provider hosted statuses omitted at the wire boundary", () => {
  const firstRequest = request("openai_chat", [user]);
  const hostedCall: InteractionOutput["items"][number] = {
    type: "hosted_tool_call",
    id: "ws_status",
    tool: "web_search",
    providerType: "web_search_call",
    payload: {
      type: "web_search_call",
      id: "ws_status",
      status: null,
      action: { type: "search", query: "Dari release notes" },
    },
  };
  const providerOutput = output([hostedCall, calls[0]]);
  const emitted = toolSkillEvents({
    routerId: "rtr_1",
    request: firstRequest,
    output: providerOutput,
    zdr: false,
  });
  const replay = internalChatCompletionsToInteraction({
    model: "dari/routing",
    messages: [assistantMessagePayload(providerOutput)],
  });
  const observed = toolResultObservations({
    routerId: "rtr_1",
    request: request("openai_chat", [
      user,
      ...replay.items,
      {
        type: "tool_result",
        callId: "call_read",
        kind: "function",
        output: "contents",
        outputShape: "string",
      },
    ]),
    zdr: false,
  });

  expect(observed[0]?.exchange_context_hash).toBe(
    emitted[0]?.exchange_context_hash,
  );
});

test("completed historical tool loops followed by a user message are not observed again", () => {
  const interaction = request("openai_chat", [
    user,
    calls[0],
    {
      type: "tool_result",
      callId: "call_read",
      kind: "function",
      output: "contents",
      outputShape: "string",
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "The file is readable." }],
      contentShape: "string",
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "text", text: "Now summarize it." }],
      contentShape: "string",
    },
  ]);

  expect(
    toolResultObservations({ routerId: "rtr_1", request: interaction, zdr: false })
  ).toEqual([]);
});

test("Responses custom tool calls and outputs preserve correlation", () => {
  const firstRequest = request("openai_responses", [user]);
  const customCall: InteractionOutput["items"][number] = {
    type: "tool_call",
    id: "ct_patch",
    callId: "call_patch",
    kind: "custom",
    name: "apply_patch",
    input: "*** Begin Patch",
  };
  const emitted = toolSkillEvents({
    routerId: "rtr_1",
    request: firstRequest,
    output: output([customCall]),
    zdr: false,
  });
  const observed = toolResultObservations({
    routerId: "rtr_1",
    request: request("openai_responses", [
      user,
      customCall,
      {
        type: "tool_result",
        callId: "call_patch",
        kind: "custom",
        name: "apply_patch",
        output: "Done",
        outputShape: "string",
      },
    ]),
    zdr: false,
  });

  expect(observed).toEqual([
    {
      tool_call_id: "call_patch",
      exchange_context_hash: emitted[0].exchange_context_hash,
      ordinal: 2,
    },
  ]);
});

test("a result without preceding context remains explicitly uncorrelated", () => {
  expect(
    toolResultObservations({
      routerId: "rtr_1",
      request: request("openai_chat", [
        {
          type: "tool_result",
          callId: "call_orphan",
          kind: "function",
          output: "done",
          outputShape: "string",
        },
      ]),
      zdr: false,
    })
  ).toEqual([
    {
      tool_call_id: "call_orphan",
      exchange_context_hash: null,
      ordinal: 0,
    },
  ]);
});

test.each(["openai_responses", "anthropic_messages"] as const)(
  "%s ZDR suppresses both emitted call events and result observations",
  (sourceProtocol) => {
    const firstRequest = request(sourceProtocol, [user]);
    const continuation = request(sourceProtocol, [
      user,
      calls[0],
      {
        type: "tool_result",
        callId: "call_read",
        kind: "function",
        output: "contents",
        outputShape: "string",
      },
    ]);

    expect(
      toolSkillEvents({
        routerId: "rtr_1",
        request: firstRequest,
        output: output(calls),
        zdr: true,
      })
    ).toEqual([]);
    expect(
      toolResultObservations({
        routerId: "rtr_1",
        request: continuation,
        zdr: true,
      })
    ).toEqual([]);
  },
);

test("unindexable provider call ids cannot discard the parent telemetry report", () => {
  const oversizedCall = {
    ...calls[0],
    callId: "c".repeat(513),
  };

  expect(
    toolSkillEvents({
      routerId: "rtr_1",
      request: request("openai_chat", [user]),
      output: output([oversizedCall]),
      zdr: false,
    })
  ).toEqual([]);
});
