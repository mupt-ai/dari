import { expect, test } from "bun:test";

import { requiredCapabilitiesFor } from "../../interaction/capabilities.js";
import { openAIResponsesToInteraction } from "./openai_responses.js";
import { encodeProviderContinuationState } from "../../interaction/provider_continuation_state.js";

test("Responses ingress preserves ordered reasoning, message, function, custom, and result items", () => {
  const continuation = {
    kind: "openai_reasoning" as const,
    source: { provider: "openai", api: "openai-responses", model: "gpt-5.5" },
    encryptedContent: "opaque-input",
  };
  const request = openAIResponsesToInteraction({
    model: "dari/routing",
    instructions: "Work carefully.",
    input: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "Checked the plan." }],
        content: [{ type: "reasoning_text", text: "Readable reasoning." }],
        encrypted_content: encodeProviderContinuationState(continuation),
      },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        phase: "commentary",
        internal_chat_message_metadata_passthrough: { turn_id: "turn_1" },
        content: [{ type: "output_text", text: "I will inspect the files." }],
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        namespace: "repo",
        name: "read_file",
        arguments: "{\"path\":\"src/a.ts\"}",
        status: "completed",
      },
      {
        type: "function_call_output",
        id: "out_1",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "file contents" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "auto" },
        ],
      },
      {
        type: "custom_tool_call",
        id: "ct_1",
        call_id: "call_2",
        name: "apply_patch",
        input: "*** Begin Patch",
      },
      {
        type: "custom_tool_call_output",
        id: "cto_1",
        call_id: "call_2",
        name: "apply_patch",
        output: "Done!",
      },
    ],
    tools: [
      {
        type: "namespace",
        name: "repo",
        tools: [
          {
            type: "function",
            name: "read_file",
            description: "Read a file.",
            parameters: { type: "object" },
            strict: true,
          },
        ],
      },
      {
        type: "custom",
        name: "apply_patch",
        description: "Apply a patch.",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
    ],
    tool_choice: { type: "function", namespace: "repo", name: "read_file" },
    parallel_tool_calls: true,
    reasoning: { effort: "high" },
    text: { format: { type: "json_schema", name: "result", schema: { type: "object" }, strict: true } },
    prompt_cache_key: "thread-1",
    stream: true,
    client_metadata: { originator: "codex_cli_rs" },
  });

  expect(request.items.map((item) => item.type)).toEqual([
    "reasoning",
    "message",
    "tool_call",
    "tool_result",
    "tool_call",
    "tool_result",
  ]);
  expect(request.items[0]).toEqual({
    type: "reasoning",
    id: "rs_1",
    summary: ["Checked the plan."],
    content: ["Readable reasoning."],
    continuation,
  });
  expect(request.items[1]).toMatchObject({
    type: "message",
    clientTurnId: "turn_1",
    content: [{ type: "text", text: "I will inspect the files." }],
    contentShape: "parts",
  });
  expect(request.items[2]).toEqual({
    type: "tool_call",
    id: "fc_1",
    callId: "call_1",
    kind: "function",
    namespace: "repo",
    name: "read_file",
    input: "{\"path\":\"src/a.ts\"}",
    status: "completed",
  });
  expect(request.items[4]).toMatchObject({ id: "ct_1", callId: "call_2", kind: "custom", name: "apply_patch" });
  expect(request.tools).toHaveLength(2);
  expect(request.tools[0]).toMatchObject({ kind: "function", namespace: "repo", name: "read_file", strict: true });
  expect(request.tools[1]).toMatchObject({ kind: "custom", name: "apply_patch", format: { type: "grammar" } });
  expect(request.toolChoice).toEqual({ kind: "function", namespace: "repo", name: "read_file" });
  expect(request.reasoning).toEqual({ effort: "high" });
  expect(request.responseFormat).toEqual({ type: "json_schema", name: "result", schema: { type: "object" }, strict: true });
  expect(requiredCapabilitiesFor(request)).toEqual([
    "image_input",
    "structured_output",
  ]);
  expect(request.promptCacheKey).toBe("thread-1");
  expect(request.parallelToolCalls).toBe(true);
  expect(request.metadata).toEqual({ client_metadata: { originator: "codex_cli_rs" } });
});

test("Responses ingress ignores malformed client turn metadata", () => {
  const request = openAIResponsesToInteraction({
    model: "dari/routing",
    input: [
      {
        type: "message",
        role: "user",
        content: "hello",
        internal_chat_message_metadata_passthrough: {
          turn_id: "x".repeat(201),
        },
      },
    ],
  });

  expect(request.items[0]).not.toHaveProperty("clientTurnId");
});

test("Responses ingress maps the OpenAI none reasoning effort to Dari off", () => {
  const request = openAIResponsesToInteraction({
    model: "dari/routing",
    input: "answer directly",
    reasoning: { effort: "none" },
  });

  expect(request.reasoning).toEqual({ effort: "off" });
});

test("Responses ingress rejects Dari's internal off spelling on the OpenAI wire", () => {
  expect(() => openAIResponsesToInteraction({
    model: "dari/routing",
    input: "answer directly",
    reasoning: { effort: "off" },
  })).toThrow("reasoning.effort is not supported");
});

test("Responses ingress rejects unsupported models at the protocol boundary", () => {
  expect(() => openAIResponsesToInteraction({ model: "gpt-5.5", input: "hello" })).toThrow(
    "Only model 'dari/routing' or 'dari/model/<model>' is supported."
  );
});

test("Responses ingress rejects an empty input array", () => {
  expect(() => openAIResponsesToInteraction({
    model: "dari/routing",
    input: [],
  })).toThrow("input must include at least one item.");
});

test.each(["function_call", "function_call_output"])(
  "Responses ingress bounds %s call ids used by telemetry indexes",
  (type) => {
    expect(() =>
      openAIResponsesToInteraction({
        model: "dari/routing",
        input: [
          type === "function_call"
            ? {
                type,
                call_id: "c".repeat(513),
                name: "read_file",
                arguments: "{}",
              }
            : {
                type,
                call_id: "c".repeat(513),
                output: "done",
              },
        ],
      })
    ).toThrow("no longer than 512 characters");
  },
);

test("Responses ingress rejects service tiers instead of silently ignoring them", () => {
  expect(() => openAIResponsesToInteraction({
    model: "dari/routing",
    input: "hello",
    service_tier: "priority",
  })).toThrow("service_tier is not supported by this router endpoint");
});

test("Responses ingress treats a null service tier as absent", () => {
  const request = openAIResponsesToInteraction({
    model: "dari/routing",
    input: "hello",
    service_tier: null,
  });

  expect(request.metadata).toBeUndefined();
});

test("Responses ingress preserves hosted web search declarations, history, and citations", () => {
  const request = openAIResponsesToInteraction({
    model: "dari/routing",
    input: [
      {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: {
          type: "search",
          query: "OpenAI Responses web search",
          sources: [{ type: "url", url: "https://developers.openai.com/api/docs/guides/tools-web-search" }],
        },
      },
      {
        type: "message",
        id: "msg_search",
        role: "assistant",
        content: [{
          type: "output_text",
          text: "OpenAI documents hosted search.[1]",
          annotations: [{
            type: "url_citation",
            start_index: 32,
            end_index: 35,
            url: "https://developers.openai.com/api/docs/guides/tools-web-search",
            title: "Web search",
          }],
        }],
      },
    ],
    tools: [{
      type: "web_search",
      search_context_size: "high",
      external_web_access: false,
      filters: { allowed_domains: ["openai.com"] },
    }],
    tool_choice: { type: "web_search" },
  });

  expect(request.tools).toEqual([{
    kind: "hosted",
    type: "web_search",
    config: {
      type: "web_search",
      search_context_size: "high",
      external_web_access: false,
      filters: { allowed_domains: ["openai.com"] },
    },
  }]);
  expect(request.toolChoice).toEqual({ kind: "hosted", type: "web_search" });
  expect(request.items[0]).toMatchObject({
    type: "hosted_tool_call",
    id: "ws_1",
    payload: { action: { type: "search", query: "OpenAI Responses web search" } },
  });
  expect(request.items[1]).toMatchObject({
    type: "message",
    content: [{
      type: "text",
      annotations: [{ type: "url_citation", title: "Web search" }],
    }],
  });
  expect(requiredCapabilitiesFor(request)).toContain("openai_hosted_web_search");
});

test("Responses ingress requires OpenAI for hosted search history without a current declaration", () => {
  const request = openAIResponsesToInteraction({
    model: "dari/routing",
    input: [
      {
        type: "web_search_call",
        id: "ws_history",
        status: "completed",
        action: { type: "search", query: "prior search" },
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Use that result." }],
      },
    ],
  });

  expect(request.tools).toEqual([]);
  expect(requiredCapabilitiesFor(request)).toContain("openai_hosted_web_search");
});

test("Responses ingress requires OpenAI for a hosted tool choice without a declaration", () => {
  const request = openAIResponsesToInteraction({
    model: "dari/routing",
    input: "Search for this.",
    tool_choice: { type: "web_search" },
  });

  expect(request.tools).toEqual([]);
  expect(request.toolChoice).toEqual({ kind: "hosted", type: "web_search" });
  expect(requiredCapabilitiesFor(request)).toContain("openai_hosted_web_search");
});

test("Responses ingress deterministically restores hosted search IDs omitted by Codex replay", () => {
  const payload = {
    model: "dari/routing",
    input: [
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "current Hacker News story" },
      },
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "open_page", url: "https://news.ycombinator.com/" },
      },
    ],
  };

  const first = openAIResponsesToInteraction(payload);
  const second = openAIResponsesToInteraction(payload);
  const firstIds = first.items.map((item) => item.type === "hosted_tool_call" ? item.id : null);
  const secondIds = second.items.map((item) => item.type === "hosted_tool_call" ? item.id : null);

  expect(firstIds).toEqual(secondIds);
  expect(firstIds[0]).toMatch(/^ws_dari_[0-9a-f]{32}$/);
  expect(firstIds[1]).toMatch(/^ws_dari_[0-9a-f]{32}$/);
  expect(firstIds[0]).not.toBe(firstIds[1]);
  expect(first.items.map((item) => item.type === "hosted_tool_call" ? item.payload.id : null)).toEqual(firstIds);
});

test("Responses ingress restores exact hosted IDs from client-carried continuation state", () => {
  const continuation = encodeProviderContinuationState({
    kind: "openai_reasoning",
    source: { provider: "openai", api: "openai-responses", model: "gpt-5.5" },
    encryptedContent: "opaque-reasoning",
    providerItemId: "rs_1",
    hostedToolCallIds: ["ws_exact_search", "ws_exact_open"],
  });
  const request = openAIResponsesToInteraction({
    model: "dari/routing",
    input: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        encrypted_content: continuation,
      },
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "current Hacker News story" },
      },
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "open_page", url: "https://news.ycombinator.com/" },
      },
    ],
  });

  expect(request.items.flatMap((item) => item.type === "hosted_tool_call" ? [item.id] : [])).toEqual([
    "ws_exact_search",
    "ws_exact_open",
  ]);
  expect(request.items.flatMap((item) => item.type === "hosted_tool_call" ? [item.payload.id] : [])).toEqual([
    "ws_exact_search",
    "ws_exact_open",
  ]);
});

test("Responses ingress restores positioned hosted IDs across intervening output items", () => {
  const continuation = encodeProviderContinuationState({
    kind: "openai_reasoning",
    source: { provider: "openai", api: "openai-responses", model: "gpt-5.5" },
    encryptedContent: "opaque-positioned-reasoning",
    providerItemId: "rs_positioned",
    hostedToolCallIds: ["ws_exact_before", "ws_exact_after"],
    hostedToolCallOffsets: [-2, 2],
  });
  const request = openAIResponsesToInteraction({
    model: "dari/routing",
    input: [
      { type: "web_search_call", status: "completed", action: { type: "search", query: "before" } },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Still working." }] },
      { type: "reasoning", id: "rs_positioned", summary: [], encrypted_content: continuation },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking again." }] },
      { type: "web_search_call", status: "completed", action: { type: "search", query: "after" } },
    ],
  });

  expect(request.items.flatMap((item) => item.type === "hosted_tool_call" ? [item.id] : [])).toEqual([
    "ws_exact_before",
    "ws_exact_after",
  ]);
});

test("Responses ingress scopes carried hosted IDs to their reasoning group", () => {
  const continuation = encodeProviderContinuationState({
    kind: "openai_reasoning",
    source: { provider: "openai", api: "openai-responses", model: "gpt-5.5" },
    encryptedContent: "opaque-reasoning",
    providerItemId: "rs_later",
    hostedToolCallIds: ["ws_exact_earlier", "ws_exact_later"],
  });
  const nextContinuation = encodeProviderContinuationState({
    kind: "openai_reasoning",
    source: { provider: "openai", api: "openai-responses", model: "gpt-5.5" },
    encryptedContent: "opaque-next-reasoning",
    providerItemId: "rs_next",
    hostedToolCallIds: ["ws_exact_next"],
  });
  const request = openAIResponsesToInteraction({
    model: "dari/routing",
    input: [
      {
        type: "web_search_call",
        id: "ws_exact_earlier",
        status: "completed",
        action: { type: "search", query: "earlier search with its wire ID" },
      },
      { type: "reasoning", id: "rs_later", summary: [], encrypted_content: continuation },
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "search owned by the continuation" },
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "First response." }] },
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "unrelated id-less search" },
      },
      { type: "reasoning", id: "rs_next", summary: [], encrypted_content: nextContinuation },
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "next response search" },
      },
    ],
  });

  const ids = request.items.flatMap((item) => item.type === "hosted_tool_call" ? [item.id] : []);
  expect(ids[0]).toBe("ws_exact_earlier");
  expect(ids[1]).toBe("ws_exact_later");
  expect(ids[2]).toMatch(/^ws_dari_[0-9a-f]{32}$/);
  expect(ids[3]).toBe("ws_exact_next");
});

test("Responses ingress rejects unsupported hosted tool declarations", () => {
  for (const type of [
    "file_search",
    "code_interpreter",
    "computer_use",
    "image_generation",
    "mcp",
    "mcp_call",
  ]) {
    expect(() => openAIResponsesToInteraction({
      model: "dari/routing",
      input: "use the hosted tool",
      tools: [{ type }],
    })).toThrow(`Tool type '${type}' is not supported by this router MVP.`);
  }
});

test("Responses ingress rejects remote images and preserves supported detail modes", () => {
  expect(() =>
    openAIResponsesToInteraction({
      model: "dari/routing",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: "https://example.com/image.png" }],
        },
      ],
    })
  ).toThrow("must be a base64 image data URL");

  for (const detail of ["auto", "low", "high", "original"] as const) {
    const interaction = openAIResponsesToInteraction({
      model: "dari/routing",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail }],
      }],
    });
    expect(interaction.items[0]).toMatchObject({
      type: "message",
      content: [{ type: "image", detail }],
    });
  }

  expect(() => openAIResponsesToInteraction({
    model: "dari/routing",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "ultra" }],
    }],
  })).toThrow("detail is not supported");
});

test("Responses ingress rejects incomplete JSON schema formats", () => {
  expect(() => openAIResponsesToInteraction({
    model: "dari/routing",
    input: "hello",
    text: { format: { type: "json_schema", schema: { type: "object" } } },
  })).toThrow("text.format.name must be a non-empty string");
  expect(() => openAIResponsesToInteraction({
    model: "dari/routing",
    input: "hello",
    text: { format: { type: "json_schema", name: "result" } },
  })).toThrow("text.format.schema must be a JSON schema object");
});

test("Responses ingress serves turns that ask for reasoning summaries without them", () => {
  const request = openAIResponsesToInteraction({
    model: "dari/routing",
    input: "hello",
    reasoning: { effort: "high", summary: "auto" },
  });
  expect(request.reasoning).toEqual({ effort: "high" });
});

test("Responses ingress rejects unadvertised verbosity controls", () => {
  expect(() => openAIResponsesToInteraction({
    model: "dari/routing",
    input: "hello",
    text: { verbosity: "low" },
  })).toThrow("text.verbosity is not supported by this router MVP");
});

test("Responses ingress applies the latest reasoning configuration update without changing the provider base effort", () => {
  const request = openAIResponsesToInteraction({
    model: "dari/routing",
    reasoning: { effort: "low" },
    input: [
      { type: "message", role: "user", content: "first" },
      { type: "message", role: "assistant", content: "first response" },
      { type: "configuration_update", reasoning: { effort: "high" } },
      { type: "message", role: "user", content: "second" },
    ],
  });

  expect(request.reasoning).toEqual({
    effort: "high",
    baseEffort: "low",
    hasConfigurationUpdate: true,
  });
  expect(request.items[2]).toEqual({ type: "reasoning_configuration", effort: "high" });
});

test("Responses ingress validates reasoning configuration updates", () => {
  expect(() => openAIResponsesToInteraction({
    model: "dari/routing",
    input: [{ type: "configuration_update", reasoning: { effort: "high" } }],
  })).toThrow("reasoning.effort is required when input contains configuration_update");

  expect(() => openAIResponsesToInteraction({
    model: "dari/routing",
    reasoning: { effort: "low" },
    input: [
      { type: "configuration_update", reasoning: { effort: "low" } },
      { type: "configuration_update", reasoning: { effort: "high" } },
    ],
  })).toThrow("Adjacent configuration_update items are not supported");

  expect(() => openAIResponsesToInteraction({
    model: "dari/routing",
    input: [{ type: "configuration_update", reasoning: { effort: "high", summary: "auto" } }],
  })).toThrow("configuration_update supports only reasoning.effort");
});

test("Responses ingress rejects malformed function arguments", () => {
  for (const argumentsValue of ["not json", "[]"]) {
    expect(() => openAIResponsesToInteraction({
      model: "dari/routing",
      input: [{
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: argumentsValue,
      }],
    })).toThrow("input.function_call.arguments must contain a JSON object");
  }
});

test.each(["agent_message", "local_shell_call", "tool_search_call", "compaction", "context_compaction"])(
  "Responses ingress rejects unsupported %s items explicitly",
  (type) => {
    expect(() => openAIResponsesToInteraction({ model: "dari/routing", input: [{ type }] })).toThrow(
      `Responses input item type '${type}' is not supported`
    );
  }
);

test("Responses ingress rejects unknown content parts instead of dropping them", () => {
  expect(() =>
    openAIResponsesToInteraction({
      model: "dari/routing",
      input: [{ type: "message", role: "user", content: [{ type: "input_audio", audio_url: "data:audio/wav;base64,AA==" }] }],
    })
  ).toThrow("Responses content part type 'input_audio' is not supported");
});

test("Responses ingress rejects raw reasoning state without provider provenance", () => {
  expect(() => openAIResponsesToInteraction({
    model: "dari/routing",
    input: [{ type: "reasoning", summary: [], encrypted_content: "provider-native-ciphertext" }],
  })).toThrow("must be a Dari provider continuation envelope");
});

test("Responses ingress rejects tool names made ambiguous by namespace encoding", () => {
  expect(() =>
    openAIResponsesToInteraction({
      model: "dari/routing",
      input: "hello",
      tools: [
        {
          type: "namespace",
          name: "repo",
          tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
        },
        { type: "function", name: "repo__read", parameters: { type: "object" } },
      ],
    })
  ).toThrow("repo__read' is ambiguous");
});

// Tier synonyms are an Anthropic-surface affordance only: Codex ships its own
// catalog and always sends dari/routing, so the Responses gate must keep
// rejecting bare tier names.
test("Responses gate rejects Claude tier names", () => {
  for (const model of ["sonnet", "opus", "haiku", "fable", "mythos"]) {
    expect(() => openAIResponsesToInteraction({ model, input: "ping" })).toThrow(
      "Only model 'dari/routing' or 'dari/model/<model>' is supported."
    );
  }
});
