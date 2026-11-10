// The framework's optional Dari policy runs the deterministic routing pipeline
// with an injected selector. This example uses a scripted selector and local
// executor, so it needs no API key or network access.
//
// Run with: bun run example:dari-policy

import { createRouter } from "../src/index.js";
import {
  createDariRoutingPolicy,
  type SelectorInput,
} from "../src/policy-engine.js";

const FAST = "demo/fast";
const STRONG = "demo/strong";

const policy = createDariRoutingPolicy({
  selector: async (request) => {
    const input = JSON.parse(
      String(request.messages?.[1]?.content),
    ) as SelectorInput;
    const selected = input.candidate_pairs.find(
      (candidate) => candidate.model === STRONG && candidate.thinking_level === "high",
    ) ?? input.candidate_pairs[0]!;
    return JSON.stringify({
      selected_model: selected.model,
      reasoning_effort: selected.thinking_level,
      reason: "The scripted selector chose the stronger candidate.",
    });
  },
  selectorModel: "demo/selector",
  selectorContextWindowChars: 100_000,
  pricing: (model) => model === FAST
    ? { input: 0.2, output: 0.8, cacheRead: 0.05, cacheWrite: 0.2 }
    : { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
  averageOutputTokensByModel: {
    [FAST]: { off: 300 },
    [STRONG]: { off: 800, high: 1_600 },
  },
});

const router = createRouter({
  models: [
    {
      id: FAST,
      executor: "local",
      api: "openai-completions",
      reasoningEfforts: ["off"],
    },
    {
      id: STRONG,
      executor: "local",
      api: "openai-completions",
      reasoningEfforts: ["off", "high"],
      defaultReasoningEffort: "high",
    },
  ],
  policy,
  executors: {
    local: {
      execute: ({ model, decision }) => ({
        type: "complete",
        output: {
          content: [{
            type: "text",
            text: `${model.id}/${decision.reasoningEffort}: ${decision.reason}`,
          }],
          finishReason: "stop",
        },
      }),
    },
  },
});

const response = await router.fetch(new Request(
  "http://router.local/v1/chat/completions",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "my-router",
      messages: [{ role: "user", content: "Plan a database migration." }],
    }),
  },
));

console.log(await response.json());
