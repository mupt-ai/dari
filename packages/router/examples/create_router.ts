// A complete router with a custom policy and a local executor. Both protocol
// examples run in-process, so this file needs no API key or network access.
//
// Run with: bun run example

import {
  createRouter,
  type RouterExecutor,
  type RoutingPolicy,
} from "../src/index.js";

const FAST = "demo/fast";
const STRONG = "demo/strong";

const policy: RoutingPolicy = ({ request, candidates }) => {
  const promptLength = request.items.reduce((length, item) =>
    item.type === "message"
      ? length + item.content.reduce(
          (total, part) => total + (part.type === "text" ? part.text.length : 0),
          0,
        )
      : length,
  0);
  const preferred = promptLength > 80 ? STRONG : FAST;
  const model = candidates.find((candidate) => candidate.id === preferred)
    ?? candidates[0]!;
  return {
    model: model.id,
    reason: promptLength > 80
      ? "The long request uses the stronger model."
      : "The short request uses the fast model.",
  };
};

const localExecutor: RouterExecutor = {
  execute({ request, model, decision }) {
    const text = `${model.id} handled ${request.protocol}: ${decision.reason}`;
    if (!request.stream) {
      return {
        type: "complete",
        output: {
          content: [{ type: "text", text }],
          finishReason: "stop",
          usage: { inputTokens: 12, outputTokens: 8 },
        },
      };
    }
    return {
      type: "stream",
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "text_delta", index: 0, delta: text } as const;
          yield {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 12, outputTokens: 8 },
          } as const;
        },
      },
    };
  },
};

const router = createRouter({
  models: [
    {
      id: FAST,
      executor: "local",
      reasoningEfforts: ["off"],
      capabilities: { streaming: true },
    },
    {
      id: STRONG,
      executor: "local",
      reasoningEfforts: ["off", "high"],
      capabilities: {
        imageInput: true,
        toolUse: true,
        structuredOutput: true,
        streaming: true,
      },
    },
  ],
  policy,
  executors: { local: localExecutor },
});

const openAIResponse = await router.fetch(new Request(
  "http://router.local/v1/chat/completions",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "my-router",
      messages: [{ role: "user", content: "Say hello." }],
    }),
  },
));
console.log("OpenAI Chat Completions:\n", await openAIResponse.json());

const anthropicResponse = await router.fetch(new Request(
  "http://router.local/v1/messages",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "my-router",
      max_tokens: 128,
      messages: [{ role: "user", content: "Stream a short hello." }],
      stream: true,
    }),
  },
));
console.log("\nAnthropic Messages stream:\n", await anthropicResponse.text());
