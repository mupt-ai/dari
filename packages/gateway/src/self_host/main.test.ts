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

test("without a config file the gateway serves the default router", async () => {
  const printConfig = async (env: Record<string, string>, flag = "--print-config") => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "main.ts"), flag], {
      cwd: mkdtempSync(join(tmpdir(), "dari-gateway-empty-")),
      env: { PATH: process.env.PATH ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    return JSON.parse(await new Response(child.stdout as ReadableStream).text());
  };

  const defaults = await printConfig({});
  expect(Object.keys(defaults.routers)).toEqual(["default"]);
  expect(defaults.routers.default.models[0]).toEqual({ id: "anthropic/claude-sonnet-5-5" });
  expect(defaults.routers.default.subscriptions).toBe(true);

  const configured = await printConfig({ DARI_GATEWAY_CONFIG: configPath });
  expect(Object.keys(configured.routers)).toEqual(["default", "solo"]);
  // The built-in default prints whatever config is set.
  expect(await printConfig({ DARI_GATEWAY_CONFIG: configPath }, "--print-default-config")).toEqual(defaults);
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
