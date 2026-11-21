import { afterEach, expect, test } from "bun:test";

import { startStubGateway } from "./stub_gateway.js";

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

const codexTurn = JSON.stringify({ thread_id: "019a0000-0000-7000-8000-0000000000aa", request_kind: "turn" });

// Codex reads its /model menu itself from `model_catalog_url` and keeps it in
// step with the router: it names its version in the query, and gets a list it
// can parse (it drops a whole catalog over one null web-search type).
test("Codex's own catalog fetch gets a list it can parse, marked for setup", async () => {
  const gateway = await startStubGateway({ plans: ["openai_codex"] });
  stop = gateway.stop;
  const auth = { authorization: `Bearer ${gateway.gatewayKey}` };

  const forCli = await fetch(`${gateway.baseUrl}/v1/models`, { headers: { ...auth, "x-dari-client-harness": "codex" } });
  const cliBody = (await forCli.json()) as Record<string, unknown> & { models: Array<Record<string, unknown>> };
  expect(cliBody.codex_direct).toBeUndefined();
  // The launchers still read the nulls to decide whether to turn web search off.
  expect(cliBody.models.some((model) => model.tool_mode === null)).toBe(true);

  const forCodex = await fetch(`${gateway.baseUrl}/v1/models?client_version=0.171.0`, { headers: auth });
  expect(forCodex.status).toBe(200);
  const codexBody = (await forCodex.json()) as Record<string, unknown> & { models: Array<Record<string, unknown>> };
  expect(codexBody.codex_direct).toBe(true);
  expect(codexBody.models.map((model) => model.slug)).toEqual(cliBody.models.map((model) => model.slug));
  for (const model of codexBody.models) {
    expect(typeof model.web_search_tool_type).toBe("string");
    expect("tool_mode" in model).toBe(false);
    expect("multi_agent_version" in model).toBe(false);
  }
  // Same list, same version, however it was asked for.
  expect(forCodex.headers.get("x-models-etag")).toMatch(/^[0-9a-f]{16}$/);
  expect(forCodex.headers.get("x-models-etag")).toBe(forCli.headers.get("x-models-etag"));
});

// A running Codex re-reads its catalog when a response's list version differs
// from the one it read the catalog with.
test("Codex responses carry the version of the list its catalog shows", async () => {
  const gateway = await startStubGateway({ plans: ["openai_codex"] });
  stop = gateway.stop;
  const auth = { authorization: `Bearer ${gateway.gatewayKey}` };
  const listed = await fetch(`${gateway.baseUrl}/v1/models?client_version=0.171.0`, { headers: auth });
  await listed.text();

  const served = await fetch(`${gateway.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json", "x-codex-turn-metadata": codexTurn },
    body: JSON.stringify({ model: "dari/routing", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] }),
  });
  expect(served.status).toBe(200);
  await served.text();
  expect(served.headers.get("x-models-etag")).toBe(listed.headers.get("x-models-etag"));

  // Not Codex: no header.
  const other = await fetch(`${gateway.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ model: "dari/routing", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] }),
  });
  await other.text();
  expect(other.headers.get("x-models-etag")).toBeNull();
});

// A pick from a /model menu read before the router dropped that model.
test("Codex is told how to bring an out-of-date /model menu up to date", async () => {
  const gateway = await startStubGateway({ plans: ["openai_codex"] });
  stop = gateway.stop;
  const auth = { authorization: `Bearer ${gateway.gatewayKey}` };
  const request = (headers: Record<string, string>) => fetch(`${gateway.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "dari/model/openai/gpt-0-gone", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] }),
  });

  const fromCodex = await request({ "x-codex-turn-metadata": codexTurn });
  expect(fromCodex.status).toBe(400);
  const codexError = ((await fromCodex.json()) as { error: { code: string; message: string; param?: string } }).error;
  expect(codexError.code).toBe("model_not_enabled");
  expect(codexError.param).toBe("model");
  expect(codexError.message).toBe(
    "Model 'openai/gpt-0-gone' is not enabled on this router. If it came from Codex's /model menu, the menu is out of date: run `dari setup codex --refresh`.",
  );

  const fromOther = await request({});
  const otherError = ((await fromOther.json()) as { error: { message: string } }).error;
  expect(otherError.message).toBe("Model 'openai/gpt-0-gone' is not enabled on this router.");
});
