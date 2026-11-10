import { expect, test } from "bun:test";

import {
  createRouter,
  type RouterStreamEvent,
} from "../src/index.js";
import {
  asyncEvents,
  BASIC,
  BASIC_MODEL,
  FALLBACK_LOW_MODEL,
  FALLBACK_MODEL,
  jsonRequest,
  RICH,
  RICH_MODEL,
  servedModel,
  textExecutor,
} from "./framework_router.fixtures.js";

test("fallback success dissolves the lease pinning the failing primary", async () => {
  let policyCalls = 0;
  const router = createRouter({
    models: [RICH_MODEL, FALLBACK_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 5 };
    },
    executors: {
      mock: { execute: () => { throw new Error("primary down"); } },
      "fallback-mock": {
        execute: () => ({ type: "complete", output: { content: [{ type: "text", text: "fallback" }], finishReason: "stop" } }),
      },
    },
    fallback: { enabled: true },
  });

  const body = { model: "my-router", messages: [{ role: "user", content: "hello" }], prompt_cache_key: "lease-fallback" };
  const first = await router.fetch(jsonRequest("/v1/chat/completions", body));
  expect(first.status).toBe(200);
  expect(servedModel(first)).toBe("fallback/model");
  expect(policyCalls).toBe(1);

  // The lease pinned the failing primary; fallback success removed it, so
  // the next turn selects fresh instead of failing into fallback again.
  const second = await router.fetch(jsonRequest("/v1/chat/completions", body));
  expect(second.status).toBe(200);
  expect(policyCalls).toBe(2);
});

test("failed serves with fallback disabled drop the lease", async () => {
  let policyCalls = 0;
  let executorCalls = 0;
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 5 };
    },
    executors: {
      mock: {
        execute: () => {
          executorCalls += 1;
          if (executorCalls === 1) throw new Error("primary down");
          return {
            type: "complete",
            output: { content: [{ type: "text", text: "recovered" }], finishReason: "stop" },
          };
        },
      },
    },
  });

  const body = {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    prompt_cache_key: "lease-failed-serve",
  };
  const first = await router.fetch(jsonRequest("/v1/chat/completions", body));
  expect(first.status).toBe(502);
  expect(await first.json()).toMatchObject({
    error: { code: "executor_setup_failed", message: "primary down" },
  });
  expect(policyCalls).toBe(1);

  // The failed serve dropped the lease, so the next turn with the same
  // cacheKey re-consults the policy instead of short-circuiting back to the
  // model that just failed.
  const second = await router.fetch(jsonRequest("/v1/chat/completions", body));
  expect(second.status).toBe(200);
  expect(policyCalls).toBe(2);
});

test("cancellation during stream priming keeps the lease", async () => {
  let policyCalls = 0;
  let executorCalls = 0;
  const requestController = new AbortController();
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 5 };
    },
    executors: {
      mock: {
        execute: () => {
          executorCalls += 1;
          if (executorCalls === 1) {
            return {
              type: "stream",
              events: {
                [Symbol.asyncIterator]() {
                  return {
                    async next(): Promise<IteratorResult<RouterStreamEvent>> {
                      requestController.abort("client disconnected");
                      throw new Error("socket closed");
                    },
                  };
                },
              },
            };
          }
          return {
            type: "complete",
            output: { content: [{ type: "text", text: "hi again" }], finishReason: "stop" },
          };
        },
      },
    },
  });

  const streamBody = {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    prompt_cache_key: "lease-cancelled-prime",
    stream: true,
  };
  const first = await router.fetch(
    jsonRequest("/v1/chat/completions", streamBody, requestController.signal),
  );
  expect(first.status).toBe(499);
  expect(await first.json()).toMatchObject({ error: { code: "request_cancelled" } });
  expect(policyCalls).toBe(1);

  // The user aborted; the model did not fail, so the lease survives and the
  // next turn short-circuits to it without re-consulting the policy.
  const second = await router.fetch(jsonRequest("/v1/chat/completions", {
    ...streamBody,
    stream: false,
  }));
  expect(second.status).toBe(200);
  expect(servedModel(second)).toBe(RICH);
  expect(policyCalls).toBe(1);
});

test("mid-stream failure of a leased model drops the lease", async () => {
  let policyCalls = 0;
  let executorCalls = 0;
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 5 };
    },
    executors: {
      mock: {
        execute: () => {
          executorCalls += 1;
          if (executorCalls === 1) {
            return {
              type: "stream",
              events: {
                async *[Symbol.asyncIterator]() {
                  yield { type: "text_delta", index: 0, delta: "partial" } as const;
                  throw new Error("provider connection lost");
                },
              },
            };
          }
          return {
            type: "complete",
            output: { content: [{ type: "text", text: "recovered" }], finishReason: "stop" },
          };
        },
      },
    },
  });

  const body = {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    prompt_cache_key: "lease-mid-stream-failure",
  };
  const first = await router.fetch(
    jsonRequest("/v1/chat/completions", { ...body, stream: true }),
  );
  const firstBody = await first.text();
  expect(first.status).toBe(200);
  expect(firstBody).toContain('"content":"partial"');
  expect(firstBody).toContain('"message":"provider connection lost"');
  expect(firstBody).not.toContain("data: [DONE]");
  expect(policyCalls).toBe(1);

  // The model failed mid-response, so the lease is gone: the next turn with
  // the same cacheKey re-consults the policy instead of short-circuiting
  // back to the model that just failed.
  const second = await router.fetch(jsonRequest("/v1/chat/completions", body));
  expect(second.status).toBe(200);
  expect(policyCalls).toBe(2);
});

test("reader cancellation mid-stream keeps the lease", async () => {
  let policyCalls = 0;
  let executorCalls = 0;
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 5 };
    },
    executors: {
      mock: {
        execute: () => {
          executorCalls += 1;
          if (executorCalls === 1) {
            return {
              type: "stream",
              events: {
                async *[Symbol.asyncIterator]() {
                  yield { type: "text_delta", index: 0, delta: "hello" } as const;
                  yield { type: "text_delta", index: 0, delta: " world" } as const;
                  yield { type: "finish", finishReason: "stop" } as const;
                },
              },
            };
          }
          return {
            type: "complete",
            output: { content: [{ type: "text", text: "hi again" }], finishReason: "stop" },
          };
        },
      },
    },
  });

  const body = {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    prompt_cache_key: "lease-reader-cancel",
  };
  const first = await router.fetch(
    jsonRequest("/v1/chat/completions", { ...body, stream: true }),
  );
  const reader = first.body!.getReader();
  await reader.read();
  await reader.cancel("client went away");
  expect(policyCalls).toBe(1);

  // The reader walked away; the model did not fail, so the lease survives
  // and the next turn short-circuits to it without re-consulting the policy.
  const second = await router.fetch(jsonRequest("/v1/chat/completions", body));
  expect(second.status).toBe(200);
  expect(servedModel(second)).toBe(RICH);
  expect(policyCalls).toBe(1);
});

test("leases dissolve when the leased model is no longer a candidate", async () => {
  let policyCalls = 0;
  const router = createRouter({
    models: [BASIC_MODEL, RICH_MODEL],
    policy: ({ candidates }) => {
      policyCalls += 1;
      return {
        model: candidates.some((candidate) => candidate.id === BASIC) ? BASIC : RICH,
        leaseTurnsRemaining: 5,
      };
    },
    executors: { mock: textExecutor("hi") },
  });

  const textBody = { model: "my-router", messages: [{ role: "user", content: "hello" }], prompt_cache_key: "conv-image" };
  const first = await router.fetch(jsonRequest("/v1/chat/completions", textBody));
  expect(servedModel(first)).toBe(BASIC);
  expect(policyCalls).toBe(1);

  // The next turn adds an image, which BASIC cannot serve: the lease must
  // dissolve and the policy must run against the new candidate set.
  const imageBody = {
    model: "my-router",
    messages: [{
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }],
    }],
    prompt_cache_key: "conv-image",
  };
  const second = await router.fetch(jsonRequest("/v1/chat/completions", imageBody));
  expect(servedModel(second)).toBe(RICH);
  expect(policyCalls).toBe(2);
});

test("fallback serves streamed responses and reports its own model and effort", async () => {
  let fallbackEffort: string | undefined;
  const streamCloseDecisions: unknown[] = [];
  const router = createRouter({
    models: [RICH_MODEL, FALLBACK_LOW_MODEL],
    policy: () => ({
      model: RICH,
      reasoningEffort: "high",
      reason: "primary is best",
      leaseTurnsRemaining: 2,
    }),
    executors: {
      mock: { execute: () => { throw new Error("primary down"); } },
      "fallback-mock": {
        execute: (input) => {
          fallbackEffort = input.decision.reasoningEffort;
          return {
            type: "stream",
            events: asyncEvents([
              { type: "text_delta", index: 0, delta: "fallback stream" },
              { type: "finish", finishReason: "stop" },
            ]),
          };
        },
      },
    },
    fallback: { enabled: true },
    hooks: {
      onStreamClose: (_completion, selection) => {
        streamCloseDecisions.push(selection.decision);
      },
    },
  });

  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    prompt_cache_key: "honest-fallback-stream",
    stream: true,
  }));
  const body = await response.text();

  expect(response.status).toBe(200);
  // The fallback model does not support the decision's "high" effort, so it
  // runs at its own default.
  expect(fallbackEffort).toBe("low");
  expect(response.headers.get("X-Router-Selected-Model")).toBe("fallback/model");
  expect(response.headers.get("X-Router-Reasoning-Effort")).toBe("low");
  expect(body).toContain('"content":"fallback stream"');
  expect(body).toContain('"selected_model":"fallback/model"');
  expect(body).toContain(
    JSON.stringify("Fell back to 'fallback/model' after executor for 'rich/model' failed. Original reason: primary is best"),
  );
  expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
  // onStreamClose observes the served selection with no leaseTurnsRemaining —
  // the primary's lease was released when its executor failed.
  expect(streamCloseDecisions).toEqual([{
    selectedModel: "fallback/model",
    reasoningEffort: "low",
    reason: "Fell back to 'fallback/model' after executor for 'rich/model' failed. Original reason: primary is best",
  }]);
});

test("streaming fallback retries when the primary stream fails priming", async () => {
  let policyCalls = 0;
  let primaryIteratorClosed = false;
  const router = createRouter({
    models: [RICH_MODEL, FALLBACK_LOW_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 5 };
    },
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: {
            [Symbol.asyncIterator]() {
              return {
                async next(): Promise<IteratorResult<RouterStreamEvent>> {
                  throw new Error("provider connection failed");
                },
                async return(): Promise<IteratorResult<RouterStreamEvent>> {
                  primaryIteratorClosed = true;
                  return { done: true, value: undefined };
                },
              };
            },
          },
        }),
      },
      "fallback-mock": {
        execute: () => ({
          type: "stream",
          events: asyncEvents([
            { type: "text_delta", index: 0, delta: "fallback stream" },
            { type: "finish", finishReason: "stop" },
          ]),
        }),
      },
    },
    fallback: { enabled: true },
  });

  const body = {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    prompt_cache_key: "lease-prime-fallback",
    stream: true,
  };
  const response = await router.fetch(jsonRequest("/v1/chat/completions", body));
  const text = await response.text();

  expect(response.status).toBe(200);
  expect(primaryIteratorClosed).toBe(true);
  expect(response.headers.get("X-Router-Selected-Model")).toBe("fallback/model");
  expect(response.headers.get("X-Router-Reasoning-Effort")).toBe("low");
  expect(text).toContain('"content":"fallback stream"');
  expect(text).toContain('"selected_model":"fallback/model"');
  expect(text.endsWith("data: [DONE]\n\n")).toBe(true);

  // The lease pinned the failing primary; the prime-failure fallback dropped
  // it, so the next turn selects fresh instead of skipping the policy.
  const second = await router.fetch(jsonRequest("/v1/chat/completions", body));
  expect(second.status).toBe(200);
  expect(policyCalls).toBe(2);
});

test("cancellation during stream priming maps to request_cancelled without fallback", async () => {
  const requestController = new AbortController();
  let fallbackCalls = 0;
  const router = createRouter({
    models: [RICH_MODEL, FALLBACK_LOW_MODEL],
    policy: () => ({ model: RICH, reasoningEffort: "high" }),
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: {
            [Symbol.asyncIterator]() {
              return {
                async next(): Promise<IteratorResult<RouterStreamEvent>> {
                  requestController.abort("client disconnected");
                  throw new Error("socket closed");
                },
              };
            },
          },
        }),
      },
      "fallback-mock": {
        execute: () => {
          fallbackCalls += 1;
          throw new Error("fallback must not run");
        },
      },
    },
    fallback: { enabled: true },
  });

  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }, requestController.signal));

  expect(response.status).toBe(499);
  expect(await response.json()).toMatchObject({ error: { code: "request_cancelled" } });
  expect(fallbackCalls).toBe(0);
});

test("prime failures without fallback surface the provider error unchanged", async () => {
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: {
            async *[Symbol.asyncIterator]() {
              throw new Error("provider connection failed");
            },
          },
        }),
      },
    },
    fallback: { enabled: false },
  });

  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }));

  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({
    error: { code: "stream_setup_failed", message: "provider connection failed" },
  });
});

test("mode-mismatched leased primary retries the fallback and reports its model", async () => {
  let policyCalls = 0;
  const router = createRouter({
    models: [RICH_MODEL, FALLBACK_LOW_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 5 };
    },
    executors: {
      mock: {
        // Contract violation: a complete result for a streaming request.
        execute: () => ({
          type: "complete",
          output: { content: [{ type: "text", text: "wrong mode" }], finishReason: "stop" },
        }),
      },
      "fallback-mock": {
        execute: () => ({
          type: "stream",
          events: asyncEvents([
            { type: "text_delta", index: 0, delta: "fallback stream" },
            { type: "finish", finishReason: "stop" },
          ]),
        }),
      },
    },
    fallback: { enabled: true },
  });

  const body = {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    prompt_cache_key: "lease-mode-mismatch-fallback",
    stream: true,
  };
  const response = await router.fetch(jsonRequest("/v1/chat/completions", body));
  const text = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get("X-Router-Selected-Model")).toBe("fallback/model");
  expect(text).toContain('"content":"fallback stream"');
  expect(text).toContain('"selected_model":"fallback/model"');
  expect(text.endsWith("data: [DONE]\n\n")).toBe(true);

  // The contract-violating primary lost its lease, so the next same-cacheKey
  // turn re-consults the policy instead of short-circuiting to it.
  const second = await router.fetch(jsonRequest("/v1/chat/completions", body));
  expect(second.status).toBe(200);
  expect(policyCalls).toBe(2);
});

test("mode-mismatched leased primary without fallback surfaces the error and drops the lease", async () => {
  let policyCalls = 0;
  let executorCalls = 0;
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 5 };
    },
    executors: {
      mock: {
        execute: () => {
          executorCalls += 1;
          if (executorCalls === 1) {
            // Contract violation: a complete result for a streaming request.
            return {
              type: "complete",
              output: { content: [{ type: "text", text: "wrong mode" }], finishReason: "stop" },
            };
          }
          return {
            type: "stream",
            events: asyncEvents([
              { type: "text_delta", index: 0, delta: "recovered" },
              { type: "finish", finishReason: "stop" },
            ]),
          };
        },
      },
    },
  });

  const body = {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    prompt_cache_key: "lease-mode-mismatch",
    stream: true,
  };
  const first = await router.fetch(jsonRequest("/v1/chat/completions", body));
  expect(first.status).toBe(502);
  expect(await first.json()).toMatchObject({ error: { code: "executor_mode_mismatch" } });
  expect(policyCalls).toBe(1);

  // The lease died with the contract failure: the next same-cacheKey turn
  // re-consults the policy instead of short-circuiting to the broken primary.
  const second = await router.fetch(jsonRequest("/v1/chat/completions", body));
  expect(second.status).toBe(200);
  expect(policyCalls).toBe(2);
});

test("aborts during the fallback attempt still drop the failed primary's lease", async () => {
  const requestController = new AbortController();
  let policyCalls = 0;
  let primaryCalls = 0;
  const router = createRouter({
    models: [RICH_MODEL, FALLBACK_LOW_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 5 };
    },
    executors: {
      mock: {
        execute: () => {
          primaryCalls += 1;
          if (primaryCalls === 1) throw new Error("primary down");
          return {
            type: "complete",
            output: { content: [{ type: "text", text: "recovered" }], finishReason: "stop" },
          };
        },
      },
      "fallback-mock": {
        // Hangs until the abort arrives mid-fallback, then fails with it.
        execute: (input) =>
          new Promise((_, reject) => {
            input.signal.addEventListener(
              "abort",
              () => reject(new Error("fallback aborted")),
              { once: true },
            );
            requestController.abort("client disconnected");
          }),
      },
    },
    fallback: { enabled: true },
  });

  const body = {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    prompt_cache_key: "lease-abort-mid-fallback",
  };
  const first = await router.fetch(
    jsonRequest("/v1/chat/completions", body, requestController.signal),
  );
  expect(first.status).toBe(499);
  expect(await first.json()).toMatchObject({ error: { code: "request_cancelled" } });
  expect(policyCalls).toBe(1);

  // The primary's non-cancelled failure dropped the lease before the
  // fallback attempt, so the abort mid-fallback cannot resurrect it: the
  // next same-cacheKey turn re-consults the policy.
  const second = await router.fetch(jsonRequest("/v1/chat/completions", body));
  expect(second.status).toBe(200);
  expect(servedModel(second)).toBe(RICH);
  expect(policyCalls).toBe(2);
});
