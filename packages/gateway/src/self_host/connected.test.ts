import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostedConnectionFromEnv } from "./connected.js";
import { HostedSync } from "./hosted_sync.js";
import { secretBoxFromEnv } from "./secret_box.js";
import { anthropicReply } from "./stub_gateway.js";
import { SubscriptionStore } from "./subscriptions/index.js";

// A connected gateway as its own process, against one stand-in for both
// hosted Dari and Anthropic.
const HOSTED_KEY = "dari-user-key";
const SESSION_ID = crypto.randomUUID();
const hostedCalls: Array<{ method: string; path: string; authorization: string | null; body: string }> = [];
const providerTokens: string[] = [];
let stub: ReturnType<typeof Bun.serve>;
let gateway: ReturnType<typeof Bun.spawn>;
let baseUrl: string;
let claudePlan: string;

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/anthropic/")) {
        providerTokens.push((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
        return anthropicReply();
      }
      hostedCalls.push({
        method: request.method,
        path: pathname,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      });
      if (pathname === "/rtr_1/v1/models") {
        return Response.json({
          models: [
            { slug: "dari/routing" },
            { slug: "dari/model/anthropic/claude-sonnet-5-5" },
            { slug: "dari/model/openai/gpt-6.2-astra" },
          ],
        });
      }
      if (pathname === "/v1/gateway/subscriptions") return Response.json({ subscriptions: [] });
      if (pathname === "/v1/gateway/requests") return Response.json({ stored: ["x"], rejected: [] });
      return Response.json({ served_by: "hosted" });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "dari-connected-"));
  const dbPath = join(dir, "gateway.db");
  const encryptionKey = randomBytes(32).toString("base64");
  const store = new SubscriptionStore(new Database(dbPath), secretBoxFromEnv(encryptionKey));
  const expiresAt = new Date(Date.now() + 86_400_000);
  claudePlan = store.connect({
    provider: "anthropic_claude_code",
    accessToken: "sk-ant-oat01-local",
    refreshToken: "r",
    expiresAt,
    accountId: null,
    accountEmail: "me@example.com",
  }, null)!.id;
  // A private ChatGPT plan, which would serve GPT were the gateway not connected.
  store.connect({
    provider: "openai_codex",
    accessToken: "codex-private",
    refreshToken: "r",
    expiresAt,
    accountId: "acct",
    accountEmail: "me@example.com",
  }, null, new Date(), null, true);
  const configPath = join(dir, "dari-gateway.yaml");
  writeFileSync(configPath, `
routers:
  default:
    models: [anthropic/claude-sonnet-5-5]
providers:
  anthropic:
    baseUrl: http://127.0.0.1:${stub.port}/anthropic
    api: anthropic-messages
  openai-codex:
    baseUrl: http://127.0.0.1:${stub.port}/backend-api
`);
  const port = await freePort();
  gateway = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
    env: {
      PATH: process.env.PATH ?? "",
      DARI_GATEWAY_KEYS: "local-key",
      DARI_GATEWAY_CONFIG: configPath,
      DARI_GATEWAY_DB: dbPath,
      DARI_GATEWAY_ENCRYPTION_KEY: encryptionKey,
      DARI_HOSTED_URL: `http://127.0.0.1:${stub.port}`,
      DARI_HOSTED_API_KEY: HOSTED_KEY,
      DARI_GATEWAY_ID: "gw_test",
      DARI_GATEWAY_NAME: "test-mac",
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
  await stub.stop(true);
});

const claudeCode = (model: string, key = "local-key") =>
  fetch(`${baseUrl}/rtr_1/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "user-agent": "claude-cli/2.1.300 (external, cli)",
      "x-app": "cli",
      "x-claude-code-session-id": SESSION_ID,
    },
    body: JSON.stringify({ model, max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });

const hosted = (path: string) => hostedCalls.filter((call) => call.path === path);

test("reports its plans, leaving private ones out, as soon as it starts", async () => {
  await waitFor(() => hosted("/v1/gateway/subscriptions").length > 0);
  const [put] = hosted("/v1/gateway/subscriptions");
  expect(put!.method).toBe("PUT");
  expect(put!.authorization).toBe(`Bearer ${HOSTED_KEY}`);
  const snapshot = JSON.parse(put!.body);
  expect(snapshot).toMatchObject({ gateway_id: "gw_test", gateway_name: "test-mac" });
  expect(snapshot.subscriptions).toEqual([expect.objectContaining({
    local_id: claudePlan,
    provider: "anthropic_claude_code",
    account_email: "me@example.com",
    model_holds: {},
  })]);
});

test("serves a model its plan serves locally and sends the request to hosted Activity", async () => {
  const response = await claudeCode("dari/model/anthropic/claude-sonnet-5-5");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("hi");
  expect(providerTokens).toEqual(["sk-ant-oat01-local"]);
  expect(hosted("/rtr_1/v1/messages")).toEqual([]);

  await waitFor(() => hosted("/v1/gateway/requests").length > 0);
  const [sync] = hosted("/v1/gateway/requests");
  expect(sync!.authorization).toBe(`Bearer ${HOSTED_KEY}`);
  const body = JSON.parse(sync!.body);
  expect(body.gateway_id).toBe("gw_test");
  expect(body.requests).toHaveLength(1);
  expect(body.requests[0].row).toMatchObject({ router_id: "rtr_1", selected_model: "anthropic/claude-sonnet-5-5" });
});

test("hands hosted a model no local plan serves, and every other call, with the user's Dari key", async () => {
  const response = await claudeCode("dari/model/openai/gpt-6.2-astra");
  expect(await response.json()).toEqual({ served_by: "hosted" });
  const [forwarded] = hosted("/rtr_1/v1/messages");
  expect(forwarded!.authorization).toBe(`Bearer ${HOSTED_KEY}`);
  expect(JSON.parse(forwarded!.body).model).toBe("dari/model/openai/gpt-6.2-astra");
  // The private ChatGPT plan never served.
  expect(providerTokens).not.toContain("codex-private");

  await fetch(`${baseUrl}/rtr_1/v1/dari/git-events`, {
    method: "POST",
    headers: { authorization: "Bearer local-key", "content-type": "application/json" },
    body: "{}",
  });
  expect(hosted("/rtr_1/v1/dari/git-events")[0]!.authorization).toBe(`Bearer ${HOSTED_KEY}`);
  // Hosted logs the request it served; the local attempt's row never syncs.
  await Bun.sleep(2_500);
  const synced = hosted("/v1/gateway/requests").flatMap((call) => JSON.parse(call.body).requests);
  expect(synced.map((request: { row: { selected_model: string } }) => request.row.selected_model))
    .toEqual(["anthropic/claude-sonnet-5-5"]);
});

test("forwards nothing for a caller without the gateway key", async () => {
  const before = hostedCalls.length;
  const response = await claudeCode("dari/model/openai/gpt-6.2-astra", "wrong");
  expect(response.status).toBe(401);
  // Claude Code reads the error in Anthropic's shape.
  expect(await response.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
  expect(hostedCalls.length).toBe(before);
});

test("a renamed plan reaches hosted", async () => {
  const before = hosted("/v1/gateway/subscriptions").length;
  const listed = await (await fetch(`${baseUrl}/v1/organizations/current/credentials`, {
    headers: { authorization: "Bearer local-key" },
  })).json() as { credentials: Array<{ name: string; private: boolean; oauth_provider: string }> };
  // The accounts list shows private plans, marked.
  expect(listed.credentials.map((plan) => [plan.oauth_provider, plan.private])).toEqual([
    ["anthropic_claude_code", false],
    ["openai_codex", true],
  ]);
  await fetch(`${baseUrl}/v1/organizations/current/credentials/${listed.credentials[0]!.name}/label`, {
    method: "PUT",
    headers: { authorization: "Bearer local-key", "content-type": "application/json" },
    body: JSON.stringify({ label: "Work" }),
  });
  await waitFor(() => hosted("/v1/gateway/subscriptions").slice(before)
    .some((put) => JSON.parse(put.body).subscriptions[0]?.label === "Work"));
});

test("queued requests wait out a hosted failure and go in batches of 16", async () => {
  let clock = 1_000_000;
  const posts: number[] = [];
  let failing = true;
  const fetchStub = (async (_url: string, init: RequestInit) => {
    posts.push(JSON.parse(String(init.body)).requests.length);
    return failing ? new Response("down", { status: 503 }) : Response.json({ stored: [], rejected: [] });
  }) as unknown as typeof fetch;
  const db = new Database(":memory:");
  const sync = new HostedSync(db, new SubscriptionStore(db), {
    url: "http://hosted.test",
    apiKey: "k",
    gatewayId: "gw",
    gatewayName: "mac",
  }, fetchStub, () => clock);
  for (let index = 0; index < 20; index += 1) sync.enqueue({ request_id: `r${index}` });
  clock += 1_000;
  await sync.drain();
  const failed = posts.length;
  // Nothing is due again until the backoff passes.
  await sync.drain();
  expect(posts.length).toBe(failed);

  failing = false;
  clock += 60_000;
  posts.length = 0;
  await sync.drain();
  expect(posts).toEqual([16, 4]);
  expect(db.query("SELECT COUNT(*) AS n FROM hosted_request_outbox").get()).toEqual({ n: 0 });
});

test("a connected gateway needs its id and encryption key", () => {
  const env = { DARI_HOSTED_URL: "https://routing.dari.dev", DARI_HOSTED_API_KEY: "k" };
  expect(hostedConnectionFromEnv({})).toBeNull();
  expect(() => hostedConnectionFromEnv({ DARI_HOSTED_URL: "https://routing.dari.dev" })).toThrow("DARI_HOSTED_API_KEY");
  expect(() => hostedConnectionFromEnv(env)).toThrow("DARI_GATEWAY_ID");
  expect(() => hostedConnectionFromEnv({ ...env, DARI_GATEWAY_ID: "gw" })).toThrow("DARI_GATEWAY_ENCRYPTION_KEY");
});

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  return port;
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
  void stream.pipeTo(new WritableStream());
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) await Bun.sleep(50);
  expect(condition()).toBe(true);
}
