import { expect, test } from "bun:test";

import {
  createRouter,
  RouterFrameworkError,
  type RouterModel,
} from "../src/index.js";
import {
  createDariRoutingPolicy,
  type ChatCompletionRequest,
  type DariPolicyDetails,
  type SelectorInput,
} from "../src/policy-engine.js";
import {
  anthropicRequest,
  encodeProviderContinuationState,
  openAIChatRequest,
} from "../src/protocols.js";

const MINI = "openai/gpt-4.1-mini";
const SONNET = "anthropic/claude-sonnet-4-6";

const COST_OPTIONS = {
  pricing: (model: string) => model === MINI
    ? { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 }
    : { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  averageOutputTokensByModel: {
    [MINI]: { high: 800 },
    [SONNET]: { high: 1_600 },
  },
};

const MODELS: RouterModel[] = [
  {
    id: MINI,
    executor: "mock",
    api: "openai-responses",
    reasoningEfforts: ["high"],
    capabilities: { imageInput: true, toolUse: true },
  },
  {
    id: SONNET,
    executor: "mock",
    api: "anthropic-messages",
    reasoningEfforts: ["high"],
    capabilities: { imageInput: true, toolUse: true },
  },
];

const UNUSED_EXECUTORS = {
  mock: {
    execute: () => {
      throw new Error("executor must not run");
    },
  },
};

test("createDariRoutingPolicy requires host-owned cost estimates", () => {
  const base = {
    selector: async () => "",
    selectorModel: "selector/model",
    selectorContextWindowChars: 100_000,
  };

  expect(() => createDariRoutingPolicy(base as never)).toThrow(
    "requires a pricing lookup supplied by the host",
  );
  expect(() => createDariRoutingPolicy({
    ...base,
    pricing: () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }),
  } as never)).toThrow("requires host-observed output-token averages");
});

test("createDariRoutingPolicy is an inspectable, swappable built-in policy", async () => {
  let selectorRequest: ChatCompletionRequest | undefined;
  let selectorSignal: AbortSignal | undefined;
  const policy = createDariRoutingPolicy({
    ...COST_OPTIONS,
    selector: async (request, signal) => {
      selectorRequest = request;
      selectorSignal = signal;
      return JSON.stringify({
        selected_model: SONNET,
        reasoning_effort: "high",
        reason: "The selector chose the stronger candidate.",
      });
    },
    selectorModel: "selector/model",
    selectorContextWindowChars: 100_000,
    state: () => ({ nowMs: Date.parse("2026-07-29T00:00:00Z") }),
  });
  const router = createRouter({
    models: MODELS,
    policy,
    executors: {
      mock: {
        execute: ({ model, decision }) => ({
          type: "complete",
          output: {
            content: [{
              type: "text",
              text: `${model.id}/${decision.reasoningEffort}`,
            }],
            finishReason: "stop",
          },
        }),
      },
    },
  });
  const payload = {
    model: "my-router",
    max_tokens: 128,
    system: "Route carefully.",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
      ],
    }],
    tools: [{ name: "lookup", input_schema: { type: "object" } }],
    tool_choice: { type: "auto" },
    thinking: { type: "enabled", budget_tokens: 1024 },
    output_config: { effort: "high" },
  };

  const selection = await router.select(anthropicRequest(payload));

  expect(selection.decision).toEqual({
    selectedModel: SONNET,
    reasoningEffort: "high",
    reason: "The selector chose the stronger candidate.",
  });
  expect(selection.candidates.map((candidate) => candidate.id)).toEqual([MINI, SONNET]);
  expect(selectorSignal?.aborted).toBe(false);
  const details = selection.policyDetails as DariPolicyDetails;
  expect(details.selectorOutput).toContain(SONNET);
  expect(details.prepared.candidateResolution.candidates).toEqual([
    { model: MINI, reasoningEffort: "high" },
    { model: SONNET, reasoningEffort: "high" },
  ]);

  expect(selectorRequest?.model).toBe("selector/model");
  expect(selectorRequest?.reasoning_effort).toBe("off");
  const selectorInput = JSON.parse(
    String(selectorRequest?.messages?.[1]?.content),
  ) as SelectorInput;
  expect(selectorInput.candidate_pairs).toEqual([
    { model: MINI, thinking_level: "high" },
    { model: SONNET, thinking_level: "high" },
  ]);
  expect(selectorInput.messages).toEqual([
    {
      role: "system",
      content: [{ type: "text", text: "Route carefully." }],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        { type: "image_url", image_url: { url: "<image omitted>" } },
      ],
    },
  ]);

  const response = await router.fetch(new Request("https://router.example/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    model: SONNET,
    content: [{ type: "text", text: `${SONNET}/high` }],
    dari_routing: {
      selected_model: SONNET,
      reasoning_effort: "high",
      reason: "The selector chose the stronger candidate.",
    },
  });
});

test("Dari policy keeps interleaved Anthropic assistant blocks in one chat turn", async () => {
  let selectorRequest: ChatCompletionRequest | undefined;
  const policy = createDariRoutingPolicy({
    ...COST_OPTIONS,
    selector: async (request) => {
      selectorRequest = request;
      return JSON.stringify({
        selected_model: SONNET,
        reasoning_effort: "high",
        reason: "Only one candidate is configured.",
      });
    },
    selectorModel: "selector/model",
    selectorContextWindowChars: 100_000,
  });
  const router = createRouter({
    models: [MODELS[1]!],
    policy,
    executors: UNUSED_EXECUTORS,
  });

  await router.select(anthropicRequest({
    model: "my-router",
    max_tokens: 128,
    tools: [{ name: "lookup", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "Find it." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking " },
          { type: "tool_use", id: "call_1", name: "lookup", input: {} },
          { type: "text", text: "now." },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "Found it." }],
      },
    ],
  }));

  const selectorInput = JSON.parse(
    String(selectorRequest?.messages?.[1]?.content),
  ) as SelectorInput;
  expect(selectorInput.messages).toEqual([
    {
      role: "user",
      content: [{ type: "text", text: "Find it." }],
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Checking " },
        { type: "text", text: "now." },
      ],
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: "{}" },
      }],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: [{ type: "text", text: "Found it." }],
    },
  ]);
});

test("Dari policy classifies selector execution failures as policy failures", async () => {
  const router = createRouter({
    models: [MODELS[0]!],
    policy: createDariRoutingPolicy({
      ...COST_OPTIONS,
      selector: async () => {
        throw new RouterFrameworkError(
          "executor",
          "selector provider unavailable",
          "selector_provider_error",
        );
      },
      selectorModel: "selector/model",
      selectorContextWindowChars: 100_000,
    }),
    executors: UNUSED_EXECUTORS,
  });

  await expect(router.select(openAIChatRequest({
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    reasoning_effort: "high",
  }))).rejects.toMatchObject({
    kind: "policy",
    code: "selector_provider_error",
    message: "selector provider unavailable",
    status: 502,
  });
});

test("Dari policy preserves deterministic core error semantics", async () => {
  const invalidRequestRouter = createRouter({
    models: [MODELS[1]!],
    policy: createDariRoutingPolicy({
      ...COST_OPTIONS,
      selector: async () => {
        throw new Error("selector must not run");
      },
      selectorModel: "selector/model",
      selectorContextWindowChars: 100_000,
    }),
    executors: UNUSED_EXECUTORS,
  });

  await expect(invalidRequestRouter.select(anthropicRequest({
    model: "my-router",
    max_tokens: 128,
    messages: [{ role: "user", content: "Use the tool." }],
    tools: [{ name: "lookup", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "lookup" },
    thinking: { type: "enabled", budget_tokens: 1024 },
    output_config: { effort: "high" },
  }))).rejects.toMatchObject({
    kind: "invalid_request",
    code: "unsupported_tool_choice",
    param: "tool_choice",
    status: 400,
  });

  const invalidSelectorRouter = createRouter({
    models: [MODELS[0]!],
    policy: createDariRoutingPolicy({
      ...COST_OPTIONS,
      selector: async () => "not JSON",
      selectorModel: "selector/model",
      selectorContextWindowChars: 100_000,
    }),
    executors: UNUSED_EXECUTORS,
  });

  await expect(invalidSelectorRouter.select(openAIChatRequest({
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    reasoning_effort: "high",
  }))).rejects.toMatchObject({
    kind: "policy",
    code: "selector_invalid_json",
    status: 502,
  });
});

test("Dari policy strips encrypted continuation state from the selector request", async () => {
  let selectorRequest: ChatCompletionRequest | undefined;
  const policy = createDariRoutingPolicy({
    ...COST_OPTIONS,
    selector: async (request) => {
      selectorRequest = request;
      return JSON.stringify({
        selected_model: SONNET,
        reasoning_effort: "high",
        reason: "r",
      });
    },
    selectorModel: "selector/model",
    selectorContextWindowChars: 100_000,
    state: () => ({ nowMs: Date.parse("2026-07-29T00:00:00Z") }),
  });
  const router = createRouter({
    models: MODELS,
    policy,
    executors: {
      mock: {
        execute: () => ({
          type: "complete",
          output: { content: [{ type: "text", text: "ok" }], finishReason: "stop" },
        }),
      },
    },
  });
  await router.select(openAIChatRequest({
    model: "my-router",
    messages: [
      {
        role: "assistant",
        content: null,
        reasoning_content: "Inspect first.",
        reasoning_details: [{
          type: "reasoning.encrypted",
          id: "rs_1",
          data: encodeProviderContinuationState({
            kind: "openai_reasoning",
            source: { provider: "openai", api: "openai-responses", model: "gpt-5.4" },
            encryptedContent: "SECRET-ENCRYPTED-BLOB",
          }),
        }],
      },
      { role: "user", content: "next" },
    ],
  }));
  const serialized = JSON.stringify(selectorRequest);
  expect(serialized).not.toContain("SECRET-ENCRYPTED-BLOB");
  expect(serialized).not.toContain("reasoning_details");
  // Readable reasoning remains for routing context.
  expect(serialized).toContain("Inspect first.");
});
