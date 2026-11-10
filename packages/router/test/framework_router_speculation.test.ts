import { expect, test } from "bun:test";

import {
  createRouter,
  type RouterExecutor,
  type RouterSelection,
  type RoutingPolicyDecision,
} from "../src/index.js";
import { openAIChatRequest } from "../src/protocols.js";

const executor: RouterExecutor = {
  execute({ model }) {
    return { type: "complete", output: { content: [{ type: "text", text: model.id }], finishReason: "stop" } };
  },
};

const MODELS = [
  { id: "fast/model", executor: "local", reasoningEfforts: ["off"] as const },
  { id: "strong/model", executor: "local", reasoningEfforts: ["off"] as const, capabilities: { imageInput: true } },
];

// A policy scripted turn by turn; each call takes the next answer.
function scriptedRouter(answers: Array<RoutingPolicyDecision | Error>, options: { speculative?: boolean } = {}) {
  const calls: string[] = [];
  const next: Array<(selection: RouterSelection) => void> = [];
  const router = createRouter({
    models: MODELS.map((model) => ({ ...model, reasoningEfforts: [...model.reasoningEfforts] })),
    executors: { local: executor },
    policy: async ({ request }) => {
      const answer = answers.shift();
      calls.push(lastUserText(request.items));
      if (answer === undefined) throw new Error("Policy called more often than scripted.");
      if (answer instanceof Error) throw answer;
      return answer;
    },
    speculative: options.speculative ?? true,
    hooks: { onSpeculativeSelection: (selection) => next.shift()?.(selection) },
  });
  const settled = () => new Promise<RouterSelection>((resolve) => next.push(resolve));
  return { router, calls, settled };
}

function turn(text: string, extra: Record<string, unknown> = {}) {
  return openAIChatRequest({
    model: "dari/routing",
    messages: [{ role: "user", content: text }],
    prompt_cache_key: "conv-1",
    ...extra,
  });
}

function lastUserText(items: readonly { type: string; content?: unknown }[]): string {
  const message = [...items].reverse().find((item) => item.type === "message") as
    | { content: Array<{ type: string; text?: string }> }
    | undefined;
  return message?.content.find((part) => part.type === "text")?.text ?? "";
}

test("the first turn waits for the policy; later turns serve the previous decision while selecting the next", async () => {
  const { router, calls, settled } = scriptedRouter([
    { model: "fast/model", reason: "turn one" },
    { model: "strong/model", reason: "turn two picks strong" },
    { model: "fast/model", reason: "turn three picks fast" },
  ]);

  const first = await router.select(turn("one"));
  expect(first.decision).toMatchObject({ selectedModel: "fast/model", reason: "turn one" });

  const nextAfterTwo = settled();
  const second = await router.select(turn("two"));
  expect(second.decision).toMatchObject({
    selectedModel: "fast/model",
    reason: "Continuing the previous model while selecting the next route.",
  });
  expect((await nextAfterTwo).decision.selectedModel).toBe("strong/model");

  const nextAfterThree = settled();
  const third = await router.select(turn("three"));
  expect(third.decision.selectedModel).toBe("strong/model");
  await nextAfterThree;

  expect(calls).toEqual(["one", "two", "three"]);
});

test("a failed background selection keeps serving the previous model", async () => {
  const { router, calls } = scriptedRouter([
    { model: "strong/model" },
    new Error("selector down"),
    { model: "fast/model" },
  ]);
  await router.select(turn("one"));
  expect((await router.select(turn("two"))).decision.selectedModel).toBe("strong/model");
  // Let the failed background selection settle before the next turn.
  await Bun.sleep(0);
  expect((await router.select(turn("three"))).decision.selectedModel).toBe("strong/model");
  expect(calls).toEqual(["one", "two", "three"]);
});

test("an ineligible previous model makes the turn wait for the policy", async () => {
  const { router, calls } = scriptedRouter([
    { model: "fast/model" },
    { model: "strong/model", reason: "only strong reads images" },
  ]);
  await router.select(turn("one"));
  const withImage = openAIChatRequest({
    model: "dari/routing",
    prompt_cache_key: "conv-1",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "two" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    }],
  });
  const second = await router.select(withImage);
  expect(second.decision).toMatchObject({ selectedModel: "strong/model", reason: "only strong reads images" });
  expect(calls).toEqual(["one", "two"]);
});

test("committed leases take precedence over speculation", async () => {
  const { router, calls } = scriptedRouter([
    { model: "strong/model", leaseTurnsRemaining: 1 },
    { model: "fast/model" },
  ]);
  await router.select(turn("one"));
  const leased = await router.select(turn("two"));
  expect(leased.decision.selectedModel).toBe("strong/model");
  expect(leased.decision.reason).toContain("committed lease");
  expect(calls).toEqual(["one"]);
});

test("requests without a cacheKey and routers without speculation select every turn", async () => {
  const noKey = scriptedRouter([{ model: "fast/model" }, { model: "strong/model" }]);
  await noKey.router.select(openAIChatRequest({ model: "dari/routing", messages: [{ role: "user", content: "one" }] }));
  const second = await noKey.router.select(openAIChatRequest({ model: "dari/routing", messages: [{ role: "user", content: "two" }] }));
  expect(second.decision.selectedModel).toBe("strong/model");

  const off = scriptedRouter([{ model: "fast/model" }, { model: "strong/model" }], { speculative: false });
  await off.router.select(turn("one"));
  expect((await off.router.select(turn("two"))).decision.selectedModel).toBe("strong/model");
});

test("a disconnecting client does not cancel the next turn's selection", async () => {
  const { router, settled } = scriptedRouter([
    { model: "fast/model" },
    { model: "strong/model" },
  ]);
  await router.select(turn("one"));
  const controller = new AbortController();
  const next = settled();
  await router.select(turn("two"), controller.signal);
  controller.abort();
  expect((await next).decision.selectedModel).toBe("strong/model");
});

test("fetch serves the speculative decision end to end", async () => {
  const { router, settled } = scriptedRouter([
    { model: "fast/model" },
    { model: "strong/model" },
  ]);
  const send = (text: string) => router.fetch(new Request("http://router.local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "dari/routing", prompt_cache_key: "conv-1", messages: [{ role: "user", content: text }] }),
  }));
  expect(((await (await send("one")).json()) as any).choices[0].message.content).toBe("fast/model");
  const next = settled();
  const second = await send("two");
  expect(second.headers.get("X-Router-Selected-Model")).toBe("fast/model");
  await second.text();
  await next;
});
