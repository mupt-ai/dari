import { expect, test } from "bun:test";

import { RouterCoreError } from "../src/errors.js";
import { canonicalModelId, modelFamilyProvider, nativeModelId, providerForModel } from "../src/model_ids.js";

test("splits provider prefixes case-insensitively", () => {
  expect(providerForModel("openai/gpt-4.1-mini")).toBe("openai");
  expect(providerForModel("OpenAI/gpt-4.1-mini")).toBe("openai");
  expect(providerForModel("fireworks/deepseek-ai/DeepSeek-V4-Pro")).toBe("fireworks");
  expect(nativeModelId("fireworks/deepseek-ai/DeepSeek-V4-Pro")).toBe(
    "deepseek-ai/DeepSeek-V4-Pro",
  );
});

test("rejects malformed model ids with a typed error", () => {
  for (const model of ["gpt-4.1-mini", "/gpt", "9bad/model", "UPPER CASE/model"]) {
    try {
      providerForModel(model);
      throw new Error(`expected ${model} to be rejected`);
    } catch (error) {
      expect(error).toBeInstanceOf(RouterCoreError);
      expect((error as RouterCoreError).code).toBe("unsupported_model");
      expect((error as RouterCoreError).kind).toBe("invalid_request");
    }
  }
});

test("canonicalizes only the provider segment", () => {
  expect(canonicalModelId("OpenAI/gpt-4.1-mini")).toBe("openai/gpt-4.1-mini");
  expect(canonicalModelId("fireworks/deepseek-ai/DeepSeek-V4-Pro")).toBe(
    "fireworks/deepseek-ai/DeepSeek-V4-Pro",
  );
  expect(canonicalModelId("no-slash")).toBe("no-slash");
});

test("family provider follows serving aliases to the canonical owner", () => {
  expect(modelFamilyProvider("openai/gpt-5.6-sol", "openai-codex")).toBe("openai");
  expect(modelFamilyProvider("openai/gpt-5.6-sol", "amazon-bedrock")).toBe("openai");
  expect(modelFamilyProvider("anthropic/claude-sonnet-5", "amazon-bedrock")).toBe(
    "anthropic",
  );
  expect(modelFamilyProvider("openai/gpt-5.6-sol", "azure")).toBe("openai");
  expect(modelFamilyProvider("anthropic/claude-sonnet-5", "azure")).toBe("anthropic");
  // Unrecognized serving providers are themselves, and so are aliased providers
  // whose canonical owner is not a known family.
  expect(modelFamilyProvider("prox-bedrock/gpt-5.6-sol", "amazon-bedrock")).toBe(
    "amazon-bedrock",
  );
  expect(modelFamilyProvider("prox-azure/gpt-5.6-sol", "azure")).toBe("azure");
  expect(modelFamilyProvider("openai/gpt-5.6-sol", "openrouter")).toBe("openrouter");
  // Vercel AI Gateway passes the upstream cache through; open-weight models
  // get the automatic prefix cache of the fireworks family.
  expect(modelFamilyProvider("anthropic/claude-opus-5-5", "vercel-ai-gateway")).toBe("anthropic");
  expect(modelFamilyProvider("openai/gpt-6.1-sol", "vercel-ai-gateway")).toBe("openai");
  expect(modelFamilyProvider("zai-org/GLM-5.3", "vercel-ai-gateway")).toBe("fireworks");
  expect(modelFamilyProvider("moonshotai/Kimi-K3", "vercel-ai-gateway")).toBe("fireworks");
  // Without an explicit provider the id's prefix decides, and unparseable ids
  // are errors rather than silently generic models.
  expect(modelFamilyProvider("anthropic/claude-sonnet-5")).toBe("anthropic");
  expect(modelFamilyProvider("ANTHROPIC/claude-sonnet-5")).toBe("anthropic");
  expect(() => modelFamilyProvider("claude-sonnet-5")).toThrow("Unsupported model provider");
});
