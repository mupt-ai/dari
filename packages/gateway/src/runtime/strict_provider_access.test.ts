import { expect, test } from "bun:test";
import type { InteractionRequest } from "../interaction/types.js";
import type { ResolvedRouter } from "../types.js";
import { strictProviderAccess } from "./strict_provider_access.js";

function resolve(model: string, overrides: Partial<ResolvedRouter> = {}) {
  const credentials = { strict: true, strict_providers: ["openai"], enabled_models: [], ...overrides } as unknown as ResolvedRouter;
  const interaction = { model } as InteractionRequest;
  return strictProviderAccess(credentials, interaction);
}

test("provider grants accept explicit catalog IDs", () => {
  for (const id of ["dari/model/openai/gpt-5.5"]) {
    const result = resolve(id);
    expect(result.interaction.model).toBe("dari/model/openai/gpt-5.5");
    expect(result.credentials.enabled_models).toEqual(["openai/gpt-5.5"]);
  }
});

test("unknown or other-provider models are not enabled", () => {
  for (const id of ["dari/routing", "gpt-5.5", "dari/model/openai/not-a-real-model", "dari/model/anthropic/claude-sonnet-5-5"]) {
    expect(resolve(id, { enabled_models: ["openai/gpt-5.4"] }).credentials.enabled_models).toEqual(["openai/gpt-5.4"]);
  }
});

test("grant-only routers refuse ungranted requests with strict errors", () => {
  for (const [id, code] of [
    ["dari/routing", "strict_model_required"],
    ["gpt-5.5", "strict_model_required"],
    ["dari/model/openai/not-a-real-model", "model_not_enabled"],
    ["dari/model/anthropic/claude-sonnet-5-5", "model_not_enabled"],
  ]) {
    expect(() => resolve(id!)).toThrow(expect.objectContaining({ code }));
  }
});

test("non-strict routers do not acquire provider access", () => {
  expect(resolve("gpt-5.5", { strict: false }).credentials.enabled_models).toEqual([]);
});

test("invalid provider configuration fails explicitly", () => {
  expect(() => resolve("dari/model/openai/gpt-5.5", { strict_providers: ["typo"] })).toThrow("Unknown strict provider");
});
