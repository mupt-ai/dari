import { expect, test } from "bun:test";

import {
  createRouter,
  type CreateRouterOptions,
  type RouterExecutor,
  type RouterSelection,
  type RoutingPolicyDecision,
} from "../src/index.js";
import { openAIChatRequest } from "../src/protocols.js";

const ok: RouterExecutor = {
  execute({ model }) {
    return { type: "complete", output: { content: [{ type: "text", text: model.id }], finishReason: "stop" } };
  },
};

const failing: RouterExecutor = {
  execute() {
    throw new Error("provider down");
  },
};

function router(
  answers: RoutingPolicyDecision[],
  options: Partial<CreateRouterOptions> = {},
) {
  const calls: number[] = [];
  const served: RouterSelection[] = [];
  const background: Array<(selection: RouterSelection) => void> = [];
  const instance = createRouter({
    models: [
      { id: "fast/model", executor: "local", reasoningEfforts: ["off", "high"] },
      { id: "strong/model", executor: "local", reasoningEfforts: ["high"], capabilities: { imageInput: true } },
    ],
    executors: { local: ok },
    policy: () => {
      calls.push(calls.length + 1);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("Policy called more often than scripted.");
      return answer;
    },
    hooks: {
      onSelection: (selection) => {
        served.push(selection);
      },
      onSpeculativeSelection: (selection) => background.shift()?.(selection),
    },
    ...options,
  });
  const nextBackground = () => new Promise<RouterSelection>((resolve) => background.push(resolve));
  return { router: instance, calls, served, nextBackground };
}

function request(model: string, extra: Record<string, unknown> = {}) {
  return openAIChatRequest({ model, messages: [{ role: "user", content: "hi" }], ...extra });
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; status: number };
  }
  throw new Error("Expected a rejection.");
}

test("a dari/model/<id> request is served as named without the policy", async () => {
  const { router: r, calls } = router([]);
  const selection = await r.select(request("dari/model/strong/model"));
  expect(selection.source).toBe("explicit_model");
  expect(selection.decision).toMatchObject({ selectedModel: "strong/model", reasoningEffort: "high" });
  expect(calls).toEqual([]);

  const low = await r.select(request("dari/model/fast/model", { reasoning_effort: "high" }));
  expect(low.decision).toMatchObject({ selectedModel: "fast/model", reasoningEffort: "high" });
});

test("explicit requests the router cannot serve fail with the gateway's codes", async () => {
  const { router: r } = router([]);
  expect(await rejection(r.select(request("dari/model/missing/model")))).toMatchObject({ code: "model_not_enabled", status: 400 });
  expect(await rejection(r.select(request("dari/model/strong/model", { reasoning_effort: "off" })))).toMatchObject({
    code: "thinking_level_unavailable",
    status: 400,
  });
  const withImage = openAIChatRequest({
    model: "dari/model/fast/model",
    messages: [{
      role: "user",
      content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
    }],
  });
  expect(await rejection(r.select(withImage))).toMatchObject({ code: "model_unavailable", status: 400 });
});

test("strict routers serve only named models", async () => {
  const { router: r, calls } = router([], { strict: true });
  expect(await rejection(r.select(request("dari/routing")))).toMatchObject({ code: "strict_model_required", status: 400 });
  expect((await r.select(request("dari/model/fast/model"))).source).toBe("strict_model");
  expect(calls).toEqual([]);
});

test("a pinned session routes once and ignores leases", async () => {
  const { router: r, calls } = router(
    [{ model: "strong/model", leaseTurnsRemaining: 5 }, { model: "fast/model" }],
    { sessionPinKey: (req) => req.metadata?.session as string | undefined },
  );
  const pinned = (session: string) => request("dari/routing", { metadata: { session }, prompt_cache_key: "conv-1" });

  const first = await r.select(pinned("s-1"));
  expect(first).toMatchObject({ source: "policy", decision: { selectedModel: "strong/model" } });
  const second = await r.select(pinned("s-1"));
  expect(second).toMatchObject({ source: "session_pin", decision: { selectedModel: "strong/model" } });
  expect(second.decision.leaseTurnsRemaining).toBeUndefined();

  // Another session routes on its own.
  expect((await r.select(pinned("s-2"))).decision.selectedModel).toBe("fast/model");
  expect(calls).toEqual([1, 2]);
});

test("a lease's successor is prefetched and adopted when the lease ends", async () => {
  const { router: r, calls, nextBackground } = router(
    [
      { model: "fast/model", reasoningEffort: "off", leaseTurnsRemaining: 2 },
      { model: "strong/model", leaseTurnsRemaining: 1 },
    ],
    { leasePrefetchTurns: 1 },
  );
  // Each call is the conversation's next turn: one more assistant reply.
  const messages: Array<{ role: string; content: string }> = [{ role: "user", content: "hi" }];
  const turn = async () => {
    const selection = await r.select(request("dari/routing", { prompt_cache_key: "conv-1", messages: [...messages] }));
    messages.push({ role: "assistant", content: "reply" }, { role: "user", content: "next" });
    return selection;
  };

  expect((await turn()).source).toBe("policy");
  const prefetched = nextBackground();
  const second = await turn();
  expect(second).toMatchObject({ source: "lease_hold", decision: { selectedModel: "fast/model", leaseTurnsRemaining: 1 } });
  expect((await prefetched).decision.selectedModel).toBe("strong/model");

  expect((await turn())).toMatchObject({ source: "lease_hold", decision: { selectedModel: "fast/model" } });
  const adopted = await turn();
  expect(adopted).toMatchObject({
    source: "prefetched_lease",
    decision: { selectedModel: "strong/model", leaseTurnsRemaining: 1 },
  });
  expect((await turn())).toMatchObject({ source: "lease_hold", decision: { selectedModel: "strong/model" } });
  expect(calls).toEqual([1, 2]);
});

test("leasePrefetchTurns must be a positive integer", () => {
  expect(() => router([], { leasePrefetchTurns: 0 })).toThrow("positive integer");
});

test("an executor fallback reports the fallback source", async () => {
  let served: RouterSelection | undefined;
  const r = createRouter({
    models: [
      { id: "fast/model", executor: "down", reasoningEfforts: ["off"] },
      { id: "strong/model", executor: "local", reasoningEfforts: ["off"] },
    ],
    executors: { down: failing, local: ok },
    policy: () => ({ model: "fast/model" }),
    fallback: { enabled: true },
    hooks: { onCompletion: (_completion, selection) => { served = selection; } },
  });
  const response = await r.fetch(new Request("http://router.local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "dari/routing", messages: [{ role: "user", content: "hi" }] }),
  }));
  expect(response.status).toBe(200);
  expect(served).toMatchObject({ source: "fallback", decision: { selectedModel: "strong/model" } });
});

test("auxiliary requests bypass the policy, pins, and leases and leave no state", async () => {
  const { router: r, calls } = router(
    [{ model: "strong/model", leaseTurnsRemaining: 5 }],
    {
      sessionPinKey: (req) => req.metadata?.session as string | undefined,
      auxiliary: ({ request: req }) =>
        req.metadata?.background === "title" ? { model: "fast/model", reasoningEffort: "off", leaseTurnsRemaining: 9 } : undefined,
    },
  );
  const conversation = (extra: Record<string, unknown>) => request("dari/routing", { prompt_cache_key: "conv-aux", ...extra });

  const background = await r.select(conversation({ metadata: { background: "title", session: "s-1" } }));
  expect(background).toMatchObject({ source: "auxiliary", decision: { selectedModel: "fast/model", reasoningEffort: "off" } });
  expect(background.decision.leaseTurnsRemaining).toBeUndefined();
  expect(calls).toEqual([]);

  // The session's first foreground request still routes through the policy.
  const foreground = await r.select(conversation({ metadata: { session: "s-1" } }));
  expect(foreground).toMatchObject({ source: "policy", decision: { selectedModel: "strong/model" } });
  // A later background request bypasses the pin the foreground set.
  expect((await r.select(conversation({ metadata: { background: "title", session: "s-1" } }))).source).toBe("auxiliary");
  // A named model wins over the auxiliary decision.
  expect((await r.select(request("dari/model/strong/model", { metadata: { background: "title" } }))).source).toBe("explicit_model");
  expect(calls).toEqual([1]);
});

test("a pinned model reports its own error when no model is eligible", async () => {
  const { router: r } = router([]);
  // No model accepts "minimal", so eligibility fails for every candidate.
  expect(await rejection(r.select(request("dari/model/strong/model", { reasoning_effort: "minimal" })))).toMatchObject({
    code: "thinking_level_unavailable",
    status: 400,
  });
  expect(await rejection(r.select(request("dari/routing", { reasoning_effort: "minimal" })))).not.toMatchObject({
    code: "thinking_level_unavailable",
  });
});
