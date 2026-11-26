import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostedConnectionFromEnv, hostedRouters } from "./connected.js";
import { HostedSync } from "./hosted_sync.js";
import { secretBoxFromEnv } from "./secret_box.js";
import { anthropicReply, codexReply } from "./stub_gateway.js";
import { SubscriptionStore } from "./subscriptions/index.js";

// A connected gateway as its own process, against one stand-in for hosted
// Dari, Anthropic, and the Codex backend.
const HOSTED_KEY = "dari-user-key";
const SESSION_ID = crypto.randomUUID();
const SONNET = "anthropic/claude-sonnet-5-5";
const GPT = "openai/gpt-6.2-astra";
const OPUS = "anthropic/claude-opus-5-5";
const SOL = "openai/gpt-6.1-sol";
type HostedCall = {
  method: string;
  path: string;
  authorization: string | null;
  apiKey: string | null;
  headers: Record<string, string>;
  body: string;
};
// A subagent's request, as Claude Code marks it.
const SUBAGENT = {
  "x-claude-code-request-class": "subagent",
  "x-claude-code-agent-id": "agent-1",
  "x-claude-code-parent-agent-id": "agent-0",
  "x-claude-code-agent-type": "Explore",
};
const ROLE_PROMPT = "Delegate exploration to subagents.";
const providerBodies: string[] = [];
const hostedCalls: HostedCall[] = [];
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
        providerBodies.push(await request.text());
        return anthropicReply();
      }
      if (pathname === "/backend-api/codex/responses") {
        providerTokens.push((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
        return codexReply("gpt-6.2-astra");
      }
      // The plan's usage, which it reports none of.
      if (pathname.startsWith("/backend-api/")) return Response.json({});
      hostedCalls.push({
        method: request.method,
        path: pathname,
        authorization: request.headers.get("authorization"),
        apiKey: request.headers.get("x-api-key"),
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      if (pathname === "/v1/gateway/routers/rtr_1") {
        return Response.json({
          models: [
            { id: SONNET, thinking: null, sources: ["plan", "key"] },
            { id: GPT, thinking: ["low", "high"], sources: ["plan", "key"] },
            { id: OPUS, thinking: null, sources: ["managed"] },
            { id: SOL, thinking: null, sources: ["managed"] },
          ],
          reset_min_hours: 24,
          native_compaction: true,
          zdr: false,
          session_pinning: false,
          retries: 1,
          role_models: {},
          role_prompts: { subagent: ROLE_PROMPT },
          custom_rules: false,
        });
      }
      if (pathname === "/v1/gateway/routers/rtr_rules") {
        return Response.json({
          models: [{ id: SONNET, thinking: null, sources: ["plan"] }],
          reset_min_hours: 24,
          native_compaction: false,
          zdr: false,
          session_pinning: false,
          retries: 1,
          role_models: {},
          role_prompts: {},
          custom_rules: true,
        });
      }
      // Hosted Dari serving a model it was asked for.
      if (pathname === "/rtr_1/v1/messages") return anthropicReply();
      if (pathname === "/rtr_1/v1/responses") return codexReply("gpt-6.1-sol");
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
  // A private ChatGPT plan: it serves GPT here, and stays off hosted Dari.
  store.connect({
    provider: "openai_codex",
    accessToken: CODEX_PRIVATE_TOKEN,
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

const claudeCode = (model: string, key = "local-key", fields: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  fetch(`${baseUrl}/rtr_1/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "user-agent": "claude-cli/2.1.300 (external, cli)",
      "x-app": "cli",
      "x-claude-code-session-id": SESSION_ID,
      ...headers,
    },
    body: JSON.stringify({ model, max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }], ...fields }),
  });

const hosted = (path: string) => hostedCalls.filter((call) => call.path === path);

const syncedModels = () => hosted("/v1/gateway/requests")
  .flatMap((call) => JSON.parse(call.body).requests)
  .map((request: { row: { selected_model: string } }) => request.row.selected_model);

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
  const response = await claudeCode(`dari/model/${SONNET}`);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("hi");
  expect(providerTokens).toEqual(["sk-ant-oat01-local"]);
  // The router comes from hosted Dari with the user's key.
  expect(hosted("/v1/gateway/routers/rtr_1")[0]!.authorization).toBe(`Bearer ${HOSTED_KEY}`);
  expect(hosted("/rtr_1/v1/messages")).toEqual([]);

  await waitFor(() => hosted("/v1/gateway/requests").length > 0);
  const [sync] = hosted("/v1/gateway/requests");
  expect(sync!.authorization).toBe(`Bearer ${HOSTED_KEY}`);
  const body = JSON.parse(sync!.body);
  expect(body.gateway_id).toBe("gw_test");
  expect(body.requests).toHaveLength(1);
  expect(body.requests[0].row).toMatchObject({ router_id: "rtr_1", selected_model: SONNET });
});

test("sends a model only Dari serves to hosted Dari as that model, with the Dari key and the client's own headers", async () => {
  const response = await claudeCode(`dari/model/${OPUS}`, "local-key", {
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("hi");
  const [served] = hosted("/rtr_1/v1/messages");
  expect(served!.apiKey).toBe(HOSTED_KEY);
  // Hosted Dari tells Claude Code by its own headers, passed on unchanged.
  expect(served!.headers).toMatchObject({
    "x-dari-client-harness": "claude_code",
    "user-agent": "claude-cli/2.1.300 (external, cli)",
    "x-app": "cli",
    "x-claude-code-session-id": SESSION_ID,
  });
  const body = JSON.parse(served!.body);
  expect(body.model).toBe(`dari/model/${OPUS}`);
  expect(body.output_config).toEqual({ effort: "high" });
});

test("serves a private plan, whose requests stay on this computer", async () => {
  const response = await claudeCode(`dari/model/${GPT}`);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("hi");
  expect(providerTokens).toContain(CODEX_PRIVATE_TOKEN);
  // Neither this request nor the one hosted Dari served syncs.
  await Bun.sleep(2_500);
  expect(syncedModels()).toEqual([SONNET]);
});

test("hosted Dari is told what a request it serves is for, and adds the role's prompt itself", async () => {
  const before = hosted("/rtr_1/v1/messages").length;
  expect((await claudeCode(`dari/model/${OPUS}`, "local-key", {}, SUBAGENT)).status).toBe(200);
  const served = hosted("/rtr_1/v1/messages")[before]!;
  // Without these hosted Dari files every request under an unknown class,
  // and a subagent under its parent.
  expect(served.headers).toMatchObject(SUBAGENT);
  // Hosted Dari runs the same router: sent the prompt, it would add it twice.
  expect(served.body).not.toContain(ROLE_PROMPT);

  // A plan on this computer is the provider, so the prompt goes with the call.
  providerBodies.length = 0;
  expect((await claudeCode(`dari/model/${SONNET}`, "local-key", {}, SUBAGENT)).status).toBe(200);
  expect(providerBodies).toHaveLength(1);
  expect(providerBodies[0]).toContain(ROLE_PROMPT);
});

test("a request with OpenAI's web search goes to hosted Dari for an OpenAI model only Dari serves", async () => {
  const response = await fetch(`${baseUrl}/rtr_1/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer local-key", "content-type": "application/json" },
    body: JSON.stringify({ model: `dari/model/${SOL}`, stream: true, input: "hi", tools: [{ type: "web_search" }] }),
  });
  // Codex asks for the search on every turn; refused here, its session fails.
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("hi");
  const [served] = hosted("/rtr_1/v1/responses");
  expect(JSON.parse(served!.body).tools).toEqual([expect.objectContaining({ type: "web_search" })]);
});

test("lists every model of the router itself", async () => {
  const response = await fetch(`${baseUrl}/rtr_1/v1/models`, { headers: { authorization: "Bearer local-key" } });
  expect(response.status).toBe(200);
  const list = await response.json() as { models: Array<{ slug: string }>; remote_compaction: string };
  const slugs = list.models.map((model) => model.slug);
  for (const id of [SONNET, GPT, OPUS]) expect(slugs).toContain(`dari/model/${id}`);
  // The router lets Codex compact natively, as hosted Dari says.
  expect(list.remote_compaction).toBe("v2");
  expect(hosted("/rtr_1/v1/models")).toEqual([]);
});

test("hands hosted every other call with the user's Dari key", async () => {
  await fetch(`${baseUrl}/rtr_1/v1/dari/git-events`, {
    method: "POST",
    headers: { authorization: "Bearer local-key", "content-type": "application/json" },
    body: "{}",
  });
  expect(hosted("/rtr_1/v1/dari/git-events")[0]!.authorization).toBe(`Bearer ${HOSTED_KEY}`);
});

test("hands hosted Dari a router with custom rules whole, since only it runs them", async () => {
  const response = await fetch(`${baseUrl}/rtr_rules/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": "local-key", "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "dari/routing", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
  expect(await response.json()).toEqual({ served_by: "hosted" });
  expect(hosted("/rtr_rules/v1/messages")[0]!.authorization).toBe(`Bearer ${HOSTED_KEY}`);
});

test("applies the hosted router's settings: ZDR, session pinning, retries, roles", async () => {
  const read = hostedRouters(
    { url: "https://hosted.test", apiKey: "k", gatewayId: "gw", gatewayName: "mac" },
    (async () => Response.json({
      models: [{ id: SONNET, thinking: null, sources: ["plan"] }, { id: OPUS, thinking: null, sources: ["managed"] }],
      reset_min_hours: 6,
      native_compaction: false,
      zdr: true,
      session_pinning: true,
      retries: 0,
      role_models: { main: null, subagent: SONNET },
      role_prompts: { main: "Delegate.", subagent: null },
      custom_rules: false,
    })) as unknown as typeof fetch,
  );
  const { config, customRules } = await read("rtr_x");
  expect(customRules).toBe(false);
  expect(config).toMatchObject({
    zdr: true,
    sessionPinning: true,
    retries: 0,
    resetMinHours: 6,
    roleModels: { subagent: SONNET },
    rolePrompts: { main: "Delegate." },
  });
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

// A ChatGPT access token is a JWT naming its account; the stand-in is unsigned.
const CODEX_PRIVATE_TOKEN = ["e30", Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct" },
})).toString("base64url"), "private"].join(".");

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
