import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End to end through the gateway entrypoint, the real runtime, and Pi's
// OpenAI-compatible client, against a local stand-in for an
// OpenAI-compatible provider. The gateway runs as its own process so no
// other test file's module mocks reach it.
type UpstreamCall = { model: string; authorization: string | null; stream: boolean };

const upstreamCalls: UpstreamCall[] = [];
const failingModels = new Set<string>();
let upstream: ReturnType<typeof Bun.serve>;
let gateway: ReturnType<typeof Bun.spawn>;
let baseUrl: string;
let dir: string;
let configPath: string;

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      // The startup key check lists models with the endpoint's key.
      if (request.method === "GET" && new URL(request.url).pathname === "/v1/models") {
        return request.headers.get("authorization") === "Bearer local-secret"
          ? Response.json({ data: [] })
          : Response.json({ error: { message: "invalid key" } }, { status: 401 });
      }
      const body = await request.json() as { model: string; stream?: boolean };
      upstreamCalls.push({
        model: body.model,
        authorization: request.headers.get("authorization"),
        stream: body.stream === true,
      });
      if (failingModels.has(body.model)) {
        return Response.json({ error: { message: "upstream unavailable" } }, { status: 500 });
      }
      return completionResponse(body.model, body.stream === true);
    },
  });
  dir = mkdtempSync(join(tmpdir(), "dari-gateway-"));
  configPath = join(dir, "dari-gateway.yaml");
  writeFileSync(configPath, `
routers:
  default:
    models:
      - id: local/model-a
        thinking: [off]
      - id: local/model-b
        thinking: [off]
    retries: 0
  solo:
    models: [local/model-b]
providers:
  local:
    baseUrl: http://127.0.0.1:${upstream.port}/v1
    apiKeyEnv: LOCAL_API_KEY
`);
  const port = await freePort();
  gateway = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
    env: {
      PATH: process.env.PATH ?? "",
      DARI_GATEWAY_KEYS: "gw-key-1, gw-key-2",
      DARI_GATEWAY_CONFIG: configPath,
      DARI_GATEWAY_DB: join(dir, "gateway.db"),
      LOCAL_API_KEY: "local-secret",
      PORT: String(port),
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  await waitForLine(gateway.stdout as ReadableStream<Uint8Array>, "dari-gateway listening");
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  gateway.kill();
  await gateway.exited;
  await upstream.stop(true);
});

test("chat completions route to the first model with the configured endpoint key", async () => {
  upstreamCalls.length = 0;
  const response = await chat({ model: "dari/routing" });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-dari-selected-model")).toBe("local/model-a");
  const body = await response.json() as { choices: { message: { content: string } }[] };
  expect(body.choices[0]!.message.content).toBe("served by model-a");
  expect(upstreamCalls).toEqual([
    { model: "model-a", authorization: "Bearer local-secret", stream: true },
  ]);
});

// Without Dari Auto Routing the model list offers only real models, while a
// client still configured for dari/routing keeps being served (test above).
test("without Dari Auto Routing the model list leaves out dari/routing", async () => {
  const response = await fetch(`${baseUrl}/v1/models`, { headers: authorized() });
  expect(response.status).toBe(200);
  const body = await response.json() as { models: { slug: string }[] };
  expect(body.models.map((model) => model.slug)).toEqual(["dari/model/local/model-a", "dari/model/local/model-b"]);
});

test("a failing provider fails the request without trying another model", async () => {
  upstreamCalls.length = 0;
  failingModels.add("model-a");
  try {
    const response = await chat({ model: "dari/routing", content: "please fail" });
    expect(response.status).toBe(502);
    await response.text();
    expect(upstreamCalls.map((call) => call.model)).toEqual(["model-a"]);
  } finally {
    failingModels.delete("model-a");
  }
});

test("an explicit model is served without selection", async () => {
  const response = await chat({ model: "dari/model/local/model-b" });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-dari-selected-model")).toBe("local/model-b");
});

test("the next turn of a conversation keeps its conversation id", async () => {
  const first = await chat({ model: "dari/routing", content: "remember me" });
  const conversationId = first.headers.get("x-dari-conversation-id");
  expect(conversationId).toBeTruthy();
  await first.text();
  const second = await chat({
    model: "dari/routing",
    messages: [
      { role: "user", content: "remember me" },
      { role: "assistant", content: "served by model-a" },
      { role: "user", content: "and again" },
    ],
  });
  expect(second.status).toBe(200);
  expect(second.headers.get("x-dari-conversation-id")).toBe(conversationId);
});

test("anthropic messages and openai responses share the router", async () => {
  const messages = await fetch(`${baseUrl}/solo/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": "gw-key-2", "content-type": "application/json" },
    body: JSON.stringify({
      model: "dari/routing",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  expect(messages.status).toBe(200);
  const message = await messages.json() as { content: { type: string; text: string }[] };
  expect(message.content).toEqual([{ type: "text", text: "served by model-b" }]);

  const responses = await fetch(`${baseUrl}/solo/v1/responses`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify({ model: "dari/routing", input: "hello" }),
  });
  expect(responses.status).toBe(200);
  const response = await responses.json() as { output_text?: string; output: unknown[] };
  expect(JSON.stringify(response.output)).toContain("served by model-b");
});

test("unknown keys and routers are refused", async () => {
  const badKey = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer wrong", "content-type": "application/json" },
    body: JSON.stringify({ model: "dari/routing", messages: [{ role: "user", content: "hi" }] }),
  });
  expect(badKey.status).toBe(401);

  const missing = await fetch(`${baseUrl}/nope/v1/chat/completions`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify({ model: "dari/routing", messages: [{ role: "user", content: "hi" }] }),
  });
  expect(missing.status).toBe(404);

  const subscriptions = await fetch(`${baseUrl}/v1/organizations/current/credentials`);
  expect(subscriptions.status).toBe(401);
});

test("subscription routes list connected subscriptions for the gateway key", async () => {
  const response = await fetch(`${baseUrl}/v1/organizations/current/credentials`, {
    headers: authorized(),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ credentials: [], autorouting_allowed: true });
});

test("a provider key the provider rejects stops the gateway from starting", async () => {
  const rejected = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
    env: {
      PATH: process.env.PATH ?? "",
      DARI_GATEWAY_KEYS: "gw-key-1",
      DARI_GATEWAY_CONFIG: configPath,
      DARI_GATEWAY_DB: join(dir, "rejected.db"),
      LOCAL_API_KEY: "revoked",
      PORT: String(await freePort()),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await rejected.exited).toBe(1);
  const stderr = await new Response(rejected.stderr as ReadableStream).text();
  expect(stderr).toContain("Provider API keys were rejected: local (401)");
  expect(stderr).not.toContain("revoked");
});

// `dari gateway models` saves lists through this API. A saved list is served
// at once in place of the config file's, and removing it serves the file's
// again.
test("model lists saved through the API are served until they are removed", async () => {
  const lists = (path: string, method = "GET", models?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: authorized(),
      ...(models === undefined ? {} : { body: JSON.stringify({ models }) }),
    });
  const offered = async (agent?: string, path = "/v1/models") => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { ...authorized(), ...(agent === undefined ? {} : { "x-dari-client-harness": agent }) },
    });
    return (await response.json() as { models: { slug: string }[] }).models.map((model) => model.slug);
  };
  const configured = {
    models: [{ id: "local/model-a", thinking: ["off"] }, { id: "local/model-b", thinking: ["off"] }],
    agent_models: {},
    chosen: true,
  };
  expect(await (await lists("/v1/router/models")).json()).toEqual(configured);

  try {
    const codex = await lists("/v1/router/models/codex", "PUT", ["local/model-b"]);
    expect(codex.status).toBe(200);
    expect(await codex.json()).toEqual({ ...configured, agent_models: { codex: [{ id: "local/model-b" }] } });
    expect(await offered("codex")).toEqual(["dari/model/local/model-b"]);
    expect(await offered()).toEqual(["dari/model/local/model-a", "dari/model/local/model-b"]);

    expect((await lists("/v1/router/models", "PUT", [{ id: "local/model-c", thinking: ["off"] }])).status).toBe(200);
    expect(await offered()).toEqual(["dari/model/local/model-c"]);
    expect(await offered("codex")).toEqual(["dari/model/local/model-b"]);
    // Each router keeps its own lists.
    expect(await offered(undefined, "/solo/v1/models")).toEqual(["dari/model/local/model-b"]);
    expect((await lists("/solo/v1/router/models", "PUT", ["local/model-a"])).status).toBe(200);
    expect(await offered(undefined, "/solo/v1/models")).toEqual(["dari/model/local/model-a"]);

    // A list the config file would refuse is refused here too, and saves nothing.
    for (const [path, models, status] of [
      ["/v1/router/models", [], 400],
      ["/v1/router/models/codex", ["model-b"], 400],
      ["/v1/router/models/cursor", ["local/model-a"], 404],
      ["/missing/v1/router/models", ["local/model-a"], 404],
    ] as const) {
      expect((await lists(path, "PUT", models)).status).toBe(status);
    }
    const unauthorized = await fetch(`${baseUrl}/v1/router/models`, {
      method: "PUT",
      headers: { authorization: "Bearer not-a-key", "content-type": "application/json" },
      body: JSON.stringify({ models: ["local/model-a"] }),
    });
    expect(unauthorized.status).toBe(401);
    expect(await offered()).toEqual(["dari/model/local/model-c"]);
    expect(await offered("codex")).toEqual(["dari/model/local/model-b"]);
  } finally {
    for (const path of ["/v1/router/models", "/v1/router/models/codex", "/solo/v1/router/models"]) {
      await lists(path, "DELETE");
    }
  }
  expect(await (await lists("/v1/router/models")).json()).toEqual(configured);
  expect(await offered("codex")).toEqual(["dari/model/local/model-a", "dari/model/local/model-b"]);
});

// The CLI's model picker offers Dari's canonical models, under Dari's names.
test("the canonical models are listed for the model picker", async () => {
  const response = await fetch(`${baseUrl}/v1/canonical-models`, { headers: authorized() });
  expect(response.status).toBe(200);
  const { data } = await response.json() as { data: { id: string; name: string; thinking_levels: string[] }[] };
  expect(data.length).toBeGreaterThan(0);
  for (const model of data) {
    expect(model).toEqual({
      id: expect.stringMatching(/^[a-z0-9.-]+\/\S+$/),
      name: expect.any(String),
      thinking_levels: expect.any(Array),
    });
  }
});

// The CLI's first launch on a local gateway offers its model picker until
// someone has chosen models.
test("without a config file the gateway serves default models nobody chose", async () => {
  const port = await freePort();
  const unconfigured = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
    cwd: mkdtempSync(join(tmpdir(), "dari-gateway-empty-")),
    env: { PATH: process.env.PATH ?? "", DARI_GATEWAY_KEYS: "gw-key-1", DARI_GATEWAY_DB: ":memory:", PORT: String(port) },
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    await waitForLine(unconfigured.stdout as ReadableStream<Uint8Array>, "dari-gateway listening");
    const url = `http://127.0.0.1:${port}/v1/router/models`;
    const defaults = await (await fetch(url, { headers: authorized() })).json() as {
      models: { id: string }[];
      chosen: boolean;
    };
    expect(defaults.models[0]).toEqual({ id: "anthropic/claude-sonnet-5-5" });
    expect(defaults.chosen).toBe(false);

    const chosen = await fetch(url, {
      method: "PUT",
      headers: authorized(),
      body: JSON.stringify({ models: ["anthropic/claude-sonnet-5-5"] }),
    });
    expect(await chosen.json()).toMatchObject({ chosen: true });
  } finally {
    unconfigured.kill();
    await unconfigured.exited;
  }
});

test("a config path that does not exist stops the gateway from starting", async () => {
  const missing = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
    env: {
      PATH: process.env.PATH ?? "",
      DARI_GATEWAY_KEYS: "gw-key-1",
      DARI_GATEWAY_CONFIG: join(dir, "missing.yaml"),
      DARI_GATEWAY_DB: ":memory:",
      PORT: String(await freePort()),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await missing.exited).toBe(1);
  expect(await new Response(missing.stderr as ReadableStream).text()).toContain("Gateway config not found");
});

test("with Dari Auto Routing a policy lease holds its model and counts down", async () => {
  // Only the first selection leases model-b; any later one (the gateway
  // prefetches the next lease while holding) would pick model-a.
  let selections = 0;
  const autoRouter = Bun.serve({
    port: 0,
    fetch() {
      selections += 1;
      return Response.json(selections === 1
        ? { selected_model: "local/model-b", reasoning_effort: "off", reason: "Leased.", lease_turns_remaining: 2 }
        : { selected_model: "local/model-a", reasoning_effort: "off", reason: "Next." });
    },
  });
  const port = await freePort();
  const leased = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
    env: {
      PATH: process.env.PATH ?? "",
      DARI_GATEWAY_KEYS: "gw-key-1",
      DARI_GATEWAY_CONFIG: configPath,
      DARI_GATEWAY_DB: join(dir, "leased.db"),
      DARI_AUTO_ROUTING_API_KEY: "dari-key",
      DARI_AUTO_ROUTING_URL: `http://127.0.0.1:${autoRouter.port}/v1/auto-router`,
      LOCAL_API_KEY: "local-secret",
      PORT: String(port),
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    await waitForLine(leased.stdout as ReadableStream<Uint8Array>, "dari-gateway listening");
    const messages: { role: string; content: string }[] = [{ role: "user", content: "start a long task" }];
    const turn = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: authorized(),
        body: JSON.stringify({ model: "dari/routing", messages }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { choices: { message: { content: string } }[] };
      messages.push({ role: "assistant", content: body.choices[0]!.message.content });
      messages.push({ role: "user", content: "continue" });
      return {
        model: response.headers.get("x-dari-selected-model"),
        lease: response.headers.get("x-dari-lease-turns-remaining"),
      };
    };
    const first = await turn();
    const second = await turn();
    expect(first).toEqual({ model: "local/model-b", lease: "2" });
    expect(second).toEqual({ model: "local/model-b", lease: "1" });
    // Once the lease runs out the policy chooses again.
    const served = [(await turn()).model, (await turn()).model];
    expect(served).toContain("local/model-a");
  } finally {
    leased.kill();
    await leased.exited;
    await autoRouter.stop(true);
  }
});

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  return port!;
}

async function waitForLine(stream: ReadableStream<Uint8Array>, marker: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`Gateway exited before "${marker}":\n${output}`);
    output += decoder.decode(value);
  }
  reader.releaseLock();
  // Keep draining so request logs never block the child on a full pipe.
  void stream.pipeTo(new WritableStream());
}

function authorized(): Record<string, string> {
  return { authorization: "Bearer gw-key-1", "content-type": "application/json" };
}

function chat(args: {
  model: string;
  content?: string;
  messages?: { role: string; content: string }[];
}): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authorized(),
    body: JSON.stringify({
      model: args.model,
      messages: args.messages ?? [{ role: "user", content: args.content ?? "hello" }],
    }),
  });
}

function completionResponse(model: string, stream: boolean): Response {
  const text = `served by ${model}`;
  const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
  if (!stream) {
    return Response.json({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage,
    });
  }
  const chunks = [
    { choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage },
  ].map((chunk) => `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model, ...chunk })}\n\n`);
  return new Response(`${chunks.join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}
