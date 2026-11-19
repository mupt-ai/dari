import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRouterSpec, parseRouterSpecText } from "./config.js";
import { loadRouterSpecDirectory, RouterSpecStore } from "./router_specs.js";

const SPEC = "name: Thinking Off\nmodels:\n  - id: openai/gpt-6.1-sol\n    thinking: [off]\n";

function stored(id: string, text: string) {
  return { ...parseRouterSpec(id, parseRouterSpecText(text)), text };
}

test("a saved spec outlives the process, as written, until it is removed", () => {
  const db = new Database(":memory:");
  new RouterSpecStore(db).save("thinking", stored("thinking", SPEC));

  const reopened = new RouterSpecStore(db);
  expect(reopened.get("thinking")).toMatchObject({
    source: "saved",
    name: "Thinking Off",
    text: SPEC,
    router: { models: [{ id: "openai/gpt-6.1-sol", thinking: ["off"] }] },
  });
  expect(reopened.remove("thinking")?.name).toBe("Thinking Off");
  expect(new RouterSpecStore(db).get("thinking")).toBeUndefined();
});

test("a saved spec is served in place of a spec file of its id", () => {
  const files = new Map([["shared", stored("shared", "name: From File\nmodels: [openai/gpt-6.1-sol]\n")]]);
  const store = new RouterSpecStore(new Database(":memory:"), files);
  expect(store.get("shared")).toMatchObject({ source: "file", name: "From File" });
  store.save("shared", stored("shared", SPEC));
  expect(store.get("shared")).toMatchObject({ source: "saved", name: "Thinking Off" });
  store.remove("shared");
  expect(store.get("shared")).toMatchObject({ source: "file", name: "From File" });
});

test("a routers directory serves each YAML file as the router its name names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dari-routers-"));
  writeFileSync(join(dir, "thinking.yaml"), SPEC);
  writeFileSync(join(dir, "plain.yml"), "name: Plain\nmodels: [anthropic/claude-opus-5-5]\n");
  writeFileSync(join(dir, "README.md"), "not a spec");
  const specs = await loadRouterSpecDirectory(dir);
  expect([...specs.keys()]).toEqual(["plain", "thinking"]);
  expect(specs.get("thinking")?.router.models).toEqual([{ id: "openai/gpt-6.1-sol", thinking: ["off"] }]);

  writeFileSync(join(dir, "broken.yaml"), "name: Broken\nmodels: [openai/gpt-6.1-sol]\nrouting: { rules: [{ when: x }] }\n");
  await expect(loadRouterSpecDirectory(dir)).rejects.toThrow("Router spec broken.yaml: routing.rules runs only on hosted Dari");
});
