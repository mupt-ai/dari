import { expect, test } from "bun:test";

import {
  createRouter,
  RouterFrameworkError,
  type RouterCompletion,
  type RouterExecutor,
  type RouterExecutorInput,
  type RouterStreamEvent,
  type RoutingPolicyInput,
} from "../src/index.js";
import {
  asyncEvents,
  BASIC,
  BASIC_MODEL,
  jsonRequest,
  RICH,
  RICH_MODEL,
  textExecutor,
} from "./framework_router.fixtures.js";

test("OpenAI and Anthropic requests share policy and executor boundaries", async () => {
  const policyInputs: RoutingPolicyInput[] = [];
  const executorInputs: RouterExecutorInput[] = [];
  const router = createRouter({
    models: [RICH_MODEL],
    policy: (input) => {
      policyInputs.push(input);
      return { model: RICH, reasoningEffort: "high", reason: "test policy" };
    },
    executors: {
      mock: {
        execute(input) {
          executorInputs.push(input);
          return {
            type: "complete",
            output: {
              content: [
                { type: "text", text: `hello from ${input.request.protocol}` },
                { type: "tool_call", id: "call_1", name: "lookup", arguments: { id: 1 } },
              ],
              finishReason: "tool_calls",
              usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
            },
          };
        },
      },
    },
    generateId: () => "fixed-id",
  });

  const openAIResponse = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
  }));
  expect(openAIResponse.status).toBe(200);
  expect(openAIResponse.headers.get("X-Router-Selected-Model")).toBe(RICH);
  expect(openAIResponse.headers.get("X-Router-Reasoning-Effort")).toBe("high");
  expect(await openAIResponse.json()).toMatchObject({
    id: "chatcmpl-fixed-id",
    object: "chat.completion",
    model: RICH,
    choices: [{
      message: {
        role: "assistant",
        content: "hello from openai_chat_completions",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: "{\"id\":1}" },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    dari_routing: {
      requested_model: "my-router",
      selected_model: RICH,
      reasoning_effort: "high",
      reason: "test policy",
    },
  });

  const anthropicResponse = await router.fetch(jsonRequest("/v1/messages", {
    model: "my-router",
    max_tokens: 128,
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "lookup", input_schema: { type: "object" } }],
  }));
  expect(anthropicResponse.status).toBe(200);
  expect(await anthropicResponse.json()).toMatchObject({
    id: "msg_fixed-id",
    type: "message",
    role: "assistant",
    model: RICH,
    content: [
      { type: "text", text: "hello from anthropic_messages" },
      { type: "tool_use", id: "call_1", name: "lookup", input: { id: 1 } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 4 },
    dari_routing: {
      requested_model: "my-router",
      selected_model: RICH,
      reasoning_effort: "high",
      reason: "test policy",
    },
  });

  expect(policyInputs.map((input) => input.request.protocol)).toEqual([
    "openai_chat_completions",
    "anthropic_messages",
  ]);
  expect(executorInputs.map((input) => ({
    protocol: input.request.protocol,
    model: input.model.id,
    effort: input.decision.reasoningEffort,
  }))).toEqual([
    { protocol: "openai_chat_completions", model: RICH, effort: "high" },
    { protocol: "anthropic_messages", model: RICH, effort: "high" },
  ]);
});

test("OpenAI usage with cache tokens keeps prompt + completion equal to total", async () => {
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: () => ({
          type: "complete",
          output: {
            content: [{ type: "text", text: "cached" }],
            finishReason: "stop",
            // Upstream totals count cache fields on their own terms (here the
            // total excludes the separate cache counts). On the OpenAI wire,
            // cached tokens are part of prompt_tokens and total_tokens must
            // equal prompt_tokens + completion_tokens.
            usage: {
              inputTokens: 10,
              outputTokens: 4,
              cacheReadTokens: 90,
              cacheWriteTokens: 6,
              totalTokens: 14,
            },
          },
        }),
      },
    },
  });

  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
  }));

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.usage).toEqual({
    prompt_tokens: 106,
    completion_tokens: 4,
    total_tokens: 110,
    prompt_tokens_details: { cached_tokens: 90, cache_write_tokens: 6 },
  });
});

test("eligibility filters candidates before policy selection", async () => {
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
          type: "stream",
          events: asyncEvents([
            { type: "text_delta", index: 0, delta: "hello" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 3, outputTokens: 1 },
            },
          ]),
        }),
      },
    },
    generateId: () => "stream-id",
  });

  const response = await router.fetch(jsonRequest("/chat/completions", {
    model: "my-router",
    messages: [{
      role: "user",
      content: [{
        type: "image_url",
        image_url: { url: "https://example.com/image.png" },
      }],
    }],
    stream: true,
  }));
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(candidateIds).toEqual([RICH]);
  expect(body).toContain('"delta":{"role":"assistant"}');
  expect(body).toContain('"delta":{"content":"hello"}');
  expect(body).toContain('"finish_reason":"stop"');
  expect(body).toContain('"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}');
  expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
});

test("OpenAI streaming maps content-block indexes to tool-call indexes", async () => {
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: asyncEvents([
            { type: "text_delta", index: 0, delta: "Checking..." },
            { type: "tool_call_start", index: 1, id: "call_1", name: "lookup" },
            { type: "tool_call_delta", index: 1, delta: "{\"id\":1}" },
            { type: "tool_call_end", index: 1 },
            { type: "finish", finishReason: "tool_calls" },
          ]),
        }),
      },
    },
    generateId: () => "stream-id",
  });

  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }));
  const body = await response.text();

  expect(body).toContain('"delta":{"content":"Checking..."}');
  expect(body).toContain('"tool_calls":[{"index":0,"id":"call_1"');
  expect(body).toContain('"tool_calls":[{"index":0,"function":{"arguments":"{\\"id\\":1}"}}]');
  expect(body).toContain('"finish_reason":"tool_calls"');
  expect(body).not.toContain('"error"');
});

test("OpenAI streaming serializes hosted tool-call events as complete tool calls", async () => {
  const payload = { type: "web_search_call", id: "ws_1", status: "completed" };
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: asyncEvents([
            {
              type: "hosted_tool_call",
              index: 0,
              id: "ws_1",
              tool: "web_search",
              providerType: "web_search_call",
              status: "completed",
              payload,
            },
            { type: "tool_call_start", index: 1, id: "call_1", name: "lookup" },
            { type: "tool_call_delta", index: 1, delta: "{}" },
            { type: "tool_call_end", index: 1 },
            { type: "finish", finishReason: "tool_calls" },
          ]),
        }),
      },
    },
    generateId: () => "stream-id",
  });

  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }));
  const body = await response.text();

  expect(body).toContain(
    `"tool_calls":[{"index":0,"id":"ws_1","type":"function","function":{"name":"web_search","arguments":${JSON.stringify(JSON.stringify(payload))}}}]`,
  );
  expect(body).toContain('"tool_calls":[{"index":1,"id":"call_1"');
  expect(body).toContain('"finish_reason":"tool_calls"');
  expect(body).not.toContain('"error"');
});

test("malformed hosted tool-call stream events fail the stream contract", async () => {
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: asyncEvents([
            { type: "text_delta", index: 0, delta: "hi" },
            {
              type: "hosted_tool_call",
              index: 1,
              id: "ws_1",
              tool: "web_search",
              providerType: "web_search_call",
              payload: null,
            } as unknown as RouterStreamEvent,
            { type: "finish", finishReason: "stop" },
          ]),
        }),
      },
    },
    generateId: () => "stream-id",
  });

  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }));
  const body = await response.text();

  expect(body).toContain("Executor hosted tool calls require id, tool, providerType, and payload.");
  expect(body).toContain('"code":"stream_invalid"');
});

test("Anthropic streaming translates tool events and terminal usage", async () => {
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: asyncEvents([
            { type: "text_delta", index: 0, delta: "Checking..." },
            { type: "tool_call_start", index: 1, id: "call_1", name: "lookup" },
            { type: "tool_call_delta", index: 1, delta: "{\"id\":" },
            { type: "tool_call_delta", index: 1, delta: "1}" },
            { type: "tool_call_end", index: 1 },
            { type: "text_delta", index: 0, delta: "Done." },
            {
              type: "finish",
              finishReason: "tool_calls",
              usage: { inputTokens: 8, outputTokens: 3 },
            },
          ]),
        }),
      },
    },
    generateId: () => "stream-id",
  });

  const response = await router.fetch(jsonRequest("/messages", {
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }));
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(body).toContain("event: message_start");
  const textStop = body.indexOf('"type":"content_block_stop","index":0');
  const toolStart = body.indexOf('"type":"content_block_start","index":1');
  expect(textStop).toBeGreaterThan(0);
  expect(toolStart).toBeGreaterThan(textStop);
  expect(body).toContain('"content_block":{"type":"tool_use","id":"call_1","name":"lookup","input":{}}');
  expect(body).toContain('"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}');
  expect(body).toContain('"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"Done."}');
  expect(body).toContain('"delta":{"type":"input_json_delta","partial_json":"{\\"id\\":"}');
  expect(body).toContain('"stop_reason":"tool_use"');
  expect(body).toContain('"usage":{"input_tokens":8,"output_tokens":3}');
  expect(body.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true);
});

test("Anthropic streaming serializes overlapping tool calls into sequential blocks", async () => {
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: asyncEvents([
            { type: "tool_call_start", index: 3, id: "call_1", name: "first" },
            { type: "tool_call_start", index: 7, id: "call_2", name: "second" },
            { type: "tool_call_delta", index: 7, delta: "{\"second\":true}" },
            { type: "tool_call_delta", index: 3, delta: "{\"first\":true}" },
            { type: "tool_call_end", index: 7 },
            { type: "tool_call_end", index: 3 },
            { type: "finish", finishReason: "tool_calls" },
          ]),
        }),
      },
    },
  });

  const response = await router.fetch(jsonRequest("/v1/messages", {
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "call both" }],
    stream: true,
  }));
  const body = await response.text();
  const firstStop = body.indexOf('"type":"content_block_stop","index":0');
  const secondStart = body.indexOf('"type":"content_block_start","index":1');

  expect(response.status).toBe(200);
  expect(body).not.toContain('event: error');
  expect(body).toContain('"id":"call_1","name":"first"');
  expect(body).toContain('"id":"call_2","name":"second"');
  expect(secondStart).toBeGreaterThan(firstStop);
  expect(body.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true);
});

test("Anthropic streaming preserves queued tool calls that reuse an ended index", async () => {
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: asyncEvents([
            { type: "tool_call_start", index: 3, id: "active", name: "active" },
            { type: "tool_call_start", index: 7, id: "call_1", name: "first" },
            { type: "tool_call_delta", index: 7, delta: "{\"first\":true}" },
            { type: "tool_call_end", index: 7 },
            { type: "tool_call_start", index: 7, id: "call_2", name: "second" },
            { type: "tool_call_delta", index: 7, delta: "{\"second\":true}" },
            { type: "tool_call_end", index: 7 },
            { type: "tool_call_end", index: 3 },
            { type: "finish", finishReason: "tool_calls" },
          ]),
        }),
      },
    },
  });

  const response = await router.fetch(jsonRequest("/v1/messages", {
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "call all" }],
    stream: true,
  }));
  const body = await response.text();
  const firstStart = body.indexOf('"id":"call_1","name":"first"');
  const secondStart = body.indexOf('"id":"call_2","name":"second"');

  expect(response.status).toBe(200);
  expect(body).not.toContain("event: error");
  expect(firstStart).toBeGreaterThan(0);
  expect(secondStart).toBeGreaterThan(firstStart);
  expect(body).toContain('"partial_json":"{\\"first\\":true}"');
  expect(body).toContain('"partial_json":"{\\"second\\":true}"');
  expect(body.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true);
});

test("models use the explicit default executor without Pi-specific wiring", async () => {
  const calls: string[] = [];
  const router = createRouter({
    models: [{ ...BASIC_MODEL, executor: undefined }],
    executor: {
      execute: () => {
        calls.push("default");
        return { type: "complete", output: { content: [{ type: "text", text: "ok" }], finishReason: "stop" } };
      },
    },
    policy: () => ({ model: BASIC }),
  });
  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
  }));
  expect(response.status).toBe(200);
  expect(calls).toEqual(["default"]);
});

test("models without an executor require a default executor", () => {
  expect(() => createRouter({
    models: [{ ...BASIC_MODEL, executor: undefined }],
    policy: () => ({ model: BASIC }),
    executors: {},
  })).toThrow("no default executor was supplied");
});

test("the internal default executor name cannot collide with named executors", () => {
  expect(() => createRouter({
    models: [{ ...BASIC_MODEL, executor: undefined }],
    executor: textExecutor("default"),
    executors: { default: textExecutor("named") },
    policy: () => ({ model: BASIC }),
  })).toThrow("executors cannot use the reserved name 'default'");
});

test("configuration, eligibility, policy, and executor failures are explicit", async () => {
  expect(() => createRouter({
    models: [],
    policy: () => ({ model: BASIC }),
    executors: {},
  })).toThrow(RouterFrameworkError);

  const noEligible = createRouter({
    models: [BASIC_MODEL],
    policy: () => ({ model: BASIC }),
    executors: { mock: { execute: () => { throw new Error("must not execute"); } } },
  });
  const noEligibleResponse = await noEligible.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    response_format: { type: "json_object" },
  }));
  expect(noEligibleResponse.status).toBe(400);
  expect(await noEligibleResponse.json()).toMatchObject({
    error: { code: "no_eligible_models", type: "invalid_request_error" },
  });

  const invalidPolicy = createRouter({
    models: [BASIC_MODEL],
    policy: () => ({ model: "missing/model" }),
    executors: { mock: { execute: () => { throw new Error("must not execute"); } } },
  });
  const policyResponse = await invalidPolicy.fetch(jsonRequest("/v1/messages", {
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
  }));
  expect(policyResponse.status).toBe(502);
  expect(await policyResponse.json()).toMatchObject({
    type: "error",
    error: { type: "api_error", message: "Routing policy selected unconfigured or ineligible model 'missing/model'." },
  });

  const failedExecutor = createRouter({
    models: [BASIC_MODEL],
    policy: () => ({ model: BASIC }),
    executors: { mock: { execute: () => { throw new Error("upstream unavailable"); } } },
  });
  const executorResponse = await failedExecutor.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
  }));
  expect(executorResponse.status).toBe(502);
  expect(await executorResponse.json()).toMatchObject({
    error: { code: "executor_setup_failed", message: "upstream unavailable" },
  });

  const notFoundResponse = await failedExecutor.fetch(jsonRequest("/v1/responses", {}));
  expect(notFoundResponse.status).toBe(404);
});

test("empty and pre-output failed streams return normal HTTP errors", async () => {
  const emptyExecutor: RouterExecutor = {
    execute: () => ({
      type: "stream",
      events: asyncEvents([]),
    }),
  };
  const emptyRouter = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: { mock: emptyExecutor },
  });
  const emptyResponse = await emptyRouter.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }));
  expect(emptyResponse.status).toBe(502);
  expect(await emptyResponse.json()).toMatchObject({ error: { code: "stream_empty" } });

  const failedRouter = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: {
            async *[Symbol.asyncIterator]() {
              throw new Error("stream connection failed");
            },
          },
        }),
      },
    },
  });
  const failedResponse = await failedRouter.fetch(jsonRequest("/v1/messages", {
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }));
  expect(failedResponse.status).toBe(502);
  expect(await failedResponse.json()).toMatchObject({
    error: { type: "api_error", message: "stream connection failed" },
  });
});

test("finish-only streams represent successful empty assistant replies", async () => {
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: asyncEvents([{
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 4, outputTokens: 0 },
          }]),
        }),
      },
    },
  });

  const openAIResponse = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }));
  const openAIBody = await openAIResponse.text();
  expect(openAIResponse.status).toBe(200);
  expect(openAIBody).toContain('"finish_reason":"stop"');
  expect(openAIBody.endsWith("data: [DONE]\n\n")).toBe(true);

  const anthropicResponse = await router.fetch(jsonRequest("/v1/messages", {
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }));
  const anthropicBody = await anthropicResponse.text();
  expect(anthropicResponse.status).toBe(200);
  expect(anthropicBody).toContain('"stop_reason":"end_turn"');
  expect(anthropicBody).not.toContain("content_block_start");
  expect(anthropicBody.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true);
});

test("invalid first stream events return HTTP errors and close the iterator", async () => {
  const firstEvents: RouterStreamEvent[] = [
    { type: "text_delta", index: 0, delta: "" },
    { type: "tool_call_delta", index: 0, delta: "{}" },
    {
      type: "tool_call_start",
      index: 0,
      id: 42,
      name: "lookup",
    } as unknown as RouterStreamEvent,
  ];
  for (const firstEvent of firstEvents) {
    let iteratorClosed = false;
    const router = createRouter({
      models: [RICH_MODEL],
      policy: () => ({ model: RICH }),
      executors: {
        mock: {
          execute: () => ({
            type: "stream",
            events: {
              async *[Symbol.asyncIterator]() {
                try {
                  yield firstEvent;
                } finally {
                  iteratorClosed = true;
                }
              },
            },
          }),
        },
      },
    });

    const response = await router.fetch(jsonRequest("/v1/chat/completions", {
      model: "my-router",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }));

    expect(response.status).toBe(502);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(iteratorClosed).toBe(true);
  }
});

test("request-body cancellation is not reported as invalid JSON", async () => {
  const requestController = new AbortController();
  let policyCalled = false;
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => {
      policyCalled = true;
      return { model: RICH };
    },
    executors: {
      mock: {
        execute: () => {
          throw new Error("executor must not run");
        },
      },
    },
  });
  const request = jsonRequest("/v1/chat/completions", {}, requestController.signal);
  Object.defineProperty(request, "json", {
    value: async () => {
      requestController.abort("client disconnected");
      throw new DOMException("body read aborted", "AbortError");
    },
  });

  const response = await router.fetch(request);

  expect(response.status).toBe(499);
  expect(await response.json()).toMatchObject({
    error: { code: "request_cancelled" },
  });
  expect(policyCalled).toBe(false);
});

test("early stream setup failures close the executor iterator", async () => {
  const requestController = new AbortController();
  let abortedIteratorClosed = false;
  let abortedIteratorRead = false;
  const abortedRouter = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: () => {
          requestController.abort("client disconnected");
          return {
            type: "stream",
            events: {
              [Symbol.asyncIterator]() {
                return {
                  async next() {
                    abortedIteratorRead = true;
                    return { done: false as const, value: { type: "text_delta" as const, index: 0, delta: "hello" } };
                  },
                  async return() {
                    abortedIteratorClosed = true;
                    return { done: true as const, value: undefined };
                  },
                };
              },
            },
          };
        },
      },
    },
  });

  const abortedResponse = await abortedRouter.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }, requestController.signal));
  expect(abortedResponse.status).toBe(499);
  expect(abortedIteratorRead).toBe(false);
  expect(abortedIteratorClosed).toBe(true);

  let idFailureIteratorClosed = false;
  const idFailureRouter = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  return { done: false as const, value: { type: "text_delta" as const, index: 0, delta: "hello" } };
                },
                async return() {
                  idFailureIteratorClosed = true;
                  return { done: true as const, value: undefined };
                },
              };
            },
          },
        }),
      },
    },
    generateId: () => "",
  });

  const idFailureResponse = await idFailureRouter.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }));
  expect(idFailureResponse.status).toBe(500);
  expect(await idFailureResponse.json()).toMatchObject({
    error: { code: "id_generator_invalid" },
  });
  expect(idFailureIteratorClosed).toBe(true);
});

test("request cancellation remains connected for the lifetime of a stream", async () => {
  const requestController = new AbortController();
  let executorSignal: AbortSignal | undefined;
  let iteratorClosed = false;
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: (input) => {
          executorSignal = input.signal;
          return {
            type: "stream",
            events: {
              async *[Symbol.asyncIterator]() {
                try {
                  yield { type: "text_delta", index: 0, delta: "hello" } as const;
                  await new Promise<void>((resolve) => {
                    if (input.signal.aborted) resolve();
                    else input.signal.addEventListener("abort", () => resolve(), { once: true });
                  });
                } finally {
                  iteratorClosed = true;
                }
              },
            },
          };
        },
      },
    },
  });

  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }, requestController.signal));
  expect(response.status).toBe(200);
  const bodyPromise = response.text();
  requestController.abort("client disconnected");
  const body = await bodyPromise;

  expect(executorSignal?.aborted).toBe(true);
  expect(body).not.toContain("data: [DONE]");
  expect(iteratorClosed).toBe(true);
});

test("completion validation rejects malformed content and usage", async () => {
  const outputs = [
    {
      content: [{ type: "text", text: "hello" }],
      finishReason: "stop",
      usage: { inputTokens: 1.5, outputTokens: 1 },
    },
    {
      content: [null],
      finishReason: "stop",
    },
    {
      content: [{ type: "text", text: "hello" }],
      finishReason: "invalid",
    },
  ] as unknown as RouterCompletion[];

  for (const output of outputs) {
    const router = createRouter({
      models: [BASIC_MODEL],
      policy: () => ({ model: BASIC }),
      executors: {
        mock: {
          execute: () => ({ type: "complete", output }),
        },
      },
    });
    const response = await router.fetch(jsonRequest("/v1/chat/completions", {
      model: "my-router",
      messages: [{ role: "user", content: "hello" }],
    }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "executor_output_invalid" },
    });
  }
});
