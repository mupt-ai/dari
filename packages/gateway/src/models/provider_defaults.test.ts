import { expect, test } from "bun:test";

import { defaultBaseUrl, providerLabel } from "./provider_defaults.js";

test("built-in providers use their branded labels", () => {
  expect(providerLabel("openai")).toBe("OpenAI");
  expect(providerLabel("anthropic")).toBe("Anthropic");
  expect(providerLabel("fireworks")).toBe("Fireworks");
  expect(providerLabel("openrouter")).toBe("OpenRouter");
  expect(providerLabel("vercel-ai-gateway")).toBe("Vercel AI Gateway");
  expect(providerLabel("xai")).toBe("xAI");
  expect(providerLabel("XAI")).toBe("xAI");
  expect(providerLabel("amazon-bedrock")).toBe("Amazon Bedrock");
});

test("custom provider slugs title-case per segment", () => {
  expect(providerLabel("acme-ai")).toBe("Acme Ai");
  expect(providerLabel("acme")).toBe("Acme");
});

test("built-in base urls resolve and unknown providers stay null", () => {
  expect(defaultBaseUrl("openrouter")).toBe("https://openrouter.ai/api/v1");
  expect(defaultBaseUrl("vercel-ai-gateway")).toBe("https://ai-gateway.vercel.sh/v1");
  expect(defaultBaseUrl("xai")).toBe("https://api.x.ai/v1");
  expect(defaultBaseUrl("fireworks")).toBe("https://api.fireworks.ai/inference/v1");
  expect(defaultBaseUrl("amazon-bedrock")).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
  expect(defaultBaseUrl("acme")).toBeNull();
});
