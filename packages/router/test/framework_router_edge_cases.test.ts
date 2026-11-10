import { expect, test } from "bun:test";

import { encodeProviderContinuationState } from "../src/continuation_state.js";
import { openAIChatRequest } from "../src/protocol_openai_chat.js";
import { anthropicRequest } from "../src/protocol_anthropic.js";
import {
  createRouter,
  type LeaseStore,
  type RouterExecutor,
} from "../src/index.js";
import {
  asyncEvents,
  BASIC_MODEL,
  FALLBACK_LOW_MODEL,
  jsonRequest,
  RICH,
  RICH_MODEL,
  servedModel,
  textExecutor,
} from "./framework_router.fixtures.js";

test("hosted tool call history filters models without tool use", async () => {
  let candidateIds: string[] = [];
  const router = createRouter({
    models: [BASIC_MODEL, RICH_MODEL],
    policy: ({ candidates }) => {
      candidateIds = candidates.map((candidate) => candidate.id);
      return { model: candidates[0]!.id };
    },
    executors: {
      mock: {
        execute: () => ({
          type: "complete",
          output: { content: [{ type: "text", text: "ok" }], finishReason: "stop" },
        }),
      },
    },
  });

  // Follow-up turn replaying hosted web-search history without a tools array.
  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [
      { role: "user", content: "search please" },
      {
        role: "assistant",
        content: null,
        reasoning_details: [{
          type: "reasoning.encrypted",
          id: "rs_1",
          data: encodeProviderContinuationState({
            kind: "openai_reasoning",
            source: { provider: "openai", api: "openai-responses", model: "gpt-5.4" },
            encryptedContent: "enc",
            providerItemId: "rs_1",
            hostedToolCallIds: ["ws_1"],
          }),
        }],
        tool_calls: [{
          id: "ws_1",
          type: "function",
          function: {
            name: "web_search",
            arguments: JSON.stringify({ type: "web_search_call", id: "ws_1", status: "completed", query: "test" }),
          },
        }],
      },
      { role: "user", content: "and then?" },
    ],
  }));

  expect(response.status).toBe(200);
  expect(candidateIds).toEqual([RICH]);
});
test("empty cache keys never share a lease bucket", async () => {
  expect(openAIChatRequest({
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    prompt_cache_key: "",
  }).cacheKey).toBeUndefined();
  expect(anthropicRequest({
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    prompt_cache_key: "  ",
  }).cacheKey).toBeUndefined();

  let policyCalls = 0;
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, leaseTurnsRemaining: 5 };
    },
    executors: {
      mock: {
        execute: () => ({
          type: "complete",
          output: { content: [{ type: "text", text: "hi" }], finishReason: "stop" },
        }),
      },
    },
  });

  const emptyKeyBody = { model: "my-router", messages: [{ role: "user", content: "hello" }], prompt_cache_key: "" };
  await router.fetch(jsonRequest("/v1/chat/completions", emptyKeyBody));
  await router.fetch(jsonRequest("/v1/chat/completions", emptyKeyBody));
  expect(policyCalls).toBe(2);

  const keyedBody = { ...emptyKeyBody, prompt_cache_key: "conv-real" };
  await router.fetch(jsonRequest("/v1/chat/completions", keyedBody));
  await router.fetch(jsonRequest("/v1/chat/completions", keyedBody));
  expect(policyCalls).toBe(3);
});

test("Anthropic text interleaving with an open thinking block is a stream contract error", async () => {
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: asyncEvents([
            { type: "reasoning_delta", index: 0, delta: "thinking..." },
            { type: "text_delta", index: 1, delta: "text while thinking" },
            { type: "reasoning_end", index: 0 },
            { type: "finish", finishReason: "stop" },
          ]),
        }),
      },
    },
  });

  const response = await router.fetch(jsonRequest("/v1/messages", {
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }));
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("event: error");
  expect(body).toContain("cannot interleave with an open thinking block");
  expect(body).not.toContain("event: message_stop");
});

test("OpenAI streamed reasoning without a continuation emits a portable detail that replays", async () => {
  const source = { provider: "acme", api: "acme-api", model: "rich/model" };
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: asyncEvents([
            { type: "reasoning_delta", index: 0, delta: "Let me think." },
            { type: "reasoning_end", index: 0, source },
            { type: "text_delta", index: 1, delta: "Answer." },
            { type: "finish", finishReason: "stop" },
          ]),
        }),
      },
    },
  });

  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "think" }],
    stream: true,
  }));
  const body = await response.text();

  expect(response.status).toBe(200);
  const detailChunk = body
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice("data: ".length)))
    .find((chunk) => chunk.choices?.[0]?.delta?.reasoning_details !== undefined);
  expect(detailChunk).toBeDefined();
  const detail = detailChunk.choices[0].delta.reasoning_details[0];
  expect(String(detail.data)).toStartWith("dari-ir-v1.");

  const replayed = openAIChatRequest({
    model: "my-router",
    messages: [
      { role: "user", content: "think" },
      {
        role: "assistant",
        content: "Answer.",
        reasoning_content: "Let me think.",
        reasoning_details: [detail],
      },
      { role: "user", content: "next" },
    ],
  });
  const reasoning = replayed.items.find((item) => item.type === "reasoning");
  expect(reasoning).toMatchObject({ type: "reasoning", source });
});

test("fallback with requiresDifferentProvider skips same-provider candidates", async () => {
  const executed: string[] = [];
  const succeedingExecutor = (label: string): RouterExecutor => ({
    execute: () => {
      executed.push(label);
      return {
        type: "complete",
        output: { content: [{ type: "text", text: label }], finishReason: "stop" },
      };
    },
  });
  const router = createRouter({
    models: [
      { id: "acme/primary", executor: "primary-mock", reasoningEfforts: ["high"] },
      { id: "acme/backup", executor: "same-provider-mock", reasoningEfforts: ["high"] },
      { id: "other/backup", executor: "other-provider-mock", reasoningEfforts: ["high"] },
    ],
    policy: () => ({ model: "acme/primary", reasoningEffort: "high" }),
    executors: {
      "primary-mock": {
        execute: () => {
          executed.push("primary");
          throw new Error("primary down");
        },
      },
      "same-provider-mock": succeedingExecutor("same-provider"),
      "other-provider-mock": succeedingExecutor("other-provider"),
    },
    fallback: { enabled: true, requiresDifferentProvider: true },
  });

  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
  }));

  expect(response.status).toBe(200);
  expect(executed).toEqual(["primary", "other-provider"]);
  const body = await response.json();
  expect(body.dari_routing.selected_model).toBe("other/backup");
  expect(servedModel(response)).toBe("other/backup");
});

test("mid-stream failure with fallback enabled emits an error frame without retrying", async () => {
  let fallbackCalls = 0;
  const router = createRouter({
    models: [RICH_MODEL, FALLBACK_LOW_MODEL],
    policy: () => ({ model: RICH, reasoningEffort: "high" }),
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "text_delta", index: 0, delta: "partial" } as const;
              throw new Error("provider connection lost");
            },
          },
        }),
      },
      "fallback-mock": {
        execute: () => {
          fallbackCalls += 1;
          throw new Error("fallback must not run after bytes were sent");
        },
      },
    },
    fallback: { enabled: true },
  });

  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }));
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain('"content":"partial"');
  expect(body).toContain('"message":"provider connection lost"');
  expect(body).not.toContain("data: [DONE]");
  expect(fallbackCalls).toBe(0);
});

test("onError receives the normalized error and the served selection", async () => {
  const observed: Array<{ code: string; message: string; model: string }> = [];
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH, reasoningEffort: "high" }),
    executors: { mock: { execute: () => { throw new Error("upstream unavailable"); } } },
    hooks: {
      onError: (error, selection) => {
        observed.push({
          code: error.code,
          message: error.message,
          model: selection.decision.selectedModel,
        });
      },
    },
  });

  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
  }));

  expect(response.status).toBe(502);
  expect(observed).toEqual([{
    code: "executor_setup_failed",
    message: "upstream unavailable",
    model: RICH,
  }]);
});

test("Anthropic completions carry cache usage on the wire fields", async () => {
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH, reasoningEffort: "high" }),
    executors: {
      mock: {
        execute: () => ({
          type: "complete",
          output: {
            content: [{ type: "text", text: "cached answer" }],
            finishReason: "stop",
            usage: {
              inputTokens: 10,
              outputTokens: 4,
              cacheReadTokens: 90,
              cacheWriteTokens: 6,
            },
          },
        }),
      },
    },
  });

  const response = await router.fetch(jsonRequest("/v1/messages", {
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
  }));

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.usage).toEqual({
    input_tokens: 10,
    output_tokens: 4,
    cache_read_input_tokens: 90,
    cache_creation_input_tokens: 6,
  });
});

test("a rejecting LeaseStore degrades to policy-only selection", async () => {
  let getPolicyCalls = 0;
  const rejectingGet: LeaseStore = {
    get: () => Promise.reject(new Error("store get down")),
    set: () => {},
    delete: () => {},
    pruneExpired: () => Promise.reject(new Error("store prune down")),
  };
  const getRouter = createRouter({
    models: [RICH_MODEL],
    policy: () => {
      getPolicyCalls += 1;
      return { model: RICH, reasoningEffort: "high" };
    },
    executors: { mock: textExecutor("hi") },
    leaseStore: rejectingGet,
  });
  const body = { model: "my-router", messages: [{ role: "user", content: "hello" }], prompt_cache_key: "reject-store" };
  const getResponse = await getRouter.fetch(jsonRequest("/v1/chat/completions", body));
  expect(getResponse.status).toBe(200);
  expect(getPolicyCalls).toBe(1);
  const getBody = await getResponse.json();
  expect(getBody.choices[0].message.content).toBe("hi");

  let setPolicyCalls = 0;
  const rejectingSet: LeaseStore = {
    get: () => undefined,
    set: () => Promise.reject(new Error("store set down")),
    delete: () => {},
    pruneExpired: () => {},
  };
  const setRouter = createRouter({
    models: [RICH_MODEL],
    policy: () => {
      setPolicyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 3 };
    },
    executors: { mock: textExecutor("hi") },
    leaseStore: rejectingSet,
  });
  const first = await setRouter.fetch(jsonRequest("/v1/chat/completions", body));
  expect(first.status).toBe(200);
  const second = await setRouter.fetch(jsonRequest("/v1/chat/completions", body));
  expect(second.status).toBe(200);
  expect(setPolicyCalls).toBe(2);
});

test("concurrent same-cacheKey selections both succeed and leave one consistent lease", async () => {
  let policyCalls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const router = createRouter({
    models: [RICH_MODEL],
    policy: async () => {
      policyCalls += 1;
      if (policyCalls === 2) release!();
      await gate;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 3 };
    },
    executors: { mock: textExecutor("hi") },
  });

  const body = { model: "my-router", messages: [{ role: "user", content: "hello" }], prompt_cache_key: "race-key" };
  const [first, second] = await Promise.all([
    router.fetch(jsonRequest("/v1/chat/completions", body)),
    router.fetch(jsonRequest("/v1/chat/completions", body)),
  ]);

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(policyCalls).toBe(2);

  const third = await router.fetch(jsonRequest("/v1/chat/completions", body));
  expect(third.status).toBe(200);
  expect(servedModel(third)).toBe(RICH);
  expect(policyCalls).toBe(2);
});

test("wrong-method requests to known routes return 405 with Allow", async () => {
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: { mock: { execute: () => { throw new Error("must not execute"); } } },
  });

  for (const path of ["/v1/chat/completions", "/v1/messages"]) {
    const response = await router.fetch(new Request(`https://router.example${path}`, { method: "GET" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  }
});
