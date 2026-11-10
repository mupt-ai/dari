// Dari Auto Router — use Dari's hosted routing model as a service.
//
// This is the simplest way to use @mupt-ai/dari-router: declare your models,
// drop createAutoRouter in as the policy, and Dari's routing model picks
// the best model for each request. You're billed per selection call.
//
// Requires DARI_API_KEY. The executor below is a local stub: replace it with
// a call to your provider to serve real traffic.

import { createAutoRouter, createRouter, type RouterExecutor } from "../src/index.js";

const stub: RouterExecutor = {
  execute({ model }) {
    return {
      type: "complete",
      output: {
        content: [{ type: "text", text: `Served by ${model.id}` }],
        finishReason: "stop",
      },
    };
  },
};

const router = createRouter({
  models: [
    { id: "openai/gpt-6-luna", executor: "stub" },
    { id: "anthropic/claude-fable-5-1", executor: "stub" },
  ],
  policy: createAutoRouter({ apiKey: process.env.DARI_API_KEY! }),
  executors: { stub },
});

const response = await router.fetch(
  new Request("https://example.test/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "dari/routing",
      messages: [{ role: "user", content: "Explain speculative decoding in one paragraph." }],
    }),
  }),
);

if (!response.ok) throw new Error(await response.text());
console.log(await response.json());
