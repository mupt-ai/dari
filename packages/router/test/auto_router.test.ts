import { expect, test } from "bun:test";

import {
  createAutoRouter,
  createRouter,
  RouterFrameworkError,
  type RouterCompletion,
  type RouterModel,
} from "../src/index.js";
import type { ChatCompletionRequest } from "../src/policy-engine.js";

const MINI = "openai/gpt-4.1-mini";
const SONNET = "anthropic/claude-sonnet-4-6";

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

function mockExecutor(): { execute: () => Promise<{ type: "complete"; output: RouterCompletion }> } {
  return {
    execute: async () => ({
      type: "complete",
      output: {
        content: [{ type: "text", text: "hello from the selected model" }],
        finishReason: "stop",
      },
    }),
  };
}

test("createAutoRouter requires an apiKey", () => {
  expect(() => createAutoRouter({ apiKey: "" })).toThrow(RouterFrameworkError);
});

test("createAutoRouter rejects custom strategies and configs", () => {
  for (const options of [
    { apiKey: "dari-test-key", strategy: "custom" },
    { apiKey: "dari-test-key", customConfig: { rules: [], default_target: null } },
  ] as never[]) {
    expect(() => createAutoRouter(options)).toThrow(RouterFrameworkError);
    expect(() => createAutoRouter(options)).toThrow(
      "createAutoRouter does not support custom routing rules",
    );
  }
});

test("createAutoRouter sends the selector request to the endpoint and routes the decision", async () => {
  let capturedRequest: ChatCompletionRequest | undefined;
  let capturedAuth: string | undefined;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/select")) {
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      capturedRequest = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          selected_model: MINI,
          reasoning_effort: "high",
          reason: "Auto Router selected the mini model.",
          thinking: "I considered both candidates and chose the cheaper one.",
        }),
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    }
    throw new Error(`Unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;

  try {
    const router = createRouter({
      models: MODELS,
      policy: createAutoRouter({ apiKey: "dari-test-key" }),
      executors: { mock: mockExecutor() },
    });

    const response = await router.fetch(
      new Request("https://test.test/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "dari/routing",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(capturedAuth).toBe("Bearer dari-test-key");
    expect(capturedRequest!.model).toBe("dari/auto-router");

    const body = await response.json();
    expect(body.choices[0].message.content).toBe("hello from the selected model");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createAutoRouter normalizes endpoints already ending in /select", async () => {
  for (const endpoint of [
    "https://routing.example/v1/auto-router/select",
    "https://routing.example/v1/auto-router/select/",
    "https://routing.example/v1/auto-router/",
  ]) {
    const fetchedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchedUrls.push(String(input));
      return new Response(
        JSON.stringify({
          selected_model: MINI,
          reasoning_effort: "high",
          reason: "Auto Router selected the mini model.",
        }),
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    }) as unknown as typeof fetch;

    try {
      const router = createRouter({
        models: MODELS,
        policy: createAutoRouter({ apiKey: "dari-test-key", endpoint }),
        executors: { mock: mockExecutor() },
      });
      const response = await router.fetch(
        new Request("https://test.test/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "dari/routing",
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(fetchedUrls).toEqual(["https://routing.example/v1/auto-router/select"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("createAutoRouter surfaces a RouterFrameworkError on HTTP failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("upstream error", { status: 503 })) as unknown as typeof fetch;

  try {
    const router = createRouter({
      models: MODELS,
      policy: createAutoRouter({ apiKey: "dari-test-key" }),
      executors: { mock: mockExecutor() },
    });

    const response = await router.fetch(
      new Request("https://test.test/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "dari/routing",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.message).toContain("HTTP 503");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
