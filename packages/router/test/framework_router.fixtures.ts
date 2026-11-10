import type {
  RouterExecutor,
  RouterModel,
  RouterStreamEvent,
} from "../src/index.js";

export const BASIC = "basic/model";
export const RICH = "rich/model";

export const BASIC_MODEL: RouterModel = {
  id: BASIC,
  executor: "mock",
  reasoningEfforts: ["off"],
};

export const RICH_MODEL: RouterModel = {
  id: RICH,
  executor: "mock",
  reasoningEfforts: ["off", "high"],
  defaultReasoningEffort: "high",
  capabilities: {
    imageInput: true,
    toolUse: true,
    structuredOutput: true,
    streaming: true,
  },
};

export const FALLBACK_MODEL: RouterModel = {
  id: "fallback/model",
  executor: "fallback-mock",
  provider: "fallback",
  api: "fallback",
  reasoningEfforts: ["high"],
};

export const FALLBACK_LOW_MODEL: RouterModel = {
  ...FALLBACK_MODEL,
  reasoningEfforts: ["low"],
  defaultReasoningEffort: "low",
  capabilities: { streaming: true },
};

export function textExecutor(text: string): RouterExecutor {
  return {
    execute: () => ({
      type: "complete",
      output: { content: [{ type: "text", text }], finishReason: "stop" },
    }),
  };
}

export function servedModel(response: Response): string {
  return response.headers.get("X-Router-Selected-Model")!;
}

export function jsonRequest(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Request {
  return new Request(`https://router.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

export function asyncEvents(
  events: readonly RouterStreamEvent[],
): AsyncIterable<RouterStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}
