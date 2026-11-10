import { expect, test } from "bun:test";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels as getPiSupportedThinkingLevels,
} from "@mupt-ai/pi-ai";

import { chatCompletionsToInteraction } from "../protocol/input/chat_completions.js";
import { anthropicMessagesToInteraction } from "../protocol/input/anthropic_messages.js";
import { openAIResponsesToInteraction } from "../protocol/input/openai_responses.js";
import { buildOptions, supportedThinkingLevels } from "./pi_options.js";
import type { ResolvedRouterModelConfig } from "../types.js";
import {
  buildModel,
  buildModelOptions,
  buildTestContext,
  completeProviderEventStream,
  modelFixtures,
  pi,
  piFixture,
  providerEvents,
  requestWithReasoning,
} from "./pi.fixtures.js";

test("builds request-scoped AWS environment values for Bedrock SigV4", () => {
  const options = buildOptions(
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [{ role: "user", content: "Sign this request." }],
    }),
    {
      type: "aws_sigv4",
      access_key_id: "AKIAEXAMPLE",
      secret_access_key: "secret-example",
      session_token: "session-example",
      region: "eu-west-1",
    },
    "openai/gpt-5.6-sol",
    {
      ...modelFixtures["openai/gpt-5.6-sol"],
      provider: "amazon-bedrock",
      api: "bedrock-converse-stream",
    },
    piFixture,
  );

  expect(options.apiKey).toBeUndefined();
  expect(options.env).toEqual({
    AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
    AWS_SECRET_ACCESS_KEY: "secret-example",
    AWS_SESSION_TOKEN: "session-example",
    AWS_REGION: "eu-west-1",
    AWS_DEFAULT_REGION: "eu-west-1",
    AWS_BEARER_TOKEN_BEDROCK: "",
    AWS_PROFILE: "",
  });
});

test("rejects SigV4 authentication for non-Bedrock transports", () => {
  expect(() => buildOptions(
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [{ role: "user", content: "Do not sign this request." }],
    }),
    {
      type: "aws_sigv4",
      access_key_id: "AKIATEST",
      secret_access_key: "secret",
      region: "us-east-1",
    },
    "openai/gpt-5.6-sol",
    modelFixtures["openai/gpt-5.6-sol"],
    piFixture,
  )).toThrow("AWS SigV4 authentication requires the Bedrock API");
});

test("passes Bedrock bearer authentication through Pi options", () => {
  const options = buildOptions(
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [{ role: "user", content: "Use a Bedrock bearer token." }],
    }),
    "bedrock-api-key",
    "openai/gpt-5.6-sol",
    {
      ...modelFixtures["openai/gpt-5.6-sol"],
      provider: "amazon-bedrock",
      api: "bedrock-converse-stream",
    },
    piFixture,
  );

  expect(options.apiKey).toBe("bedrock-api-key");
  expect(options.env).toBeUndefined();
});

test("sends the current Claude Code identity for Anthropic OAuth", () => {
  const request = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Use my subscription." }],
  });
  const model = modelFixtures["anthropic/claude-fable-5"];

  const oauth = buildOptions(request, "sk-ant-oat-test", "anthropic/claude-fable-5", model, piFixture);
  expect(oauth.headers).toEqual({ "user-agent": "claude-cli/2.1.280" });

  const apiKey = buildOptions(request, "sk-ant-api-test", "anthropic/claude-fable-5", model, piFixture);
  expect(apiKey.headers).toBeUndefined();

  const forwarded = buildOptions(
    { ...request, claudeCodeUserAgent: "claude-cli/2.1.299 (external, cli)" },
    "sk-ant-oat-test",
    "anthropic/claude-fable-5",
    model,
    piFixture,
  );
  expect(forwarded.headers).toEqual({ "user-agent": "claude-cli/2.1.299 (external, cli)" });
});

test("allows a caller to shorten the Pi timeout", () => {
  const options = buildOptions(
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [{ role: "user", content: "Generate a title." }],
    }),
    "sk-test",
    "openai/gpt-4.1-mini",
    modelFixtures["openai/gpt-4.1-mini"],
    piFixture,
    undefined,
    undefined,
    10_000,
  );

  expect(options.timeoutMs).toBe(10_000);
});

test("passes a request-scoped abort signal through Pi options", () => {
  const controller = new AbortController();
  const options = buildOptions(
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [{ role: "user", content: "Stop if I disconnect." }],
    }),
    "sk-test",
    "openai/gpt-4.1-mini",
    modelFixtures["openai/gpt-4.1-mini"],
    piFixture,
    undefined,
    undefined,
    undefined,
    controller.signal,
  );

  expect(options.signal).toBe(controller.signal);
  controller.abort();
  expect((options.signal as AbortSignal).aborted).toBe(true);
});

test("rebuilds omitted terminal output from completed provider events", async () => {
  const search = { type: "web_search_call", id: "ws_1", status: "completed" };
  const message = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Search answer.", annotations: [] }],
  };
  const completed = await completeProviderEventStream(providerEvents([
    {
      type: "provider_event",
      event: { type: "response.output_item.done", output_index: 0, item: search },
    },
    {
      type: "provider_event",
      event: { type: "response.output_item.done", output_index: 1, item: message },
    },
    {
      type: "provider_event",
      event: {
        type: "response.completed",
        response: { id: "resp_1", status: "completed", output: [] },
      },
    },
    {
      type: "done",
      message: { content: [{ type: "text", text: "Search answer." }], stopReason: "stop" },
    },
  ]));

  expect(completed.providerResponse).toMatchObject({ output: [search, message] });
});

test("maps developer prompts and data image content without dropping them", () => {
  const context = buildTestContext({
    model: "dari/routing",
    messages: [
      { role: "system", content: "System prompt." },
      { role: "developer", content: "Developer prompt." },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;charset=utf-8;base64,aGVsbG8=" } },
        ],
      },
    ],
  });

  expect(context.systemPrompt).toBe("System prompt.\n\nDeveloper prompt.");
  expect(context.messages).toMatchObject([
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ],
    },
  ]);
});

test("keeps mid-conversation system notes positional instead of mutating the system prompt", () => {
  const context = buildTestContext({
    model: "dari/routing",
    messages: [
      { role: "system", content: "System prompt." },
      { role: "user", content: "look" },
      { role: "assistant", content: "done" },
      { role: "system", content: "<total_tokens>1000 tokens left</total_tokens>" },
      { role: "user", content: "again" },
    ],
  });

  expect(context.systemPrompt).toBe("System prompt.");
  expect(context.messages).toMatchObject([
    { role: "user", content: "look" },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    {
      role: "user",
      content: [
        { type: "text", text: "<total_tokens>1000 tokens left</total_tokens>" },
        { type: "text", text: "again" },
      ],
    },
  ]);
});

test("appends a mid-conversation system note to a tool result", () => {
  const context = buildTestContext({
    model: "dari/routing",
    messages: [
      { role: "user", content: "look" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "result" },
      { role: "system", content: "<total_tokens>1000 tokens left</total_tokens>" },
    ],
  });

  const messages = context.messages as Array<Record<string, unknown>>;
  expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
  expect(messages.at(-1)).toMatchObject({
    role: "toolResult",
    content: [
      { type: "text", text: "result" },
      { type: "text", text: "<total_tokens>1000 tokens left</total_tokens>" },
    ],
  });
});

test("restores canonical image detail after Pi lowers OpenAI image payloads", () => {
  const imageUrl = "data:image/png;base64,aGVsbG8=";
  const options = buildModelOptions("openai/gpt-4.1-mini", {
    model: "dari/routing",
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
          { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
        ],
      },
    ],
  });
  const payload = (options.onPayload as (payload: unknown) => unknown)({
    input: [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: imageUrl, detail: "auto" },
          { type: "input_image", image_url: imageUrl, detail: "auto" },
        ],
      },
    ],
  });

  expect(payload).toEqual({
    input: [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: imageUrl, detail: "high" },
          { type: "input_image", image_url: imageUrl, detail: "low" },
        ],
      },
    ],
  });
});
test("maps tool results back to the original function name", () => {
  const context = buildTestContext({
    model: "dari/routing",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_weather",
            type: "function",
            function: { name: "get_weather", arguments: JSON.stringify({ city: "Oakland" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_weather", content: "72 and sunny" },
    ],
  });

  expect(context.messages).toMatchObject([
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_weather", name: "get_weather", arguments: { city: "Oakland" } }],
    },
    {
      role: "toolResult",
      toolCallId: "call_weather",
      toolName: "get_weather",
      content: [{ type: "text", text: "72 and sunny" }],
    },
  ]);
});

test("preserves empty Chat user and assistant messages at the Pi boundary", () => {
  const context = buildTestContext({
    model: "dari/routing",
    messages: [
      { role: "user", content: null },
      { role: "assistant" },
    ],
  });

  expect(context.messages).toMatchObject([
    { role: "user", content: "" },
    { role: "assistant", content: [{ type: "text", text: "" }] },
  ]);
});

test("maps reasoning_effort to Pi reasoning", async () => {
  const highOptions = buildModelOptions(
    "deepseek-ai/DeepSeek-V4-Pro-0813",
    requestWithReasoning({ reasoning_effort: "high" })
  );
  expect(highOptions.reasoning).toBe("high");

  const maxOptions = buildModelOptions(
    "deepseek-ai/DeepSeek-V4-Pro-0813",
    requestWithReasoning({ reasoning_effort: "max" })
  );
  expect(maxOptions.reasoning).toBe("max");

  const openAIMaxOptions = buildModelOptions(
    "openai/gpt-5.6-terra",
    requestWithReasoning({ reasoning_effort: "max" })
  );
  expect(openAIMaxOptions.reasoning).toBe("max");
});

test("uses the cataloged provider default when reasoning is omitted", async () => {
  const options = buildModelOptions(
    "deepseek-ai/DeepSeek-V4-Pro-0813",
    requestWithReasoning({})
  );
  expect(options.reasoning).toBe("high");

  expect(buildModelOptions(
    "zai-org/GLM-5.2",
    requestWithReasoning({})
  ).reasoning).toBe("max");

  const defaultOff = buildOptions(
    chatCompletionsToInteraction(requestWithReasoning({})),
    "sk-test",
    "anthropic/claude-opus-4-8",
    {
      api: "anthropic-messages",
      reasoning: true,
      supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
      defaultThinkingLevel: "off",
    },
    piFixture,
  );
  expect(defaultOff.reasoning).toBeUndefined();

  // Non-reasoning models (only "off" supported) keep omitting the field.
  expect(buildModelOptions(
    "openai/gpt-4.1-mini",
    requestWithReasoning({})
  ).reasoning).toBeUndefined();
});

test("effective off injects wire none for models that keep thinking when the field is omitted", async () => {
  const options = buildModelOptions(
    "deepseek-ai/DeepSeek-V4-Pro-0813",
    requestWithReasoning({ reasoning_effort: "off" })
  );
  expect(options.reasoning).toBeUndefined();
  const onPayload = options.onPayload as (payload: unknown) => unknown;
  expect(typeof onPayload).toBe("function");
  expect(onPayload({ model: "deepseek" })).toEqual({ model: "deepseek", reasoning_effort: "none" });

  const defaultOff = buildOptions(
    chatCompletionsToInteraction(requestWithReasoning({})),
    "sk-test",
    "deepseek-ai/DeepSeek-V4-Pro-0813",
    {
      api: "openai-completions",
      reasoning: true,
      supportedThinkingLevels: ["off", "high", "max"],
      defaultThinkingLevel: "off",
    },
    piFixture,
  );
  expect(defaultOff.reasoning).toBeUndefined();
  const defaultOnPayload = defaultOff.onPayload as (payload: unknown) => unknown;
  expect(typeof defaultOnPayload).toBe("function");
  expect(defaultOnPayload({ model: "deepseek" })).toEqual({
    model: "deepseek",
    reasoning_effort: "none",
  });

  // Pi 1.1 no longer bundles Fireworks GLM 5.2, so preserve off locally.
  const glm = buildModelOptions(
    "zai-org/GLM-5.2",
    requestWithReasoning({ reasoning_effort: "off" })
  );
  expect(glm.reasoning).toBeUndefined();
  expect((glm.onPayload as (payload: unknown) => unknown)({ model: "glm" })).toEqual({
    model: "glm",
    reasoning_effort: "none",
  });

  // DeepSeek V4 Flash 0731 is not in the Pi registry, so its off must be
  // injected as provider reasoning_effort "none" just like Flash/Pro.
  const flash0731 = buildModelOptions(
    "deepseek-ai/DeepSeek-V4-Flash-0731",
    requestWithReasoning({ reasoning_effort: "off" })
  );
  expect(flash0731.reasoning).toBeUndefined();
  const flash0731OnPayload = flash0731.onPayload as (payload: unknown) => unknown;
  expect(typeof flash0731OnPayload).toBe("function");
  expect(flash0731OnPayload({ model: "deepseek-v4-flash-0731" })).toEqual({
    model: "deepseek-v4-flash-0731",
    reasoning_effort: "none",
  });
});

test("defaults Claude Fable 5 to reasoning because direct Anthropic requires it", async () => {
  expect(buildModelOptions(
    "anthropic/claude-fable-5",
    requestWithReasoning({})
  ).reasoning).toBe("high");
});

test("preserves disabled Anthropic thinking alongside output effort", () => {
  const request = anthropicMessagesToInteraction({
    model: "dari/routing",
    max_tokens: 4096,
    thinking: { type: "disabled" },
    output_config: { effort: "high" },
    messages: [{ role: "user", content: "hello" }],
  });
  const options = buildOptions(
    request,
    "sk-test",
    "anthropic/claude-fable-5",
    modelFixtures["anthropic/claude-fable-5"],
    piFixture,
  );

  expect(options.reasoning).toBe("high");
  expect((options.onPayload as (payload: unknown) => unknown)({
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
  })).toEqual({
    thinking: { type: "disabled" },
    output_config: { effort: "high" },
  });
});

test("defaults OpenAI Responses models without an off mapping to medium", async () => {
  expect(buildModelOptions(
    "openai/gpt-5.5-pro",
    requestWithReasoning({})
  ).reasoning).toBe("medium");
});

test("rejects unsupported reasoning before provider execution", async () => {
  expect(buildModelOptions(
    "deepseek-ai/DeepSeek-V4-Pro-0813",
    requestWithReasoning({ reasoning_effort: "off" })
  ).reasoning).toBeUndefined();

  expect(() =>
    buildModelOptions(
      "fireworks/moonshotai/Kimi-K2.6",
      requestWithReasoning({ reasoning_effort: "xhigh" })
    )
  ).toThrow("Supported values: off");

  expect(() =>
    buildModelOptions(
      "openai/gpt-4.1-mini",
      requestWithReasoning({ reasoning_effort: "low" })
    )
  ).toThrow("Supported values: off");
});

test("explicit off is rejected when model metadata does not support off", async () => {
  expect(() => buildModelOptions(
    "openai/gpt-5.5-pro",
    requestWithReasoning({ reasoning_effort: "off" })
  )).toThrow("Supported values: medium, high, xhigh");
});

test("unknown reasoning metadata falls back to off only", () => {
  expect(supportedThinkingLevels({ reasoning: true }, {})).toEqual(["off"]);
});

test("null catalog levels defer to known metadata and keep unknown custom models permissive", () => {
  const registeredPi = {
    ...piFixture,
    getModel: (provider: string, id: string) => modelFixtures[`${provider}/${id}`],
  };
  const registeredConfig: ResolvedRouterModelConfig = {
    provider: "openai",
    native_model_id: "gpt-5.5-pro",
    api: "openai-responses",
    base_url: "https://api.openai.com/v1",
    supported_thinking_levels: null,
    supports_managed_key: true,
    cost: { input: 1, output: 2 },
  };
  const registered = buildModel(
    registeredPi,
    "openai/gpt-5.5-pro",
    null,
    registeredConfig
  );
  expect(
    getPiSupportedThinkingLevels(
      registered as unknown as Parameters<typeof getPiSupportedThinkingLevels>[0]
    )
  ).toEqual(["medium", "high", "xhigh"]);

  const customConfig: ResolvedRouterModelConfig = {
    provider: "acme",
    native_model_id: "reasoner-v1",
    api: "openai-completions",
    base_url: "https://llm.acme.example/v1",
    supported_thinking_levels: null,
    supports_managed_key: false,
    cost: { input: 1, output: 2 },
  };
  const custom = buildModel(piFixture, "acme/reasoner-v1", null, customConfig);
  const customPiModel = custom as unknown as Parameters<
    typeof getPiSupportedThinkingLevels
  >[0];
  expect(getPiSupportedThinkingLevels(customPiModel)).toEqual([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  expect(clampThinkingLevel(customPiModel, "max")).toBe("max");
  expect(
    buildOptions(
      chatCompletionsToInteraction(requestWithReasoning({ reasoning_effort: "max" })),
      "sk-acme",
      "acme/reasoner-v1",
      custom,
      piFixture,
    ).reasoning
  ).toBe("max");
});

test("builds OpenAI subscription models with the Codex Responses transport", () => {
  const config: ResolvedRouterModelConfig = {
    provider: "openai-codex",
    native_model_id: "gpt-4.1-mini",
    api: "openai-codex-responses",
    base_url: "https://chatgpt.com/backend-api",
    supported_thinking_levels: ["medium", "high"],
    supports_managed_key: true,
    cost: { input: 1, output: 2 },
  };

  expect(buildModel(piFixture, "openai/gpt-4.1-mini", null, config)).toMatchObject({
    id: "gpt-4.1-mini",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
  });
});

test("unregistered Bedrock model ids resolve the Converse Stream transport defaults", () => {
  expect(
    buildModel(piFixture, "amazon-bedrock/anthropic.claude-custom-v1", null, undefined)
  ).toMatchObject({
    id: "anthropic.claude-custom-v1",
    provider: "amazon-bedrock",
    api: "bedrock-converse-stream",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  });
});

// The real Pi registry.
const registryFixture = { ...piFixture, getModel: pi.getModel };

const AZURE_OPENAI_CONFIG: ResolvedRouterModelConfig = {
  provider: "azure",
  native_model_id: "gpt-5.6-sol",
  api: "azure-openai-responses",
  base_url: "https://dari.services.ai.azure.com/openai/v1",
  context_window: 1_050_000,
  supported_thinking_levels: ["off", "low", "medium", "high", "xhigh", "max"],
  default_thinking_level: "medium",
  cost: { input: 4, output: 20, cached_input: 0.4, cache_write: 5 },
  supports_managed_key: false,
};

test("Azure OpenAI models resolve Pi's Azure Responses registry under the resolved config", () => {
  const model = buildModel(registryFixture, "openai/gpt-5.6-sol", null, AZURE_OPENAI_CONFIG);

  expect(model).toMatchObject({
    id: "gpt-5.6-sol",
    provider: "azure",
    api: "azure-openai-responses",
    baseUrl: "https://dari.services.ai.azure.com/openai/v1",
    reasoning: true,
    input: ["text", "image"],
    defaultThinkingLevel: "medium",
  });
  expect(model.cost).toEqual({ input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 });
});

test("Claude on Azure keeps the Anthropic registry's model metadata", () => {
  const model = buildModel(registryFixture, "anthropic/claude-sonnet-5", null, {
    provider: "azure",
    native_model_id: "claude-sonnet-5",
    api: "anthropic-messages",
    base_url: "https://dari.services.ai.azure.com/anthropic",
    context_window: 1_000_000,
    supported_thinking_levels: ["off", "low", "medium", "high", "xhigh", "max"],
    default_thinking_level: "high",
    cost: { input: 2, output: 10, cached_input: 0.2, cache_write: 2.5 },
    supports_managed_key: false,
  });

  expect(model).toMatchObject({
    id: "claude-sonnet-5",
    provider: "azure",
    api: "anthropic-messages",
    baseUrl: "https://dari.services.ai.azure.com/anthropic",
    input: ["text", "image"],
  });
  expect(model.compat).toMatchObject({
    forceAdaptiveThinking: true,
    supportsTemperature: false,
  });
});

test("Azure models require the credential-derived base URL", () => {
  const { base_url: _baseUrl, ...withoutEndpoint } = AZURE_OPENAI_CONFIG;
  expect(() => buildModel(piFixture, "openai/gpt-5.6-sol", null, withoutEndpoint)).toThrow(
    "No base URL is configured for provider azure."
  );
  // Custom deployment names miss the registry but keep the Azure transport.
  expect(
    buildModel(registryFixture, "openai/gpt-5.6-sol", null, {
      ...AZURE_OPENAI_CONFIG,
      native_model_id: "sol-eu",
      base_url: "https://dari-eu.openai.azure.com/openai/v1",
    })
  ).toMatchObject({
    id: "sol-eu",
    provider: "azure",
    api: "azure-openai-responses",
    baseUrl: "https://dari-eu.openai.azure.com/openai/v1",
    input: ["text", "image"],
  });
});

test("drops temperature for models that reject it", () => {
  const request = chatCompletionsToInteraction({
    model: "dari/routing",
    messages: [{ role: "user", content: "Capital of France?" }],
    temperature: 0.2,
  });
  const astra = buildModel(registryFixture, "openai/gpt-6-astra", null, {
    ...AZURE_OPENAI_CONFIG,
    native_model_id: "gpt-6-astra",
    supported_thinking_levels: ["low", "medium", "high", "xhigh", "max"],
  });
  expect(astra.compat).toMatchObject({ supportsTemperature: false });
  expect(buildOptions(request, "azure-key", "openai/gpt-6-astra", astra, piFixture).temperature).toBeUndefined();

  const luna = buildModel(registryFixture, "openai/gpt-5.6-luna", null, {
    ...AZURE_OPENAI_CONFIG,
    native_model_id: "gpt-5.6-luna",
  });
  expect(buildOptions(request, "azure-key", "openai/gpt-5.6-luna", luna, piFixture).temperature).toBe(0.2);
});

test("passes the Azure resource key through Pi options", () => {
  const options = buildOptions(
    chatCompletionsToInteraction({
      model: "dari/routing",
      messages: [{ role: "user", content: "Use the Azure resource key." }],
    }),
    "azure-key",
    "openai/gpt-5.6-sol",
    buildModel(registryFixture, "openai/gpt-5.6-sol", null, AZURE_OPENAI_CONFIG),
    piFixture,
  );

  expect(options.apiKey).toBe("azure-key");
  expect(options.env).toBeUndefined();
});

test("delegates Bedrock reasoning serialization to Pi", () => {
  const model = {
    id: "global.openai.gpt-5.6-sol",
    provider: "amazon-bedrock",
    api: "bedrock-converse-stream",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinkingLevel: "medium",
  };

  for (const level of ["off", "low", "medium", "high", "xhigh", "max"] as const) {
    const options = buildOptions(
      chatCompletionsToInteraction(requestWithReasoning({ reasoning_effort: level })),
      "test-api-key",
      "openai/gpt-5.6-sol",
      model,
      piFixture,
    );

    expect(options.reasoning).toBe(level === "off" ? undefined : level);
    expect(options.onPayload).toBeUndefined();
  }
});

test("Bedrock tool choice rides options.toolChoice instead of a payload patch", () => {
  const tools = [
    {
      type: "function" as const,
      function: {
        name: "get_weather",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
  const required = buildModelOptions("amazon-bedrock/global.anthropic.claude-sonnet-5", {
    model: "dari/routing",
    messages: [{ role: "user", content: "hello" }],
    tools,
    tool_choice: "required",
  });
  expect(required.toolChoice).toBe("required");
  expect(required.onPayload).toBeUndefined();

  const named = buildModelOptions("amazon-bedrock/global.anthropic.claude-sonnet-5", {
    model: "dari/routing",
    messages: [{ role: "user", content: "hello" }],
    tools,
    tool_choice: { type: "function", function: { name: "get_weather" } },
  });
  expect(named.toolChoice).toEqual({ type: "function", function: { name: "get_weather" } });
  expect(named.onPayload).toBeUndefined();
});

test("passes Fireworks reasoning without provider-specific token budget guards", () => {
  expect(
    buildModelOptions("zai-org/GLM-5.2", {
      ...requestWithReasoning({ reasoning_effort: "high" }),
      max_completion_tokens: 128,
    }).reasoning
  ).toBe("high");
});

test("preserves top_p and stop controls in hosted provider payloads", async () => {
  const options = buildModelOptions("deepseek-ai/DeepSeek-V4-Pro-0813", {
    model: "dari/routing",
    messages: [{ role: "user", content: "hello" }],
    top_p: 0.7,
    stop: ["END"],
  });
  const payload = await (options.onPayload as (payload: unknown) => unknown | Promise<unknown>)({
    model: "deepseek-v4",
    messages: [],
    stream: true,
  });
  expect(payload).toMatchObject({ top_p: 0.7, stop: ["END"] });
});

test("does not inject top_p into Anthropic thinking payloads", async () => {
  const options = buildModelOptions("anthropic/claude-fable-5", {
    model: "dari/routing",
    messages: [{ role: "user", content: "hello" }],
    top_p: 0.7,
    stop: ["END"],
    reasoning_effort: "high",
  });
  const thinking = { type: "adaptive" };
  const payload = await (options.onPayload as (payload: unknown) => unknown | Promise<unknown>)({
    model: "claude-opus-5-5",
    messages: [],
    thinking,
  });
  expect(payload).not.toHaveProperty("top_p");
  expect(payload).toMatchObject({ thinking, stop_sequences: ["END"] });
});

test("does not send unsupported stop sequences to OpenAI Responses APIs", async () => {
  const options = buildModelOptions("openai/gpt-4.1-mini", {
    model: "dari/routing",
    messages: [{ role: "user", content: "hello" }],
    stop: ["END"],
  });
  const payload = await (options.onPayload as (payload: unknown) => unknown | Promise<unknown>)({
    model: "gpt-4.1-mini",
    input: [],
    stream: true,
  });
  expect(payload).not.toHaveProperty("stop");
});

test("injects response_format into OpenAI-compatible payloads", async () => {
  const format = {
    type: "json_schema" as const,
    json_schema: {
      name: "routing_decision",
      strict: true,
      schema: {
        type: "object",
        properties: { selected_model: { type: "string" }, reason: { type: "string" } },
        required: ["selected_model", "reason"],
        additionalProperties: false,
      },
    },
  };
  const options = buildModelOptions("deepseek-ai/DeepSeek-V4-Pro-0813", {
    model: "dari/routing",
    messages: [{ role: "user", content: "hello" }],
    response_format: format,
  });

  const payload = await (options.onPayload as (payload: unknown) => unknown | Promise<unknown>)({
    model: "deepseek-ai/DeepSeek-V4-Pro",
    messages: [],
    stream: true,
  });

  expect(payload).toMatchObject({ response_format: format });
});

test("injects text.format into OpenAI Responses payloads", async () => {
  const format = {
    type: "json_schema" as const,
    json_schema: {
      name: "routing_decision",
      strict: true,
      schema: {
        type: "object",
        properties: { selected_model: { type: "string" }, reason: { type: "string" } },
        required: ["selected_model", "reason"],
        additionalProperties: false,
      },
    },
  };
  const options = buildModelOptions("openai/gpt-4.1-mini", {
    model: "dari/routing",
    messages: [{ role: "user", content: "hello" }],
    response_format: format,
  });

  const payload = await (options.onPayload as (payload: unknown) => unknown | Promise<unknown>)({
    model: "gpt-4.1-mini",
    input: [],
    stream: true,
    text: { verbosity: "low" },
  });

  expect(payload).toMatchObject({
    text: {
      verbosity: "low",
      format: {
        name: "routing_decision",
        strict: true,
        type: "json_schema",
        schema: format.json_schema.schema,
      },
    },
  });
});

test("injects output_config.format into Anthropic Messages payloads", async () => {
  const format = {
    type: "json_schema" as const,
    json_schema: {
      name: "routing_decision",
      strict: true,
      schema: {
        type: "object",
        properties: { selected_model: { type: "string" } },
        required: ["selected_model"],
        additionalProperties: false,
      },
    },
  };
  const options = buildModelOptions("anthropic/claude-fable-5", {
    model: "dari/routing",
    messages: [{ role: "user", content: "hello" }],
    response_format: format,
  });

  const payload = await (options.onPayload as (payload: unknown) => unknown | Promise<unknown>)({
    model: "claude-fable-5",
    messages: [],
    stream: true,
    output_config: { effort: "high" },
  });

  expect(payload).toMatchObject({
    output_config: {
      effort: "high",
      format: {
        type: "json_schema",
        schema: format.json_schema.schema,
      },
    },
  });
});

test("requests OpenAI priority processing without double-applying premium rates", () => {
  const config: ResolvedRouterModelConfig = {
    provider: "openai",
    native_model_id: "gpt-5.6-terra",
    api: "openai-responses",
    base_url: "https://api.openai.com/v1",
    context_window: 1_050_000,
    supported_thinking_levels: ["off", "low", "medium", "high", "xhigh", "max"],
    supports_managed_key: true,
    cost: { input: 2.5, output: 15, cached_input: 0.25, cache_write: 3.125 },
    fast_mode: true,
    fast_mode_cost: { input: 5, output: 30, cached_input: 0.5, cache_write: 6.25 },
  };
  const model = buildModel(
    piFixture,
    "openai/gpt-5.6-terra",
    { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    config,
  );
  const options = buildOptions(
    chatCompletionsToInteraction(requestWithReasoning({ reasoning_effort: "high" })),
    "sk-test",
    "openai/gpt-5.6-terra",
    model,
    piFixture,
  );

  expect(model.fastMode).toBe(true);
  expect(model.cost).toEqual({
    input: 2.5,
    output: 15,
    cacheRead: 0.25,
    cacheWrite: 3.125,
  });
  expect(options.serviceTier).toBe("priority");
  expect((options.onPayload as (payload: unknown) => unknown)({ model: "gpt-5.6-terra" })).toEqual({
    model: "gpt-5.6-terra",
    service_tier: "priority",
  });
});

test("requests OpenAI priority processing for compatible completions APIs", () => {
  const config: ResolvedRouterModelConfig = {
    provider: "openai",
    native_model_id: "gpt-fast-compatible",
    api: "openai-completions",
    base_url: "https://api.openai.com/v1",
    supports_managed_key: true,
    cost: { input: 1, output: 4 },
    fast_mode: true,
    fast_mode_cost: { input: 2, output: 8 },
  };
  const premium = { input: 2, output: 8, cacheRead: 2, cacheWrite: 2 };
  const model = buildModel(piFixture, "openai/gpt-fast-compatible", premium, config);
  const options = buildOptions(
    chatCompletionsToInteraction(requestWithReasoning({})),
    "sk-test",
    "openai/gpt-fast-compatible",
    model,
    piFixture,
  );

  expect(model.cost).toEqual(premium);
  expect((options.onPayload as (payload: unknown) => unknown)({ model: "gpt-fast-compatible" })).toEqual({
    model: "gpt-fast-compatible",
    service_tier: "priority",
  });
});

test("requests Anthropic Fast Mode and uses its explicit premium rates", () => {
  const config: ResolvedRouterModelConfig = {
    provider: "anthropic",
    native_model_id: "claude-opus-4-8",
    api: "anthropic-messages",
    base_url: "https://api.anthropic.com",
    context_window: 1_000_000,
    supported_thinking_levels: ["off", "low", "medium", "high", "xhigh"],
    supports_managed_key: true,
    cost: { input: 5, output: 25, cached_input: 0.5, cache_write: 6.25 },
    fast_mode: true,
    fast_mode_cost: { input: 10, output: 50, cached_input: 1, cache_write: 12.5 },
  };
  const model = buildModel(piFixture, "anthropic/claude-opus-4-8", null, config);
  const options = buildOptions(
    chatCompletionsToInteraction(requestWithReasoning({ reasoning_effort: "high" })),
    "sk-test",
    "anthropic/claude-opus-4-8",
    model,
    piFixture,
  );

  expect(model.fastMode).toBe(true);
  expect(model.cost).toEqual({
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
  });
  expect(options.headers).toEqual({
    "anthropic-beta": "fast-mode-2026-02-01",
  });
  expect((options.onPayload as (payload: unknown) => unknown)({ model: "claude-opus-4-8" })).toEqual({
    model: "claude-opus-4-8",
    speed: "fast",
  });
});

test("lowers portable tool choice and parallel-call controls at the provider boundary", () => {
  const openai = buildModelOptions("openai/gpt-4.1-mini", {
    model: "dari/routing",
    messages: [{ role: "user", content: "hello" }],
    tool_choice: { type: "function", function: { name: "read_file" } },
    parallel_tool_calls: false,
  });
  expect((openai.onPayload as (payload: unknown) => unknown)({
    input: [],
    tools: [{ type: "function", name: "read_file" }],
  })).toEqual({
    input: [],
    tools: [{ type: "function", name: "read_file" }],
    tool_choice: { type: "function", name: "read_file" },
    parallel_tool_calls: false,
  });

  const anthropic = buildModelOptions("anthropic/claude-fable-5", {
    model: "dari/routing",
    messages: [{ role: "user", content: "hello" }],
    parallel_tool_calls: false,
  });
  expect((anthropic.onPayload as (payload: unknown) => unknown)({
    tools: [{ name: "read_file" }],
  })).toEqual({
    tools: [{ name: "read_file" }],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
  });

  const anthropicNone = buildModelOptions("anthropic/claude-fable-5", {
    model: "dari/routing",
    messages: [{ role: "user", content: "hello" }],
    tool_choice: "none",
    parallel_tool_calls: false,
  });
  expect((anthropicNone.onPayload as (payload: unknown) => unknown)({
    tools: [{ name: "read_file" }],
  })).toEqual({
    tools: [{ name: "read_file" }],
    tool_choice: { type: "none" },
  });
});

test("drops tool choice when the provider payload has no tools", () => {
  for (const selectedModel of ["openai/gpt-4.1-mini", "anthropic/claude-fable-5"]) {
    const options = buildModelOptions(selectedModel, {
      model: "dari/routing",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      tool_choice: "auto",
    });

    expect((options.onPayload as (payload: unknown) => unknown)({
      input: [],
      tool_choice: "auto",
    })).toEqual({ input: [] });
  }
});

test("lowers custom tool choices to the provider-visible emulated function kind", () => {
  const options = buildOptions(
    openAIResponsesToInteraction({
      model: "dari/routing",
      input: "apply this patch",
      tools: [{ type: "custom", name: "apply_patch" }],
      tool_choice: { type: "custom", name: "apply_patch" },
    }),
    "sk-test",
    "openai/gpt-4.1-mini",
    modelFixtures["openai/gpt-4.1-mini"],
    piFixture
  );
  const declaredTool = { type: "function", name: "apply_patch" };

  expect((options.onPayload as (payload: unknown) => unknown)({
    input: [],
    tools: [declaredTool],
  })).toEqual({
    input: [],
    tools: [declaredTool],
    tool_choice: { type: "function", name: "apply_patch" },
  });
});

test("injects hosted web search into API and subscription Responses payloads", async () => {
  const request = openAIResponsesToInteraction({
    model: "dari/routing",
    input: "Search the OpenAI docs.",
    tools: [
      { type: "function", name: "exec_command", parameters: { type: "object" } },
      {
        type: "web_search",
        search_context_size: "high",
        filters: { allowed_domains: ["openai.com"] },
      },
    ],
    tool_choice: { type: "web_search" },
  });
  for (const selectedModel of ["openai/gpt-4.1-mini", "openai/gpt-5.6-sol"]) {
    const options = buildOptions(
      request,
      "sk-test",
      selectedModel,
      modelFixtures[selectedModel],
      piFixture,
    );

    expect(options.emitProviderEvents).toBe(true);
    const payload = await (options.onPayload as (value: unknown) => unknown | Promise<unknown>)({
      input: [],
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
    });
    expect(payload).toEqual({
      input: [],
      tools: [
        { type: "function", name: "exec_command", parameters: { type: "object" } },
        {
          type: "web_search",
          search_context_size: "high",
          filters: { allowed_domains: ["openai.com"] },
        },
      ],
      tool_choice: { type: "web_search" },
    });
  }
});

test("emits provider events for implicit hosted search requirements", () => {
  const historyRequest = openAIResponsesToInteraction({
    model: "dari/routing",
    input: [
      {
        type: "web_search_call",
        id: "ws_prior",
        status: "completed",
        action: { type: "search", query: "prior result" },
      },
      { role: "user", content: [{ type: "input_text", text: "Continue." }] },
    ],
  });
  const choiceRequest = openAIResponsesToInteraction({
    model: "dari/routing",
    input: "Search now.",
    tool_choice: { type: "web_search" },
  });

  const targets = [
    ["openai/gpt-4.1-mini", modelFixtures["openai/gpt-4.1-mini"]],
    ["azure/gpt-4.1-mini", {
      id: "gpt-4.1-mini",
      provider: "azure",
      api: "azure-openai-responses",
      reasoning: false,
      supportedThinkingLevels: ["off"],
    }],
    ["openai/gpt-5.6-sol", modelFixtures["openai/gpt-5.6-sol"]],
  ] as const;
  for (const request of [historyRequest, choiceRequest]) {
    for (const [selectedModel, model] of targets) {
      const options = buildOptions(request, "sk-test", selectedModel, model, piFixture);
      expect(options.emitProviderEvents).toBe(true);
    }
  }
});

test("preserves strict tool declarations in OpenAI provider payloads", () => {
  const responses = buildModelOptions("openai/gpt-4.1-mini", {
    model: "dari/routing",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: { type: "object" },
          strict: true,
        },
      },
    ],
  });
  expect((responses.onPayload as (payload: unknown) => unknown)({
    tools: [{ type: "function", name: "read_file", parameters: { type: "object" }, strict: false }],
  })).toEqual({
    tools: [{ type: "function", name: "read_file", parameters: { type: "object" }, strict: true }],
  });

  const completions = buildModelOptions("deepseek-ai/DeepSeek-V4-Pro-0813", {
    model: "dari/routing",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: { type: "object" },
          strict: true,
        },
      },
    ],
  });
  expect((completions.onPayload as (payload: unknown) => unknown)({
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" }, strict: false } }],
  })).toEqual({
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" }, strict: true } }],
  });

  const anthropic = buildModelOptions("anthropic/claude-fable-5", {
    model: "dari/routing",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          strict: true,
        },
      },
    ],
  });
  expect((anthropic.onPayload as (payload: unknown) => unknown)({
    tools: [{ name: "read_file", input_schema: { type: "object" } }],
  })).toEqual({
    tools: [
      {
        name: "read_file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        strict: true,
      },
    ],
  });
});

test("anthropic strict tools patch preserves Pi's defer_loading placement", () => {
  const parameters = { type: "object", properties: { city: { type: "string" } } };
  const options = buildOptions(
    {
      sourceProtocol: "anthropic_messages",
      model: "dari/routing",
      items: [],
      generation: {},
      stream: true,
      tools: [
        { kind: "function", name: "deferred_tool", parameters, deferLoading: true },
        { kind: "function", name: "force_loaded_tool", parameters, deferLoading: true },
      ],
    },
    "sk-test",
    "anthropic/claude-fable-5",
    modelFixtures["anthropic/claude-fable-5"],
    piFixture
  );

  // Pi placed one tool in the deferred batch and force-loaded the other; the
  // patch must not re-add defer_loading from the interaction definition.
  expect((options.onPayload as (payload: unknown) => unknown)({
    tools: [
      { name: "force_loaded_tool", input_schema: { type: "object" } },
      { name: "deferred_tool", input_schema: { type: "object" }, defer_loading: true },
    ],
  })).toEqual({
    tools: [
      { name: "force_loaded_tool", input_schema: parameters },
      { name: "deferred_tool", input_schema: parameters, defer_loading: true },
    ],
  });
});
