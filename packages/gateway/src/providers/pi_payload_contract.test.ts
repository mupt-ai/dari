import { afterAll, expect, test } from "bun:test";
import type { ReasoningEffort } from "@mupt-ai/dari-router/policy-engine";

import { chatCompletionsToInteraction } from "../protocol/input/chat_completions.js";
import { anthropicMessagesToInteraction } from "../protocol/input/anthropic_messages.js";
import { openAIResponsesToInteraction } from "../protocol/input/openai_responses.js";
import { providerIdentityFromModel } from "../interaction/provider_continuation_state.js";
import type { InteractionRequest } from "../interaction/types.js";
import type { ResolvedRouterModelConfig } from "../types.js";
import { anthropicContent } from "../protocol/output/anthropic_messages_output.js";
import { buildContext } from "./pi_context.js";
import { buildOptions } from "./pi_options.js";
import { piMessageToInteractionOutput } from "./pi_output.js";

const piModulePath = "./pi.ts?payload-contract";
const { buildModel, pi } = (await import(piModulePath)) as typeof import("./pi.js");
const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

type PayloadCase = {
  model: string;
  config: ResolvedRouterModelConfig;
  level?: ReasoningEffort;
  expected: Record<string, unknown>;
  absent?: string[];
  /** Managed-effort models carry the requested effort in a trailing positional
   * system marker; the top-level output_config stays at the fixed "high"
   * default so the cacheable request prefix never changes. */
  markerEffort?: ReasoningEffort;
};

const openAILevels = ["off", "low", "medium", "high", "xhigh", "max"] as const;
const openAIModels = [
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
] as const;

const cases: PayloadCase[] = [
  ...openAIModels.flatMap((model) =>
    openAILevels.map((level) => ({
      model,
      config: modelConfig("openai", model.slice("openai/".length), "openai-responses", 1_050_000, [...openAILevels], "medium"),
      level,
      expected: {
        reasoning: {
          effort: level === "off" ? "none" : level,
          ...(level === "off" ? {} : { summary: "detailed" }),
        },
      },
    })),
  ),
  ...(["off", "low", "medium", "high", "xhigh"] as const).map((level) => ({
    model: "openai/gpt-5.5",
    config: modelConfig(
      "openai",
      "gpt-5.5",
      "openai-responses",
      1_050_000,
      ["off", "low", "medium", "high", "xhigh"],
      "medium",
    ),
    level,
    expected: {
      reasoning: {
        effort: level === "off" ? "none" : level,
        ...(level === "off" ? {} : { summary: "detailed" }),
      },
    },
  })),
  {
    model: "openai/gpt-4.1-mini",
    config: modelConfig("openai", "gpt-4.1-mini", "openai-responses", 1_047_576, ["off"], "off"),
    level: "off",
    expected: {},
    absent: ["reasoning"],
  },
  ...adaptiveAnthropicCases(
    "anthropic/claude-fable-5-1",
    ["low", "medium", "high", "xhigh", "max"],
    "high",
    128_000,
    true,
  ),
  ...adaptiveAnthropicCases(
    "anthropic/claude-fable-5",
    ["low", "medium", "high", "xhigh", "max"],
    "high",
  ),
  ...adaptiveAnthropicCases(
    "anthropic/claude-opus-4-8",
    ["off", "low", "medium", "high", "xhigh", "max"],
    "off",
  ),
  ...adaptiveAnthropicCases(
    "anthropic/claude-sonnet-5",
    ["off", "low", "medium", "high", "xhigh", "max"],
    "high",
    128_000,
  ),
  ...adaptiveAnthropicCases(
    "anthropic/claude-sonnet-4-6",
    ["off", "low", "medium", "high", "max"],
    "off",
  ),
  ...adaptiveAnthropicCases(
    "anthropic/claude-opus-5-5",
    ["off", "low", "medium", "high", "xhigh", "max"],
    "high",
    128_000,
    true,
  ),
  ...adaptiveAnthropicCases(
    "anthropic/claude-opus-5",
    ["off", "low", "medium", "high", "xhigh", "max"],
    "high",
    128_000,
    true,
  ),
  ...adaptiveAnthropicCases(
    "anthropic/claude-haiku-5-5",
    ["low", "medium", "high", "xhigh", "max"],
    "high",
    128_000,
    true,
  ),
  ...extendedAnthropicCases(
    "anthropic/claude-haiku-4-5",
    ["off", "low", "medium", "high"],
    "off",
  ),
  ...["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-0731"].flatMap((nativeName) => {
    const displayName = nativeName === "deepseek-v4-pro" ? "DeepSeek-V4-Pro" : nativeName === "deepseek-v4-flash-0731" ? "DeepSeek-V4-Flash-0731" : "DeepSeek-V4-Flash";
    const model = nativeName === "deepseek-v4-pro"
      ? "deepseek-ai/DeepSeek-V4-Pro-0813"
      : nativeName === "deepseek-v4-flash-0731"
        ? "deepseek-ai/DeepSeek-V4-Flash-0731"
        : `fireworks/deepseek-ai/${displayName}`;
    return (["off", "high", "max"] as const).map((level) => ({
      model,
      config: modelConfig(
        "fireworks",
        `accounts/fireworks/models/${nativeName}`,
        "openai-completions",
        1_000_000,
        ["off", "high", "max"],
        "high",
      ),
      level,
      expected: { reasoning_effort: level === "off" ? "none" : level },
    }));
  }),
  ...(["off", "high", "max"] as const).map((level) => ({
    model: "zai-org/GLM-5.2",
    config: modelConfig(
      "fireworks",
      "accounts/fireworks/models/glm-5p2",
      "openai-completions",
      1_048_575,
      ["off", "high", "max"],
      "max",
    ),
    level,
    expected: { reasoning_effort: level === "off" ? "none" : level },
  })),
  ...(["low", "high", "max"] as const).map((level) => ({
    model: "zai-org/GLM-5.3",
    config: modelConfig(
      "fireworks",
      "accounts/fireworks/models/glm-5p3",
      "openai-completions",
      1_048_576,
      ["low", "high", "max"],
      "max",
      131_072,
    ),
    level,
    expected: { reasoning_effort: level },
  })),
  ...(["low", "high", "max"] as const).map((level) => ({
    model: "zai-org/GLM-5.3-Flash",
    config: modelConfig(
      "openrouter",
      "z-ai/glm-5.3-flash",
      "openai-completions",
      1_048_576,
      ["low", "high", "max"],
      "max",
      131_072,
    ),
    level,
    expected: { reasoning: { effort: level } },
  })),
  ...["openrouter", "vercel-ai-gateway"].flatMap((provider) =>
    ([
      ["zai-org/GLM-5.2", "z-ai/glm-5.2"],
      ["deepseek-ai/DeepSeek-V4-Pro-0813", "deepseek/deepseek-v4-pro-0813"],
      ["deepseek-ai/DeepSeek-V4-Flash-0731", "deepseek/deepseek-v4-flash-0731"],
    ] as const).map(([model, nativeModelId]): PayloadCase => ({
      model,
      config: {
        ...modelConfig(provider, nativeModelId, "openai-completions", 1_000_000, ["off", "high", "max"], "high"),
        base_url: provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://ai-gateway.vercel.sh/v1",
      },
      level: "off",
      expected: { reasoning: { effort: "none" } },
      absent: ["reasoning_effort", "thinking"],
    })),
  ),
  ...(["minimal", "low", "medium", "high", "xhigh"] as const).map((level) => ({
    model: "meta/muse-spark-1.1",
    config: modelConfig(
      "meta",
      "muse-spark-1.1",
      "openai-completions",
      1_048_576,
      ["minimal", "low", "medium", "high", "xhigh"],
      "medium",
      131_072,
    ),
    level,
    expected: {
      model: "muse-spark-1.1",
      max_completion_tokens: 131_072,
      reasoning_effort: level,
    },
  })),
];

const defaultExpectations: Record<
  string,
  Pick<PayloadCase, "expected" | "absent">
> = {
  "openai/gpt-5.6-sol": {
    expected: { reasoning: { effort: "medium", summary: "detailed" } },
  },
  "openai/gpt-5.6-terra": {
    expected: { reasoning: { effort: "medium", summary: "detailed" } },
  },
  "openai/gpt-5.6-luna": {
    expected: { reasoning: { effort: "medium", summary: "detailed" } },
  },
  "openai/gpt-5.5": {
    expected: { reasoning: { effort: "medium", summary: "detailed" } },
  },
  "openai/gpt-4.1-mini": { expected: {}, absent: ["reasoning"] },
  "anthropic/claude-fable-5-1": {
    expected: {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    },
  },
  "anthropic/claude-fable-5": {
    expected: {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    },
  },
  "anthropic/claude-opus-4-8": {
    expected: { thinking: { type: "disabled" } },
    absent: ["output_config"],
  },
  "anthropic/claude-sonnet-5": {
    expected: {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    },
  },
  "anthropic/claude-sonnet-4-6": {
    expected: { thinking: { type: "disabled" } },
    absent: ["output_config"],
  },
  "anthropic/claude-opus-5-5": {
    expected: {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    },
  },
  "anthropic/claude-opus-5": {
    expected: {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    },
  },
  "anthropic/claude-haiku-4-5": {
    expected: { thinking: { type: "disabled" } },
  },
  "anthropic/claude-haiku-5-5": {
    expected: {
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    },
  },
  "deepseek-ai/DeepSeek-V4-Pro-0813": {
    expected: { reasoning_effort: "high" },
  },
  "fireworks/deepseek-ai/DeepSeek-V4-Flash": {
    expected: { reasoning_effort: "high" },
  },
  "deepseek-ai/DeepSeek-V4-Flash-0731": {
    expected: { reasoning_effort: "high" },
  },
  "zai-org/GLM-5.2": {
    expected: { reasoning_effort: "max" },
  },
  "zai-org/GLM-5.3": {
    expected: { reasoning_effort: "max" },
  },
  "zai-org/GLM-5.3-Flash": {
    expected: { reasoning: { effort: "max" } },
  },
  "meta/muse-spark-1.1": {
    expected: {
      model: "muse-spark-1.1",
      max_completion_tokens: 131_072,
      reasoning_effort: "medium",
    },
  },
};

const defaultCases = Object.entries(defaultExpectations).map(
  ([model, expectation]): PayloadCase => {
    const explicitCase = cases.find((candidate) => candidate.model === model);
    if (explicitCase === undefined) {
      throw new Error(`No explicit payload contract found for ${model}.`);
    }
    return {
      model,
      config: explicitCase.config,
      ...expectation,
    };
  },
);

test("every built-in thinking level serializes to the intended provider payload", async () => {
  for (const payloadCase of cases) {
    const payload = await capturePayload(payloadCase);
    expect(payload).toMatchObject(payloadCase.expected);
    for (const field of payloadCase.absent ?? []) {
      expect(payload).not.toHaveProperty(field);
    }
    if (payloadCase.markerEffort !== undefined) {
      const lastMessage = (payload.messages as Array<Record<string, unknown>>).at(-1);
      expect(lastMessage).toMatchObject({
        role: "system",
        output_config: { effort: payloadCase.markerEffort },
      });
    }
  }
}, 20_000);

test("GPT-6 forwards configuration updates while keeping request-level reasoning stable", async () => {
  for (const model of ["openai/gpt-6-sol", "openai/gpt-6-luna"] as const) {
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
    const payload = await captureInteractionPayload(
      request,
      model,
      modelConfig(
        "openai",
        model.slice("openai/".length),
        "openai-responses",
        1_050_000,
        [...openAILevels],
        "medium",
      ),
    );

    expect(payload.reasoning).toMatchObject({ effort: "low" });
    const input = payload.input as Array<Record<string, unknown>>;
    expect(input.find((item) => item.type === "configuration_update")).toEqual({
      type: "configuration_update",
      reasoning: { effort: "high" },
    });
    expect(input.map((item) => item.type ?? item.role)).toEqual([
      "user",
      "message",
      "configuration_update",
      "user",
    ]);
  }
});

test("gateways share one reasoning dialect and steer their own routing", async () => {
  const request = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "payload contract" },
    ],
    reasoning_effort: "high",
  });
  const kimi = (provider: string, baseUrl: string, nativeModelId: string, zdr = false) => ({
    ...modelConfig(provider, nativeModelId, "openai-completions", 1_000_000, ["low", "high", "max"], "max", 131_072),
    base_url: baseUrl,
    zdr,
  });
  const openRouter = (zdr?: boolean) => captureInteractionPayload(
    request,
    "moonshotai/Kimi-K3",
    kimi("openrouter", "https://openrouter.ai/api/v1", "moonshotai/kimi-k3", zdr),
  );
  const vercel = (zdr?: boolean) => captureInteractionPayload(
    request,
    "moonshotai/Kimi-K3",
    kimi("vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1", "moonshotai/kimi-k3", zdr),
  );

  // Kimi's model-level override targets Fireworks' DeepSeek-style thinking
  // parameters; both gateways take the nested reasoning object instead.
  for (const payload of [await openRouter(), await vercel()]) {
    expect(payload.reasoning).toEqual({ effort: "high" });
    expect(payload).not.toHaveProperty("thinking");
  }
  expect(await openRouter()).not.toHaveProperty("provider");
  expect((await openRouter(true)).provider).toEqual({ data_collection: "deny", zdr: true });

  const retained = await vercel();
  expect(retained.providerOptions).toEqual({ gateway: { caching: "auto" } });
  expect((retained.messages as Array<{ role: string }>)[0]?.role).toBe("system");
  expect((await vercel(true)).providerOptions).toEqual({
    gateway: { caching: "auto", zeroDataRetention: true },
  });
});

test("every built-in model uses its cataloged provider default", async () => {
  for (const payloadCase of defaultCases) {
    const payload = await capturePayload(payloadCase);
    expect(payload).toMatchObject(payloadCase.expected);
    for (const field of payloadCase.absent ?? []) {
      expect(payload).not.toHaveProperty(field);
    }
  }
}, 20_000);

test("the ChatGPT-subscription Codex transport asks for detailed reasoning summaries", async () => {
  const request = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [{ role: "user", content: "payload contract" }],
    reasoning_effort: "high",
  });
  const model = buildModel(pi, "openai/gpt-6-luna", null, {
    ...modelConfig("openai-codex", "gpt-6-luna", "openai-codex-responses", 1_050_000, [...openAILevels], "medium"),
    base_url: "https://chatgpt.com/backend-api",
  });
  let captured: Record<string, unknown> | undefined;
  const options = buildOptions(
    request,
    codexToken(),
    "openai/gpt-6-luna",
    model,
    pi,
    undefined,
    undefined,
    undefined,
    undefined,
    (async (_input: unknown, init?: RequestInit) => {
      // The Codex transport zstd-compresses its request body.
      if (init?.body instanceof Uint8Array) {
        captured = JSON.parse(new TextDecoder().decode(Bun.zstdDecompressSync(init.body))) as Record<string, unknown>;
      }
      return new Response(JSON.stringify({ error: { message: "payload captured" } }), { status: 400 });
    }) as typeof fetch,
  );
  try {
    await pi.completeSimple(
      model,
      buildContext(request, providerIdentityFromModel(model)),
      { ...options, transport: "sse" },
    );
  } catch {
    // The mock intentionally returns 400 after capturing the serialized body.
  }

  expect(captured?.reasoning).toEqual({ effort: "high", summary: "detailed" });
});

test("an explicit Anthropic thinking budget reaches the provider payload unchanged", async () => {
  const config = modelConfig(
    "anthropic",
    "claude-sonnet-4-6",
    "anthropic-messages",
    1_000_000,
    ["off", "low", "medium", "high", "max"],
    "off",
  );
  const request = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    thinking: { type: "enabled", budget_tokens: 12_345 },
    messages: [{ role: "user", content: "Think carefully." }],
  });

  const payload = await captureInteractionPayload(
    request,
    "anthropic/claude-sonnet-4-6",
    config,
  );

  expect(payload.thinking).toEqual({
    type: "enabled",
    budget_tokens: 12_345,
  });
});

test("mid-conversation-effort Anthropic models do not opt into thinking block binding", async () => {
  const config = modelConfig(
    "anthropic",
    "claude-fable-5-1",
    "anthropic-messages",
    1_000_000,
    ["low", "medium", "high", "xhigh", "max"],
    "high",
  );
  const request = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    messages: [{ role: "user", content: "Think carefully." }],
  });

  const payload = await captureInteractionPayload(
    request,
    "anthropic/claude-fable-5-1",
    config,
  );

  // A dropped block rewrites the prompt from that block on, so the prefix
  // check must stay off: no block_binding, no binding-controls beta, while
  // the per-turn effort marker beta remains.
  expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
  expect(payload.betas).not.toContain("thinking-binding-controls-2026-08-01");
  expect(payload.betas).toContain("mid-conversation-output-config-2026-07-01");
});

test("replayed managed-effort thinking keeps the prefix it was generated under", async () => {
  const config = modelConfig(
    "anthropic",
    "claude-opus-5-5",
    "anthropic-messages",
    1_000_000,
    ["low", "medium", "high", "xhigh", "max"],
    "high",
  );
  const turn = (messages: unknown[]) => anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    output_config: { effort: "medium" },
    tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }],
    messages,
  });
  const user = { role: "user", content: [{ type: "text", text: "Read the file." }] };
  const first = turn([user]);
  const generated = await captureInteractionPayload(first, "anthropic/claude-opus-5-5", config);

  // Pi stamps the effort marker it sent on the assistant message it streams.
  const response = piMessageToInteractionOutput({
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-5-5",
    providerThinkingLevel: "medium",
    content: [
      { type: "thinking", thinking: "Plan the read.", thinkingSignature: "sig-1" },
      { type: "toolCall", id: "toolu_1", name: "Read", arguments: {} },
    ],
    stopReason: "toolUse",
  }, { provider: "anthropic", api: "anthropic-messages", model: "claude-opus-5-5" }, first);
  const replayed = await captureInteractionPayload(turn([
    user,
    { role: "assistant", content: anthropicContent(response) },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "contents" }] },
  ]), "anthropic/claude-opus-5-5", config);

  // The API drops a replayed thinking block whose prefix changed, so every
  // message the block was generated after, including the trailing effort
  // marker, must reappear unchanged ahead of it (cache breakpoints move).
  const messages = (payload: Record<string, unknown>) =>
    JSON.parse(JSON.stringify(payload.messages, (key, value) => key === "cache_control" ? undefined : value)) as Array<Record<string, unknown>>;
  const prefix = messages(generated);
  expect(prefix.at(-1)).toEqual({ role: "system", content: [], output_config: { effort: "medium" } });
  expect(messages(replayed).slice(0, prefix.length)).toEqual(prefix);
  expect(messages(replayed)[prefix.length]).toMatchObject({
    role: "assistant",
    content: [{ type: "thinking", thinking: "Plan the read.", signature: "sig-1" }, { type: "tool_use" }],
  });
});

test("client-deferred tools stay deferred until a tool reference loads them", async () => {
  const turn = (messages: unknown[]) => anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    tools: [
      { name: "ToolSearch", input_schema: { type: "object", properties: {} } },
      { name: "mcp__linear__get_issue", input_schema: { type: "object", properties: {} }, defer_loading: true },
    ],
    messages,
  });
  const user = { role: "user", content: "Find the issue." };
  const loaded = turn([
    user,
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "ToolSearch", input: {} }] },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [{ type: "tool_reference", tool_name: "mcp__linear__get_issue" }],
      }],
    },
  ]);
  const tools = (payload: Record<string, unknown>) =>
    (payload.tools as Array<Record<string, unknown>>).map((tool) => [tool.name, tool.defer_loading === true]);
  const toolResult = (payload: Record<string, unknown>) =>
    (payload.messages as Array<{ content: unknown }>)
      .flatMap((message) => Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [])
      .find((block) => block.type === "tool_result");
  const opus = modelConfig(
    "anthropic",
    "claude-opus-5-5",
    "anthropic-messages",
    1_000_000,
    ["low", "medium", "high", "xhigh", "max"],
    "high",
  );

  const before = await captureInteractionPayload(turn([user]), "anthropic/claude-opus-5-5", opus);
  expect(tools(before)).toEqual([["ToolSearch", false], ["__pi_deferred_placeholder__", true], ["mcp__linear__get_issue", true]]);

  // The loaded tool stays deferred and loads through a tool_reference in its
  // tool result, so the request-level tool list, the cached prefix, stays put.
  for (const [model, config] of [
    ["anthropic/claude-opus-5-5", opus],
    [
      "anthropic/claude-sonnet-4-6",
      modelConfig(
        "anthropic",
        "claude-sonnet-4-6",
        "anthropic-messages",
        1_000_000,
        ["off", "low", "medium", "high", "max"],
        "off",
      ),
    ],
  ] as const) {
    const payload = await captureInteractionPayload(loaded, model, config);
    // Native inline-tools models reserve a stable placeholder from turn one.
    const initial = await captureInteractionPayload(turn([user]), model, config);
    expect(tools(payload)).toEqual(tools(initial));
    expect(payload.betas ?? []).not.toContain("mid-conversation-tool-changes-2026-07-01");
    expect(toolResult(payload)).toMatchObject({
      content: [{ type: "tool_reference", tool_name: "mcp__linear__get_issue" }],
    });
  }
});

test("published Pi payload preserves hosted search replay, annotations, and mixed tools", async () => {
  let captured: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init) => {
    if (typeof init?.body === "string") captured = JSON.parse(init.body) as Record<string, unknown>;
    return new Response(JSON.stringify({ error: { message: "payload captured" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const model = buildModel(
    pi,
    "openai/gpt-5.5",
    null,
    modelConfig("openai", "gpt-5.5", "openai-responses", 1_050_000, ["off", "high"], "off"),
  );
  const request = openAIResponsesToInteraction({
    model: "dari/routing",
    input: [
      {
        type: "web_search_call",
        id: "ws_prior",
        status: "completed",
        action: { type: "search", query: "OpenAI Responses web search" },
      },
      {
        type: "message",
        id: "msg_prior",
        role: "assistant",
        content: [{
          type: "output_text",
          text: "The docs describe it.[1]",
          annotations: [{
            type: "url_citation",
            url: "https://developers.openai.com/api/docs/guides/tools-web-search",
            title: "Web search",
          }],
        }],
      },
      { role: "user", content: [{ type: "input_text", text: "Now run the local tool." }] },
    ],
    tools: [
      { type: "function", name: "exec_command", parameters: { type: "object" } },
      { type: "web_search", search_context_size: "high" },
    ],
  });
  const options = buildOptions(request, "test-api-key", "openai/gpt-5.5", model, pi);
  let caught: unknown;
  let result: unknown;
  try {
    result = await pi.completeSimple(
      model,
      buildContext(request, providerIdentityFromModel(model)),
      options,
    );
  } catch (error) {
    caught = error;
    // The mock intentionally returns 400 after capturing the serialized body.
  }

  if (captured === undefined) throw caught ?? new Error(JSON.stringify(result));

  expect(captured?.tools).toEqual([
    {
      type: "function",
      name: "exec_command",
      description: "",
      parameters: { type: "object" },
      strict: false,
    },
    { type: "web_search", search_context_size: "high" },
  ]);
  expect(captured?.input).toEqual([
    {
      type: "web_search_call",
      id: "ws_prior",
      status: "completed",
      action: { type: "search", query: "OpenAI Responses web search" },
    },
    {
      type: "message",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "The docs describe it.[1]",
        annotations: [{
          type: "url_citation",
          url: "https://developers.openai.com/api/docs/guides/tools-web-search",
          title: "Web search",
        }],
      }],
      status: "completed",
      id: "msg_prior",
    },
    { role: "user", content: [{ type: "input_text", text: "Now run the local tool." }] },
  ]);
});

function adaptiveAnthropicCases(
  model: string,
  levels: ReasoningEffort[],
  defaultLevel: ReasoningEffort,
  maxOutputTokens?: number,
  managed = false,
): PayloadCase[] {
  return levels.map((level) => ({
    model,
    config: modelConfig(
      "anthropic",
      model.slice("anthropic/".length),
      "anthropic-messages",
      1_000_000,
      levels,
      defaultLevel,
      maxOutputTokens,
    ),
    level,
    expected:
      level === "off"
        ? { thinking: { type: "disabled" } }
        : managed
          ? {
              // No block_binding: the preserved-thinking prefix check would
              // drop replayed blocks on mismatch and re-write the conversation.
              thinking: { type: "adaptive", display: "summarized" },
              // The top-level effort stays at the fixed "high" default so the
              // cacheable prefix is stable; the requested level rides the
              // trailing positional system marker asserted via markerEffort.
              output_config: { effort: "high" },
            }
          : {
              thinking: { type: "adaptive", display: "summarized" },
              output_config: { effort: level },
            },
    absent: level === "off" ? ["output_config"] : undefined,
    ...(level !== "off" && managed ? { markerEffort: level } : {}),
  }));
}

function extendedAnthropicCases(
  model: string,
  levels: ReasoningEffort[],
  defaultLevel: ReasoningEffort,
): PayloadCase[] {
  const budgets: Partial<Record<ReasoningEffort, number>> = {
    low: 2_048,
    medium: 8_192,
    high: 16_384,
    xhigh: 16_384,
    max: 16_384,
  };
  return levels.map((level) => ({
    model,
    config: modelConfig(
      "anthropic",
      model.slice("anthropic/".length),
      "anthropic-messages",
      200_000,
      levels,
      defaultLevel,
      64_000,
    ),
    level,
    expected:
      level === "off"
        ? { thinking: { type: "disabled" } }
        : {
            thinking: {
              type: "enabled",
              budget_tokens: budgets[level],
              display: "summarized",
            },
          },
    absent: ["output_config"],
  }));
}

function modelConfig(
  provider: string,
  nativeModelId: string,
  api: string,
  contextWindow: number,
  supportedThinkingLevels: ReasoningEffort[],
  defaultThinkingLevel: ReasoningEffort,
  maxOutputTokens?: number,
): ResolvedRouterModelConfig {
  const baseUrl =
    provider === "openai"
      ? "https://api.openai.com/v1"
      : provider === "anthropic"
        ? "https://api.anthropic.com"
        : provider === "meta"
          ? "https://api.meta.ai/v1"
          : provider === "openrouter"
            ? "https://openrouter.ai/api/v1"
          : "https://api.fireworks.ai/inference/v1";
  return {
    provider,
    native_model_id: nativeModelId,
    api,
    base_url: baseUrl,
    context_window: contextWindow,
    ...(maxOutputTokens !== undefined
      ? { max_output_tokens: maxOutputTokens }
      : {}),
    supported_thinking_levels: supportedThinkingLevels,
    default_thinking_level: defaultThinkingLevel,
    cost: { input: 0, output: 0 },
  };
}

async function capturePayload(payloadCase: PayloadCase): Promise<Record<string, unknown>> {
  const request = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [{ role: "user", content: "payload contract" }],
    ...(payloadCase.level !== undefined
      ? { reasoning_effort: payloadCase.level }
      : {}),
  });
  return captureInteractionPayload(request, payloadCase.model, payloadCase.config);
}

async function captureInteractionPayload(
  request: InteractionRequest,
  modelName: string,
  config: ResolvedRouterModelConfig,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init) => {
    if (typeof init?.body === "string") {
      captured = JSON.parse(init.body) as Record<string, unknown>;
      // Beta features travel on the header, not in the body.
      const beta = new Headers(init.headers).get("anthropic-beta");
      if (beta !== null) captured.betas = beta.split(",").map((value) => value.trim());
    }
    return new Response(JSON.stringify({ error: { message: "payload captured" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const model = buildModel(pi, modelName, null, config);
  const options = buildOptions(
    request,
    "test-api-key",
    modelName,
    model,
    pi,
  );
  try {
    await pi.completeSimple(
      model,
      buildContext(request, providerIdentityFromModel(model)),
      options,
    );
  } catch {
    // The mock intentionally returns 400 after capturing the serialized body.
  }
  if (captured === undefined) {
    throw new Error(`No provider payload captured for ${modelName}.`);
  }
  return captured;
}

function codexToken(): string {
  const segment = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "acct_payload_contract" } };
  return `${segment({ alg: "none" })}.${segment(claims)}.signature`;
}

// The request Claude Code sends after reading a PDF, which the gateway used
// to reject: a tool_result carrying text plus a base64 PDF document block.
function claudeCodePdfRead(): InteractionRequest {
  return anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 1024,
    tools: [{ name: "Read", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }],
    messages: [
      { role: "user", content: "Summarize report.pdf" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "report.pdf" } }] },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [
            { type: "text", text: "PDF file read: report.pdf" },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" } },
          ],
        }],
      },
    ],
  });
}

test("Claude Code PDF tool results reach Anthropic as native document blocks", async () => {
  const config = modelConfig("anthropic", "claude-sonnet-5-5", "anthropic-messages", 1_000_000, ["off", "high"], "off");
  const payload = await captureInteractionPayload(claudeCodePdfRead(), "anthropic/claude-sonnet-5-5", config);

  const messages = payload.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  const toolResult = messages.at(-1)!.content.find((block) => block.type === "tool_result")!;
  expect(toolResult.content).toEqual([
    { type: "text", text: "PDF file read: report.pdf" },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" } },
  ]);
});

test("Claude Code PDF tool results reach OpenAI Responses as input_file", async () => {
  const config = modelConfig("openai", "gpt-5.5", "openai-responses", 1_050_000, ["off", "medium"], "medium");
  const payload = await captureInteractionPayload(claudeCodePdfRead(), "openai/gpt-5.5", config);

  const output = (payload.input as Array<Record<string, unknown>>).find((item) => item.type === "function_call_output");
  expect(output?.output).toEqual([
    { type: "input_text", text: "PDF file read: report.pdf" },
    { type: "input_file", filename: "document.pdf", file_data: "data:application/pdf;base64,JVBERi0xLjQK" },
  ]);
});

test("Claude Code text documents and search results reach any model as text", async () => {
  const request = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 1024,
    tools: [{ name: "Search", input_schema: { type: "object", properties: {} } }],
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "text", media_type: "text/plain", data: "Use tabs." }, title: "STYLE.md", context: "A doc of this project." },
          { type: "text", text: "Search the docs" },
        ],
      },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Search", input: {} }] },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [{
            type: "search_result",
            source: "https://docs.example/tabs",
            title: "Tabs",
            content: [{ type: "text", text: "Tabs are four columns." }],
            citations: { enabled: true },
          }],
        }],
      },
    ],
  });
  const config = modelConfig("fireworks", "glm-5p3", "openai-completions", 200_000, ["off"], "off");
  const payload = await captureInteractionPayload(request, "zai-org/GLM-5.3", config);

  const serialized = JSON.stringify(payload.messages);
  expect(serialized).toContain("Document: STYLE.md\\nA doc of this project.");
  expect(serialized).toContain("Use tabs.");
  expect(serialized).toContain("Search result: Tabs\\nSource: https://docs.example/tabs\\n\\nTabs are four columns.");
});
