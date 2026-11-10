import { expect, test } from "bun:test";

import { museCodeModelsResponse } from "./muse_models.js";

test("Muse Code lists Dari Routing and the router's models, routing as the default", () => {
  expect(museCodeModelsResponse({ enabled_models: ["meta/muse-spark-1.3", "openai/gpt-5.5"] })).toEqual({
    data: [
      { id: "dari/routing", display_label: "Dari Routing", is_default: true },
      { id: "dari/model/meta/muse-spark-1.3", display_label: "meta/muse-spark-1.3", is_default: false },
      { id: "dari/model/openai/gpt-5.5", display_label: "openai/gpt-5.5", is_default: false },
    ],
  });
});

test("without the Autorouting plan the list starts on the router's first model", () => {
  expect(museCodeModelsResponse({ enabled_models: ["meta/muse-spark-1.3"], autorouting_enabled: false })).toEqual({
    data: [{ id: "dari/model/meta/muse-spark-1.3", display_label: "meta/muse-spark-1.3", is_default: true }],
  });
});
