import { expect, test } from "bun:test";

import { openAIChatRequest } from "../src/protocol_openai_chat.js";
import { anthropicRequest } from "../src/protocol_anthropic.js";
import {
  createRouter,
  type LeaseStore,
  type RouterLease,
} from "../src/index.js";
import {
  asyncEvents,
  BASIC_MODEL,
  FALLBACK_MODEL,
  jsonRequest,
  RICH,
  RICH_MODEL,
  servedModel,
  textExecutor,
} from "./framework_router.fixtures.js";

// A conversation body after `turns` completed assistant turns.
function turnBody(turns: number, cacheKey: string): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [{ role: "user", content: "hello" }];
  for (let turn = 1; turn <= turns; turn += 1) {
    messages.push({ role: "assistant", content: `reply ${turn}` }, { role: "user", content: `follow-up ${turn}` });
  }
  return { model: "my-router", messages, prompt_cache_key: cacheKey };
}

test("lease short-circuit serves the same model without calling the policy", async () => {
  let policyCalls = 0;
  const router = createRouter({
    models: [RICH_MODEL, BASIC_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 2 };
    },
    executors: { mock: textExecutor("hi") },
  });

  // Turn 1: policy is called and commits a 2-turn lease.
  const first = await router.fetch(jsonRequest("/v1/chat/completions", turnBody(0, "conversation-1")));
  expect(policyCalls).toBe(1);
  expect(servedModel(first)).toBe(RICH);

  // Turn 2: lease short-circuits, policy is NOT called.
  const second = await router.fetch(jsonRequest("/v1/chat/completions", turnBody(1, "conversation-1")));
  expect(policyCalls).toBe(1);
  expect(servedModel(second)).toBe(RICH);

  // Turn 3: the lease's final turn.
  const third = await router.fetch(jsonRequest("/v1/chat/completions", turnBody(2, "conversation-1")));
  expect(policyCalls).toBe(1);
  expect(servedModel(third)).toBe(RICH);

  // Turn 4: past the lease, policy is called again.
  const fourth = await router.fetch(jsonRequest("/v1/chat/completions", turnBody(3, "conversation-1")));
  expect(policyCalls).toBe(2);
  expect(servedModel(fourth)).toBe(RICH);
});

test("leases hold by conversation turn, not by request count", async () => {
  let policyCalls = 0;
  const selections: string[] = [];
  const router = createRouter({
    models: [RICH_MODEL, BASIC_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 2 };
    },
    executors: { mock: textExecutor("hi") },
    hooks: { onSelection: (selection) => { selections.push(selection.source); } },
  });
  const select = (turns: number) => router.select(openAIChatRequest(turnBody(turns, "positions")));

  // First seen mid-conversation: the lease holds relative to turn 5.
  await select(5);
  // Retries of a turn do not use it up.
  await select(6);
  await select(6);
  await select(6);
  expect((await select(7)).decision.leaseTurnsRemaining).toBeUndefined();
  expect(policyCalls).toBe(1);
  // Past the lease, and a shorter (edited) history, both select again.
  await select(8);
  expect(policyCalls).toBe(2);
  await select(3);
  expect(policyCalls).toBe(3);
  expect(selections).toEqual([
    "policy",
    "lease_hold",
    "lease_hold",
    "lease_hold",
    "lease_hold",
    "policy",
    "policy",
  ]);
});

test("select is the same lease-aware selection primitive used by fetch", async () => {
  let policyCalls = 0;
  const selectedReasons: string[] = [];
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 5 };
    },
    executors: { mock: textExecutor("hi") },
    hooks: {
      onSelection: (selection) => {
        selectedReasons.push(selection.decision.reason);
      },
    },
  });

  const body = { model: "my-router", messages: [{ role: "user", content: "hello" }], prompt_cache_key: "conv-select" };
  const request = { ...openAIChatRequest(body), stream: false };

  await router.select(request);
  await router.select(request);
  const response = await router.fetch(jsonRequest("/v1/chat/completions", body));

  expect(policyCalls).toBe(1);
  expect(selectedReasons).toHaveLength(3);
  expect(selectedReasons.slice(1).every((reason) => reason.startsWith("Serving committed lease"))).toBe(true);
  expect(servedModel(response)).toBe(RICH);
});

test("evaluatePolicy inspects policy without leases or hooks", async () => {
  let policyCalls = 0;
  let hookCalls = 0;
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 5 };
    },
    executors: { mock: textExecutor("hi") },
    hooks: { onSelection: () => { hookCalls += 1; } },
  });

  const body = { model: "my-router", messages: [{ role: "user", content: "hello" }], prompt_cache_key: "conv-inspect" };
  const request = { ...openAIChatRequest(body), stream: false };

  await router.evaluatePolicy(request);
  await router.evaluatePolicy(request);
  await router.fetch(jsonRequest("/v1/chat/completions", body));

  expect(policyCalls).toBe(3);
  expect(hookCalls).toBe(1);
});

test("lease is not applied without a cacheKey", async () => {
  let policyCalls = 0;
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 5 };
    },
    executors: { mock: textExecutor("hi") },
  });

  const body = { model: "my-router", messages: [{ role: "user", content: "hello" }] };

  await router.fetch(jsonRequest("/v1/chat/completions", body));
  await router.fetch(jsonRequest("/v1/chat/completions", body));
  expect(policyCalls).toBe(2);
});

test("abandoned leases expire after the TTL", async () => {
  let policyCalls = 0;
  const now = Date.now();
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 5 };
    },
    executors: { mock: textExecutor("hi") },
  });

  const body = { model: "my-router", messages: [{ role: "user", content: "hello" }], prompt_cache_key: "conv-expiry" };

  // Commit a lease via a real request.
  await router.fetch(jsonRequest("/v1/chat/completions", body));
  expect(policyCalls).toBe(1);

  // Simulate time passing beyond the 30-minute TTL.
  const originalNow = Date.now;
  (globalThis as { Date: { now: () => number } }).Date.now = () => now + 31 * 60_000;

  try {
    // The next request with the same cacheKey sees the lease expired and
    // calls the policy again.
    await router.fetch(jsonRequest("/v1/chat/completions", body));
    expect(policyCalls).toBe(2);
  } finally {
    (globalThis as { Date: { now: () => number } }).Date.now = originalNow;
  }
});

test("active lease refreshes its TTL on each served turn", async () => {
  let policyCalls = 0;
  const start = Date.now();
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 5 };
    },
    executors: { mock: textExecutor("hi") },
  });

  const body = { model: "my-router", messages: [{ role: "user", content: "hello" }], prompt_cache_key: "conv-refresh" };

  // Commit a lease at t=0.
  await router.fetch(jsonRequest("/v1/chat/completions", body));
  expect(policyCalls).toBe(1);

  // Advance 20 minutes (within the 30-minute TTL) and serve a turn, which
  // should refresh the lease's expiry to now + 30 minutes.
  const originalNow = Date.now;
  (globalThis as { Date: { now: () => number } }).Date.now = () => start + 20 * 60_000;
  try {
    await router.fetch(jsonRequest("/v1/chat/completions", body));
    expect(policyCalls).toBe(1);
  } finally {
    (globalThis as { Date: { now: () => number } }).Date.now = originalNow;
  }

  // Advance to 45 minutes from start. The lease was refreshed at 20m to
  // expire at 50m, so it must still hold (no policy call). Without the
  // refresh, a 30-minute TTL from t=0 would have expired at t=45m.
  (globalThis as { Date: { now: () => number } }).Date.now = () => start + 45 * 60_000;
  try {
    await router.fetch(jsonRequest("/v1/chat/completions", body));
    expect(policyCalls).toBe(1);
  } finally {
    (globalThis as { Date: { now: () => number } }).Date.now = originalNow;
  }
});

test("custom LeaseStore is used instead of the in-memory default", async () => {
  let policyCalls = 0;
  const leases = new Map<string, RouterLease>();
  const store: LeaseStore = {
    get: (key) => leases.get(key),
    set: (key, lease) => {
      leases.set(key, lease);
    },
    delete: (key) => {
      leases.delete(key);
    },
    pruneExpired: (nowMs) => {
      for (const [key, lease] of leases) {
        if (lease.expiresAt <= nowMs) leases.delete(key);
      }
    },
  };
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 3 };
    },
    executors: { mock: textExecutor("hi") },
    leaseStore: store,
  });

  await router.fetch(jsonRequest("/v1/chat/completions", turnBody(0, "custom-store")));
  expect(policyCalls).toBe(1);
  expect(leases.get("custom-store")).toMatchObject({ startTurn: 0, turnsRemaining: 3 });

  // The next turn is served from the custom store without calling the policy.
  await router.fetch(jsonRequest("/v1/chat/completions", turnBody(1, "custom-store")));
  expect(policyCalls).toBe(1);
  expect(leases.get("custom-store")).toMatchObject({ startTurn: 0, turnsRemaining: 3 });
});

test("async LeaseStore methods are awaited and expired leases are never honored", async () => {
  let policyCalls = 0;
  const leases = new Map<string, RouterLease>();
  const store: LeaseStore = {
    get: async (key) => leases.get(key),
    set: async (key, lease) => {
      leases.set(key, lease);
    },
    delete: async (key) => {
      leases.delete(key);
    },
    // Deliberately lazy: the router's defensive expiry check must cover it.
    pruneExpired: async () => {},
  };
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => {
      policyCalls += 1;
      return { model: RICH, reasoningEffort: "high", leaseTurnsRemaining: 3 };
    },
    executors: { mock: textExecutor("hi") },
    leaseStore: store,
  });

  const first = await router.fetch(jsonRequest("/v1/chat/completions", turnBody(0, "async-store")));
  expect(first.status).toBe(200);
  expect(policyCalls).toBe(1);
  expect(leases.get("async-store")).toMatchObject({ startTurn: 0, turnsRemaining: 3 });

  const second = await router.fetch(jsonRequest("/v1/chat/completions", turnBody(1, "async-store")));
  expect(second.status).toBe(200);
  expect(policyCalls).toBe(1);

  // An expired lease must fall through to fresh selection even though
  // pruneExpired left it in place.
  leases.set("async-store", {
    model: RICH,
    reasoningEffort: "high",
    startTurn: 0,
    turnsRemaining: 5,
    expiresAt: Date.now() - 1,
  });
  const third = await router.fetch(jsonRequest("/v1/chat/completions", turnBody(2, "async-store")));
  expect(third.status).toBe(200);
  expect(policyCalls).toBe(2);
});

test("invalid leaseTurnsRemaining values are policy errors", async () => {
  for (const leaseTurnsRemaining of [-1, 1.5, Number.NaN]) {
    const router = createRouter({
      models: [RICH_MODEL],
      policy: () => ({ model: RICH, reasoningEffort: "high", leaseTurnsRemaining }),
      executors: { mock: { execute: () => { throw new Error("must not execute"); } } },
    });
    const response = await router.fetch(jsonRequest("/v1/chat/completions", {
      model: "my-router",
      messages: [{ role: "user", content: "hello" }],
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "policy_invalid_lease_turns" },
    });
  }
});

test("a served request fires selection and completion hooks but not onError", async () => {
  const selections: string[] = [];
  const completions: string[] = [];
  const errors: string[] = [];
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH, reasoningEffort: "high" }),
    executors: { mock: textExecutor("result") },
    hooks: {
      onSelection: (selection) => {
        selections.push(selection.decision.selectedModel);
      },
      onCompletion: (completion) => {
        completions.push(completion.content[0]?.type === "text" ? completion.content[0].text : "");
      },
      onError: (error) => {
        errors.push(error.code);
      },
    },
  });

  await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
  }));

  expect(selections).toEqual([RICH]);
  expect(completions).toEqual(["result"]);
  expect(errors).toEqual([]);
});

test("fallback retries on a different model when the primary executor fails", async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const router = createRouter({
    models: [RICH_MODEL, FALLBACK_MODEL],
    policy: () => ({ model: RICH, reasoningEffort: "high" }),
    executors: {
      mock: {
        execute: () => {
          primaryCalls += 1;
          throw new Error("primary executor failed");
        },
      },
      "fallback-mock": {
        execute: () => {
          fallbackCalls += 1;
          return { type: "complete", output: { content: [{ type: "text", text: "fallback result" }], finishReason: "stop" } };
        },
      },
    },
    fallback: { enabled: true, requiresDifferentProvider: false },
  });

  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
  }));

  expect(response.status).toBe(200);
  expect(primaryCalls).toBe(1);
  expect(fallbackCalls).toBe(1);
  const body = await response.json();
  expect(body.model).toBe("fallback/model");
  expect(body.dari_routing.selected_model).toBe("fallback/model");
});

test("fallback reports an honest selection to payloads and hooks", async () => {
  const selectionDecisions: unknown[] = [];
  const completionDecisions: unknown[] = [];
  const router = createRouter({
    models: [RICH_MODEL, FALLBACK_MODEL],
    policy: () => ({
      model: RICH,
      reasoningEffort: "high",
      reason: "primary is best",
      leaseTurnsRemaining: 2,
    }),
    executors: {
      mock: { execute: () => { throw new Error("primary down"); } },
      "fallback-mock": {
        execute: () => ({
          type: "complete",
          output: { content: [{ type: "text", text: "fallback result" }], finishReason: "stop" },
        }),
      },
    },
    fallback: { enabled: true },
    hooks: {
      onSelection: (selection) => {
        selectionDecisions.push(selection.decision);
      },
      onCompletion: (_completion, selection) => {
        completionDecisions.push(selection.decision);
      },
    },
  });

  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    prompt_cache_key: "honest-fallback",
  }));

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.dari_routing).toEqual({
    requested_model: "my-router",
    selected_model: "fallback/model",
    reasoning_effort: "high",
    reason: "Fell back to 'fallback/model' after executor for 'rich/model' failed. Original reason: primary is best",
  });
  // onSelection observes the pre-execution primary decision, lease included.
  expect(selectionDecisions).toEqual([{
    selectedModel: RICH,
    reasoningEffort: "high",
    reason: "primary is best",
    leaseTurnsRemaining: 2,
  }]);
  // onCompletion observes what was actually served: the fallback model with a
  // fallback reason and no leaseTurnsRemaining — that lease was released.
  expect(completionDecisions).toEqual([{
    selectedModel: "fallback/model",
    reasoningEffort: "high",
    reason: "Fell back to 'fallback/model' after executor for 'rich/model' failed. Original reason: primary is best",
  }]);
});

test("rejecting async hooks never affect responses or become unhandled rejections", async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on("unhandledRejection", onUnhandled);
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH, reasoningEffort: "high" }),
    executors: { mock: textExecutor("still served") },
    hooks: {
      onSelection: async () => { throw new Error("onSelection rejected"); },
      onCompletion: async () => { throw new Error("onCompletion rejected"); },
    },
  });

  try {
    const response = await router.fetch(jsonRequest("/v1/chat/completions", {
      model: "my-router",
      messages: [{ role: "user", content: "hello" }],
    }));
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toBe(0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("throwing hooks never affect non-streaming responses", async () => {
  const failingHooks = {
    onSelection: () => { throw new Error("onSelection exploded"); },
    onCompletion: () => { throw new Error("onCompletion exploded"); },
    onError: () => { throw new Error("onError exploded"); },
  };
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH, reasoningEffort: "high" }),
    executors: { mock: textExecutor("still served") },
    hooks: failingHooks,
  });

  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    choices: [{ message: { content: "still served" } }],
  });

  const failingRouter = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH, reasoningEffort: "high" }),
    executors: { mock: { execute: () => { throw new Error("upstream unavailable"); } } },
    hooks: failingHooks,
  });
  const errorResponse = await failingRouter.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
  }));
  expect(errorResponse.status).toBe(502);
  expect(await errorResponse.json()).toMatchObject({
    error: { code: "executor_setup_failed", message: "upstream unavailable" },
  });
});

test("throwing onStreamClose still terminates the stream normally", async () => {
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: asyncEvents([
            { type: "text_delta", index: 0, delta: "hello" },
            { type: "finish", finishReason: "stop" },
          ]),
        }),
      },
    },
    hooks: {
      onStreamClose: () => { throw new Error("onStreamClose exploded"); },
    },
  });

  const openAIResponse = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }));
  const openAIBody = await openAIResponse.text();
  expect(openAIResponse.status).toBe(200);
  expect(openAIBody.endsWith("data: [DONE]\n\n")).toBe(true);

  const anthropicResponse = await router.fetch(jsonRequest("/v1/messages", {
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }));
  const anthropicBody = await anthropicResponse.text();
  expect(anthropicBody.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true);
});

function signatureDeltas(body: string): string[] {
  return [...body.matchAll(/"signature_delta","signature":"([^"]*)"/g)].map((match) => match[1]!);
}

test("streamed thinking without a continuation gets a portable signature that replays", async () => {
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

  const response = await router.fetch(jsonRequest("/v1/messages", {
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "think" }],
    stream: true,
  }));
  const body = await response.text();

  expect(response.status).toBe(200);
  const [signature] = signatureDeltas(body);
  expect(signature).toStartWith("dari-ir-v1.");
  expect(body.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true);

  const replayed = anthropicRequest({
    model: "my-router",
    max_tokens: 64,
    messages: [
      { role: "user", content: "think" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me think.", signature },
          { type: "text", text: "Answer." },
        ],
      },
      { role: "user", content: "next" },
    ],
  });
  const reasoning = replayed.items.find((item) => item.type === "reasoning");
  expect(reasoning).toMatchObject({ type: "reasoning", source });
});

test("streamed thinking with a continuation gets a provider-continuation signature", async () => {
  const continuation = {
    kind: "anthropic_thinking" as const,
    source: { provider: "anthropic", api: "anthropic-messages", model: "claude-test" },
    thinking: "Let me think.",
    signature: "native-sig",
  };
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: asyncEvents([
            { type: "reasoning_delta", index: 0, delta: "Let me think." },
            { type: "reasoning_end", index: 0, continuation, source: continuation.source },
            { type: "finish", finishReason: "stop" },
          ]),
        }),
      },
    },
  });

  const response = await router.fetch(jsonRequest("/v1/messages", {
    model: "my-router",
    max_tokens: 64,
    messages: [{ role: "user", content: "think" }],
    stream: true,
  }));
  const body = await response.text();
  const [signature] = signatureDeltas(body);
  expect(signature).toStartWith("dari-pcs-v1.");
});

test("streamed redacted thinking is a complete block carrying its data", async () => {
  const source = { provider: "anthropic", api: "anthropic-messages", model: "claude-test" };
  const continuation = {
    kind: "anthropic_redacted_thinking" as const,
    source,
    data: "native-redacted-blob",
  };
  for (const endEvent of [
    { type: "reasoning_end", index: 0, redacted: true, continuation, source } as const,
    { type: "reasoning_end", index: 0, redacted: true, source } as const,
  ]) {
    const router = createRouter({
      models: [RICH_MODEL],
      policy: () => ({ model: RICH }),
      executors: {
        mock: {
          execute: () => ({
            type: "stream",
            events: asyncEvents([
              endEvent,
              { type: "text_delta", index: 1, delta: "Answer." },
              { type: "finish", finishReason: "stop" },
            ]),
          }),
        },
      },
    });

    const response = await router.fetch(jsonRequest("/v1/messages", {
      model: "my-router",
      max_tokens: 64,
      messages: [{ role: "user", content: "think" }],
      stream: true,
    }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(signatureDeltas(body)).toEqual([]);
    const match = /"content_block":\{"type":"redacted_thinking","data":"([^"]+)"\}/.exec(body);
    expect(match).not.toBeNull();
    const data = match![1]!;
    expect(data).toStartWith(endEvent.continuation ? "dari-pcs-v1." : "dari-ir-v1.");
    const blockStart = body.indexOf('"type":"redacted_thinking"');
    const blockStop = body.indexOf('"type":"content_block_stop","index":0');
    expect(blockStop).toBeGreaterThan(blockStart);
    expect(body.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true);

    const replayed = anthropicRequest({
      model: "my-router",
      max_tokens: 64,
      messages: [
        { role: "user", content: "think" },
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data },
            { type: "text", text: "Answer." },
          ],
        },
        { role: "user", content: "next" },
      ],
    });
    const reasoning = replayed.items.find((item) => item.type === "reasoning");
    expect(reasoning).toMatchObject({ type: "reasoning", source });
  }
});

test("slow readers exert backpressure instead of draining the executor", async () => {
  let nextCalls = 0;
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: () => ({
          type: "stream",
          events: {
            [Symbol.asyncIterator]() {
              let index = 0;
              return {
                async next() {
                  nextCalls += 1;
                  if (index < 100) {
                    return {
                      done: false as const,
                      value: { type: "text_delta" as const, index: 0, delta: `chunk-${index++}` },
                    };
                  }
                  return {
                    done: false as const,
                    value: { type: "finish" as const, finishReason: "stop" as const },
                  };
                },
                async return() {
                  return { done: true as const, value: undefined };
                },
              };
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
  const reader = response.body!.getReader();
  await reader.read();
  await reader.read();
  await reader.read();

  expect(nextCalls).toBeLessThan(10);
  await reader.cancel("done reading");
});

test("stream contract errors abort the executor signal and suppress the terminator", async () => {
  let executorSignal: AbortSignal | undefined;
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
    executors: {
      mock: {
        execute: (input) => {
          executorSignal = input.signal;
          return {
            type: "stream",
            events: asyncEvents([
              { type: "text_delta", index: 0, delta: "hello" },
              { type: "finish", finishReason: "stop" },
              { type: "text_delta", index: 0, delta: "after finish" },
            ]),
          };
        },
      },
    },
  });

  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }));
  const body = await response.text();

  expect(body).toContain('"code":"stream_invalid"');
  expect(body).not.toContain("data: [DONE]");
  expect(executorSignal?.aborted).toBe(true);
});

test("OpenAI streamed usage arrives in a separate final chunk with empty choices", async () => {
  const router = createRouter({
    models: [RICH_MODEL],
    policy: () => ({ model: RICH }),
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
  });

  const response = await router.fetch(jsonRequest("/v1/chat/completions", {
    model: "my-router",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }));
  const body = await response.text();
  const chunks = body
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice("data: ".length)));

  const finishChunk = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason === "stop");
  expect(finishChunk).toBeDefined();
  expect(finishChunk.usage).toBeUndefined();
  const usageChunk = chunks.at(-1);
  expect(usageChunk).toMatchObject({
    choices: [],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  });
  expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
});
