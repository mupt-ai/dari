import { expect, test } from "bun:test";

import { inputModalitiesOverride, offRequiresWireNone, runtimeCompat } from "./runtime_overrides.js";

test("DeepSeek V4.1 Flash 1017 preserves image input and DeepSeek reasoning compat", () => {
  expect(inputModalitiesOverride("deepseek-ai/DeepSeek-V4.1-Flash-1017")).toEqual([
    "text",
    "image",
  ]);
  expect(offRequiresWireNone("deepseek-ai/DeepSeek-V4.1-Flash-1017")).toBe(true);
  expect(runtimeCompat("openrouter", undefined, "deepseek-ai/DeepSeek-V4.1-Flash-1017")).toMatchObject({
    thinkingFormat: "openrouter",
  });
});

test("gateways drop a model's native reasoning compat but keep its model traits", () => {
  // Kimi K3's override targets Fireworks' DeepSeek-style reasoning wire format.
  expect(runtimeCompat("fireworks", undefined, "moonshotai/Kimi-K3")).toMatchObject({
    thinkingFormat: "deepseek",
    requiresReasoningContentOnAssistantMessages: true,
  });
  for (const gateway of ["openrouter", "vercel-ai-gateway"]) {
    const compat = runtimeCompat(gateway, undefined, "moonshotai/Kimi-K3") as Record<string, unknown>;
    expect(compat.thinkingFormat).toBe("openrouter");
    expect(compat).not.toHaveProperty("supportsReasoningEffort");
    expect(compat).not.toHaveProperty("requiresReasoningContentOnAssistantMessages");
    expect(runtimeCompat(gateway, undefined, "anthropic/claude-opus-5-5")).toMatchObject({
      supportsTemperature: false,
    });
  }
});
