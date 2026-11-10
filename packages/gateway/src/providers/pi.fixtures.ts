import type { ChatCompletionRequest } from "@mupt-ai/dari-router/policy-engine";

import { chatCompletionsToInteraction } from "../protocol/input/chat_completions.js";
import { buildContext } from "./pi_context.js";
import { buildOptions } from "./pi_options.js";

import type { ResolvedRouterModelConfig } from "../types.js";

// routing.test.ts and server.test.ts mock ./pi at module scope. Bun keeps those
// module mocks process-wide when test files share a worker, so load the real Pi
// adapter through a cache-busted specifier before asserting registry behavior.
const piModulePath = "./pi.ts?actual";
export const {
  buildModel,
  completeInteractionModel,
  completeProviderEventStream,
  modelContextWindow,
  modelMetadataLookup,
  pi,
  streamInteractionModel,
} =
  (await import(piModulePath)) as typeof import("./pi.js");

export const modelFixtures: Record<string, Record<string, unknown>> = {
  "deepseek-ai/DeepSeek-V4-Pro-0813": {
    id: "deepseek-ai/DeepSeek-V4-Pro",
    provider: "fireworks",
    api: "openai-completions",
    baseUrl: "https://inference.fireworks.co/v1",
    reasoning: true,
    thinkingLevelMap: { high: "high", max: "max" },
    supportedThinkingLevels: ["off", "high", "max"],
    defaultThinkingLevel: "high",
  },
  "deepseek-ai/DeepSeek-V4-Flash-0731": {
    id: "deepseek-ai/DeepSeek-V4-Flash-0731",
    provider: "fireworks",
    api: "openai-completions",
    baseUrl: "https://inference.fireworks.co/v1",
    reasoning: true,
    thinkingLevelMap: { high: "high", max: "max" },
    supportedThinkingLevels: ["off", "high", "max"],
    defaultThinkingLevel: "high",
  },
  "fireworks/moonshotai/Kimi-K2.6": {
    id: "moonshotai/Kimi-K2.6",
    provider: "fireworks",
    api: "openai-completions",
    baseUrl: "https://inference.fireworks.co/v1",
    reasoning: true,
    supportedThinkingLevels: ["off"],
  },
  "zai-org/GLM-5.2": {
    id: "zai-org/GLM-5.2",
    provider: "fireworks",
    api: "openai-completions",
    baseUrl: "https://inference.fireworks.co/v1",
    reasoning: true,
    thinkingLevelMap: { off: "none", max: "max" },
    supportedThinkingLevels: ["off", "high", "max"],
    defaultThinkingLevel: "max",
  },
  "openai/gpt-5.5-pro": {
    id: "gpt-5.5-pro",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    thinkingLevelMap: { off: null, xhigh: "xhigh", minimal: null, low: null },
    supportedThinkingLevels: ["medium", "high", "xhigh"],
  },
  "openai/gpt-5.6-sol": {
    id: "gpt-5.6-sol",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    supportedThinkingLevels: ["off", "high"],
  },
  "openai/o3": {
    id: "o3",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    supportedThinkingLevels: ["off", "minimal", "low", "medium", "high"],
  },
  "openai/gpt-4.1-mini": {
    id: "gpt-4.1-mini",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    supportedThinkingLevels: ["off"],
  },
  "openai/gpt-5.6-terra": {
    id: "gpt-5.6-terra",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinkingLevel: "medium",
  },
  "amazon-bedrock/global.anthropic.claude-sonnet-5": {
    id: "global.anthropic.claude-sonnet-5",
    provider: "amazon-bedrock",
    api: "bedrock-converse-stream",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinkingLevel: "high",
  },
  "anthropic/claude-fable-5-1": {
    id: "claude-fable-5-1",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    defaultThinkingLevel: "high",
  },
  "anthropic/claude-fable-5": {
    id: "claude-fable-5",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    defaultThinkingLevel: "high",
  },
};

export const piFixture = {
  completeSimple: async () => {
    throw new Error("completeSimple should not be called in pi option tests");
  },
  streamSimple: () => {
    throw new Error("streamSimple should not be called in pi option tests");
  },
  getSupportedThinkingLevels: (model: Record<string, unknown>) => {
    const levels = model.supportedThinkingLevels;
    return Array.isArray(levels) ? levels : ["off"];
  },
};

const OPENAI_TARGET = { provider: "openai", api: "openai-responses", model: "gpt-4.1-mini" };

export function buildModelOptions(
  selectedModel: string,
  request: ChatCompletionRequest
): Record<string, unknown> {
  return buildOptions(
    chatCompletionsToInteraction(request),
    "sk-test",
    selectedModel,
    modelFixtures[selectedModel],
    piFixture
  );
}

export function buildTestContext(request: ChatCompletionRequest): Record<string, unknown> {
  return buildContext(chatCompletionsToInteraction(request), OPENAI_TARGET);
}

export function requestWithReasoning(reasoning: Partial<Pick<ChatCompletionRequest, "reasoning_effort">>): ChatCompletionRequest {
  return {
    model: "dari/routing",
    messages: [{ role: "user", content: "hello" }],
    ...reasoning,
  };
}

export async function* providerEvents(
  events: Array<Record<string, unknown>>
): AsyncIterable<Record<string, unknown>> {
  yield* events;
}
