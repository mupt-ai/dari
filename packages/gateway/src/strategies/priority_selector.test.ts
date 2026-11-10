import { expect, test } from "bun:test";

import { createPrioritySelectorBackend } from "./priority_selector.js";
import { selectModel } from "./routing.js";

test("priority selection serves the first candidate", async () => {
  const run = await selectModel({
    messages: [{ role: "user", content: "hello" }],
    candidates: [
      { model: "anthropic/claude-sonnet-4-5", reasoningEffort: "medium" },
      { model: "openai/gpt-5.5", reasoningEffort: "high" },
    ],
    selectorBackend: createPrioritySelectorBackend(),
  });
  expect(run.decision).toMatchObject({
    selectedModel: "anthropic/claude-sonnet-4-5",
    reasoningEffort: "medium",
  });
  expect(run.selectorRequest.messages?.some((message) => message.content === "hello")).toBe(false);
});
