import { expect, test } from "bun:test";

import { HttpError } from "../http/errors.js";
import { createAutoRoutingSelectorBackend } from "./auto_routing_selector.js";
import { selectModel } from "./routing.js";

const candidates = [
  { model: "anthropic/claude-sonnet-4-5", reasoningEffort: "medium" as const },
  { model: "openai/gpt-5.5", reasoningEffort: "high" as const },
];

function select(fetch: typeof globalThis.fetch) {
  return selectModel({
    messages: [{ role: "user", content: "refactor this module" }],
    candidates,
    selectorBackend: createAutoRoutingSelectorBackend({
      apiKey: "dari-key",
      endpoint: "https://auto.example/v1/auto-router/",
      fetch,
    }),
  });
}

test("Dari Auto Routing posts the sized selector request and parses its decision", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const run = await select((async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      selected_model: "openai/gpt-5.5",
      reasoning_effort: "high",
      reason: "Long refactor.",
      lease_turns_remaining: 4,
    }));
  }) as unknown as typeof fetch);

  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://auto.example/v1/auto-router/select");
  expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer dari-key");
  expect(JSON.parse(String(calls[0]!.init.body)).model).toBe("dari/auto-router");
  expect(run.decision).toEqual({
    selectedModel: "openai/gpt-5.5",
    reasoningEffort: "high",
    reason: "Long refactor.",
  });
});

test("Dari Auto Routing failures surface as selector errors", async () => {
  const error = await select((async () => new Response("busy", { status: 503 })) as unknown as typeof fetch)
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpError);
  expect(error).toMatchObject({ status: 502, code: "selector_execution_failed" });
});
