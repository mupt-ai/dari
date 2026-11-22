import { expect, test } from "bun:test";
import type { InteractionRequest } from "../interaction/types.js";
import type { ResolvedRouter } from "../types.js";
import { catalogModelFor, linkGrantAccess } from "./grant_access.js";

const DEEPSEEK = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

test("a model id with capitals is the catalog model it names, by any case of its full or bare id", () => {
  const models = ["openai/gpt-6.1-sol", DEEPSEEK, "anthropic/claude-haiku-4-5"];
  expect(catalogModelFor(DEEPSEEK, models)).toBe(DEEPSEEK);
  expect(catalogModelFor(DEEPSEEK.toLowerCase(), models)).toBe(DEEPSEEK);
  expect(catalogModelFor("DeepSeek-V4.1-Flash-1017", models)).toBe(DEEPSEEK);
  expect(catalogModelFor("claude-haiku-4-5-20251001", models)).toBe("anthropic/claude-haiku-4-5");
  expect(catalogModelFor("deepseek-ai/DeepSeek-V9", models)).toBeNull();
});

test("a Dari Link grant that serves a model with capitals in its id serves a request naming it", () => {
  const credentials = { link_grant_id: "grant_1", link_models: [DEEPSEEK], enabled_models: [], model_configs: {}, model_thinking_levels: {} } as unknown as ResolvedRouter;
  const interaction = { model: `dari/model/${DEEPSEEK}` } as unknown as InteractionRequest;
  const served = linkGrantAccess(credentials, interaction);
  expect(served.credentials.enabled_models).toEqual([DEEPSEEK]);
  expect(served.interaction.model).toBe(`dari/model/${DEEPSEEK}`);
});
