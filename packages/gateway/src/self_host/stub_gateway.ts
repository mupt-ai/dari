/**
 * A self-hosted gateway on stand-in plans, for testing an app's Dari Link
 * integration without a real subscription or any paid call. It needs Bun.
 *
 * From a Bun test:
 *
 * ```ts
 * import { startStubGateway } from "@mupt-ai/dari-gateway/self_host/stub_gateway";
 * const gateway = await startStubGateway({ plans: ["openai_codex"] });
 * // Your app's Dari Link settings in the test: gateway.app.
 * // The user clicks Connect with Dari and approves:
 * const { code, codeVerifier } = await gateway.connect();
 * // Send them to your server as your page does; then gateway.calls; await gateway.stop();
 * ```
 *
 * From any other test runner, as a process (`dari-gateway-stub`, see
 * stub_main.ts): it prints one JSON line with the same fields and serves the
 * recorded calls at `GET <controlUrl>/served`.
 *
 * `gateway.app` is a server app registered on the gateway (a confidential
 * client: `gatewayUrl`, `clientId`, `clientSecret`, `redirectUri`), and
 * `gateway.connect()` (or `POST <controlUrl>/connect`) is its user approving
 * it: it resolves with what `DariLink.open` hands your page, `{code,
 * codeVerifier, state}`, or rejects with the `LinkError` it would (`deny`).
 * `clients`, `plans`, `keyProviders`, `allowPooling`, and `grantId` are `DariLink.open`'s.
 *
 * To drive an approval for an app you registered yourself:
 * `gateway.approve(authorizeUrl)` (or `POST <controlUrl>/approve` with
 * `{"url"}`) opens the approval page as the user who connected the stand-in
 * plans, keeps the plans the page ticks (or ticks `credentialIds`), approves (or
 * denies with `deny`), and returns what the page hands the app:
 * `{message, targetOrigin}`, the `web_message` post or the redirect's query.
 * Each lands in `gateway.messages` and `GET <controlUrl>/messages`.
 *
 * Error states on demand: `gateway.setState({...})` (or `POST
 * <controlUrl>/state`): `limited: true` holds every plan at its usage limit
 * for an hour at once (`plans[].state` `plan_limit` with `available_at`) and
 * makes every provider call a usage-limit refusal, so Link requests get 424
 * `subscription_exhausted`; `limited: false` (or a state without it) clears it; `five_hour` and `weekly` (0 to 1) are the plan
 * usage each default reply reports, which fills `plans[].usage`. A grant's
 * token budget, once its replies' tokens reach it, leads to 424
 * `grant_budget_exhausted`.
 *
 * API keys: `keys: ["anthropic", "openai", "openrouter"]` gives the plans'
 * user an API key for each (`stub-key-<provider>`, ids in `gateway.keyIds`),
 * which `approve` ticks like a plan. Their calls go to the stand-in too: an
 * OpenAI or OpenRouter key's as chat completions, so a grant on an OpenRouter
 * key can be asked for any `openrouter/<id>` model.
 *
 * The gateway runs through its own entrypoint as a separate process, with
 * connected plans whose provider calls go to a local stand-in: Claude Code
 * plans (access tokens `sk-ant-oat01-a`, `-b`, ...) to a stand-in Anthropic,
 * and ChatGPT plans to a stand-in Codex backend. `upstream` answers each
 * provider call; by default every call gets a short streamed "hi". `calls`
 * records what each provider call carried, and `served` just its plan token.
 */
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

import { authorizeUrl, LinkError } from "../link/client.js";
import { linkUserCookie } from "../link/endpoints.js";
import type { SubscriptionKind } from "../types.js";
import { SqliteLinkStore } from "../link/sqlite_store.js";
import { CANONICAL_MODELS } from "../models/canonical.js";
import { secretBoxFromEnv } from "./secret_box.js";
import { SubscriptionStore } from "./subscriptions/index.js";

/** One provider call the gateway made, as the stand-in provider received it. */
export type StubUpstreamCall = {
  // The plan's access token, or the API key.
  token: string;
  // The kind of plan that made the call, or `api_key` for a call on an API key.
  kind: SubscriptionKind | "api_key";
  // For a call on an API key: the provider or gateway the key is for.
  provider?: "anthropic" | "openai" | "openrouter";
  // The provider path, such as `/v1/messages`.
  path: string;
  // The native model the call asks for.
  model: string;
  // The thinking level the call is served at, or null when it names none:
  // OpenAI `reasoning.effort`; for Anthropic, the latest effort marker message
  // on models that take a per-turn effort (their top-level
  // `output_config.effort` stays a fixed "low" to keep the prompt cache), else
  // `output_config.effort`.
  effort: string | null;
  // The call's Anthropic `thinking` or OpenAI `reasoning` settings, or null.
  thinking: unknown;
  // The request headers, lower-cased, without `authorization`.
  headers: Record<string, string>;
};

export type StubGatewayOptions = {
  // One connected plan per entry, in order. Default: one ChatGPT plan.
  plans?: Array<"anthropic_claude_code" | "openai_codex">;
  // An API key of the plans' user for each of these providers. Default: none.
  keys?: Array<"anthropic" | "openai" | "openrouter">;
  // Whose the plans are. Default: the approval page's user's (`userCookie`),
  // which serve only the grants that user approves. `"gateway"` connects them
  // as the gateway owner's instead, which serve the gateway key.
  owner?: "link_user" | "gateway";
  // The default router's models, as canonical `provider/model` ids (a
  // `dari/model/` prefix is dropped). Default: Claude Sonnet and GPT-5.5.
  models?: string[];
  upstream?: (call: StubUpstreamCall) => Response;
  // The gateway key. Default: `k`.
  gatewayKey?: string;
  // The gateway's port. Default (or 0): a free one.
  port?: number;
  // Hosts the gateway allows http redirect URIs on (`link.allowHttpRedirectHosts`).
  allowHttpRedirectHosts?: string[];
  // The redirect URI `app` is registered with. Default: `https://app.test/dari/callback`.
  redirectUri?: string;
};

/** A server app on the stub gateway: the settings an app's Dari Link calls take. */
export type StubLinkApp = { gatewayUrl: string; clientId: string; clientSecret: string; redirectUri: string };

export type StubConnectOptions = {
  // The plans and keys the user shares. Default: those the page ticks, every
  // one the app can use (one per provider without `allowPooling`), or in
  // update mode the ones the grant shares now.
  credentialIds?: string[];
  deny?: boolean;
  // As `DariLink.open` takes them.
  clients?: string[];
  plans?: string[];
  keyProviders?: string[];
  allowPooling?: boolean;
  grantId?: string;
};

/** What the approval page handed the app: a `web_message` post, or a redirect's query. */
export type StubLinkMessage = { message: Record<string, string>; targetOrigin: string };

export type StubState = {
  // Every plan is held at its usage limit for an hour, and every provider
  // call is a usage-limit refusal. Unset clears it.
  limited?: boolean;
  // Plan usage each default reply reports, 0 to 1.
  five_hour?: number;
  weekly?: number;
};

export type StubGateway = {
  baseUrl: string;
  gatewayKey: string;
  // The connected plans' ids, in the order of `plans`.
  planIds: string[];
  // The ids of the user's API keys, in the order of `keys`.
  keyIds: string[];
  // The `Cookie` header that makes a request to the approval page the plans' user's.
  userCookie: string;
  // The key the gateway's database is encrypted with (`DARI_GATEWAY_ENCRYPTION_KEY`).
  encryptionKey: string;
  // The plan token of each provider call, in order.
  served: string[];
  // Each provider call, in order.
  calls: StubUpstreamCall[];
  // The stand-in provider, which also answers `GET /served` with `calls`.
  controlUrl: string;
  dbPath: string;
  // What each `approve` handed the app, in order.
  messages: StubLinkMessage[];
  approve(authorizeUrl: string, options?: { credentialIds?: string[]; deny?: boolean }): Promise<StubLinkMessage>;
  // A server app registered on the gateway, and its user approving it: what
  // `DariLink.open` resolves with.
  app: StubLinkApp;
  connect(options?: StubConnectOptions): Promise<{ code: string; codeVerifier: string; state: string }>;
  setState(state: StubState): void;
  stop(): Promise<void>;
};

// The approval page's user who connected the stand-in plans.
const STUB_USER = "stub-user";

export async function startStubGateway(options: StubGatewayOptions = {}): Promise<StubGateway> {
  // A plain stub serves any app: a Claude Code plan serves only Claude Code.
  const kinds = options.plans ?? ["openai_codex"];
  const models = (options.models ?? ["anthropic/claude-sonnet-5-5", "openai/gpt-6.2-astra"]).map((model) => model.replace(/^dari\/model\//, ""));
  const unknown = models.filter((model) => !CANONICAL_MODELS.some((entry) => entry.id === model));
  if (unknown.length > 0) {
    throw new Error(
      `startStubGateway models must be canonical "provider/model" ids, such as "openai/gpt-6.1-sol"; unknown: ${unknown.join(", ")}.`,
    );
  }
  const gatewayKey = options.gatewayKey ?? "k";
  const upstream = options.upstream;
  const served: string[] = [];
  const calls: StubUpstreamCall[] = [];
  const messages: StubLinkMessage[] = [];
  let state: StubState = {};
  // While `limited`: when the forced limit resets.
  let limitedUntil: Date | null = null;
  // Set once the plans are stored.
  let holdPlans: (until: Date | null) => void = () => {};
  // A forced limit holds the plans at once, as a refusal would, until it
  // resets or `limited: false` clears it.
  const setState = (next: StubState) => {
    state = next;
    limitedUntil = next.limited ? new Date(Date.now() + 3_600_000) : null;
    holdPlans(limitedUntil);
  };
  let approve: StubGateway["approve"] = async () => {
    throw new Error("The gateway is not up yet.");
  };
  let connect: StubGateway["connect"] = async () => {
    throw new Error("The gateway is not up yet.");
  };
  const provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/served" && request.method === "GET") return Response.json({ calls });
      if (pathname === "/messages" && request.method === "GET") return Response.json({ messages });
      if (pathname === "/state" && request.method === "POST") {
        setState((await request.json()) as StubState);
        return Response.json({ state });
      }
      if (pathname === "/connect" && request.method === "POST") {
        // No body is the user sharing everything the app can use.
        const body = ((await request.json().catch(() => null)) ?? {}) as {
          credential_ids?: string[];
          deny?: boolean;
          clients?: string[];
          plans?: string[];
          key_providers?: string[];
          allow_pooling?: boolean;
          grant_id?: string;
        };
        try {
          const result = await connect({
            ...(body.credential_ids ? { credentialIds: body.credential_ids } : {}),
            ...(body.deny ? { deny: true } : {}),
            ...(body.clients ? { clients: body.clients } : {}),
            ...(body.plans ? { plans: body.plans } : {}),
            ...(body.key_providers ? { keyProviders: body.key_providers } : {}),
            ...(body.allow_pooling ? { allowPooling: true } : {}),
            ...(body.grant_id ? { grantId: body.grant_id } : {}),
          });
          return Response.json({ code: result.code, code_verifier: result.codeVerifier, state: result.state });
        } catch (error) {
          return Response.json({ error: error instanceof LinkError ? error.code : errorMessage(error) }, { status: 400 });
        }
      }
      if (pathname === "/approve" && request.method === "POST") {
        const body = (await request.json()) as { url: string; credential_ids?: string[]; deny?: boolean };
        try {
          const result = await approve(body.url, {
            ...(body.credential_ids ? { credentialIds: body.credential_ids } : {}),
            ...(body.deny ? { deny: true } : {}),
          });
          return Response.json({ message: result.message, target_origin: result.targetOrigin });
        } catch (error) {
          return Response.json({ error: errorMessage(error) }, { status: 400 });
        }
      }
      // A provider key check (list models): the operator's stand-in keys are good.
      if (pathname.endsWith("/models") && request.method === "GET") return Response.json({ data: [] });
      // The Codex usage report: a fresh plan, nothing used.
      if (pathname.endsWith("/wham/usage")) {
        return Response.json({ rate_limit: { primary_window: { used_percent: 0, reset_at: null } } });
      }
      // Only streamed HTTP calls: a WebSocket attempt falls back to them.
      if (request.method !== "POST") return new Response(null, { status: 404 });
      const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const chat = pathname.endsWith("/chat/completions");
      // A plan signs in with a bearer token; an Anthropic API key goes in x-api-key.
      const token = bearer || request.headers.get("x-api-key") || "";
      served.push(token);
      // The Codex transport sends zstd-compressed bodies.
      const bytes = new Uint8Array(await request.arrayBuffer());
      const text = request.headers.get("content-encoding") === "zstd"
        ? zstdDecompressSync(bytes).toString("utf8")
        : new TextDecoder().decode(bytes);
      const body = JSON.parse(text) as {
        model?: string;
        thinking?: unknown;
        reasoning?: { effort?: unknown };
        output_config?: { effort?: unknown };
        messages?: unknown;
      };
      const kind: StubUpstreamCall["kind"] = pathname.includes("/codex/")
        ? "openai_codex"
        : chat || bearer === ""
          ? "api_key"
          : "anthropic_claude_code";
      const effort = effortMarker(body.messages) ?? body.output_config?.effort ?? body.reasoning?.effort;
      const headers = Object.fromEntries(request.headers);
      delete headers.authorization;
      delete headers["x-api-key"];
      const call: StubUpstreamCall = {
        token,
        kind,
        ...(kind === "api_key"
          ? { provider: pathname.startsWith("/openrouter/") ? "openrouter" as const : pathname.startsWith("/openai/") ? "openai" as const : "anthropic" as const }
          : {}),
        path: pathname,
        model: body.model ?? "",
        effort: typeof effort === "string" ? effort : null,
        thinking: body.thinking ?? body.reasoning ?? null,
        headers,
      };
      calls.push(call);
      if (upstream !== undefined) return upstream(call);
      if (chat) return chatReply(call.model);
      const plan: SubscriptionKind = kind === "openai_codex" ? kind : "anthropic_claude_code";
      if (limitedUntil !== null) return limitRefusal(plan, limitedUntil);
      return stubReply(plan, call.model, usageHeaders(plan, state));
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "dari-stub-gateway-"));
  const dbPath = join(dir, "gateway.db");
  const encryptionKey = randomBytes(32).toString("base64");
  const secrets = secretBoxFromEnv(encryptionKey);
  const store = new SubscriptionStore(new Database(dbPath), secrets);
  const expiresAt = new Date(Date.now() + 86_400_000);
  const planIds = kinds.map((kind, index) => {
    const letter = String.fromCharCode(97 + index);
    const accessToken = kind === "openai_codex" ? codexToken(`acct_${letter}`) : `sk-ant-oat01-${letter}`;
    return store.connect({
      provider: kind,
      accessToken,
      refreshToken: `refresh-${letter}`,
      expiresAt,
      accountId: kind === "openai_codex" ? `acct_${letter}` : null,
      accountEmail: `${letter}@example.com`,
    }, null, new Date(), options.owner === "gateway" ? null : STUB_USER)!.id;
  });
  holdPlans = (until) => {
    for (const id of planIds) {
      if (until === null) store.markAvailable(store.get(id)!.name, new Date(), options.owner === "gateway" ? null : STUB_USER);
      else store.markUnavailable(id, until, "The stub gateway's forced usage limit.");
    }
  };
  const keys = options.keys ?? [];
  const links = new SqliteLinkStore(new Database(dbPath), secrets);
  const keyIds = keys.map((key) => links.addKey(STUB_USER, key, `stub-key-${key}`).id);
  const stubUrl = `http://127.0.0.1:${provider.port}`;
  const configPath = join(dir, "dari-gateway.yaml");
  writeFileSync(configPath, `
routers:
  default:
    models: [${models.join(", ")}]
providers:
  anthropic:
    baseUrl: ${stubUrl}
    api: anthropic-messages
    apiKeyEnv: STUB_ANTHROPIC_API_KEY
  openai:
    baseUrl: ${stubUrl}/openai
    apiKeyEnv: STUB_OPENAI_API_KEY
  openai-codex:
    baseUrl: ${stubUrl}/backend-api
${keys.filter((key) => key === "openrouter").map((key) => `  ${key}:\n    baseUrl: ${stubUrl}/${key}\n    apiKeyEnv: STUB_${key.toUpperCase().replaceAll("-", "_")}_API_KEY\n`).join("")}${options.allowHttpRedirectHosts?.length ? `link:\n  allowHttpRedirectHosts: [${options.allowHttpRedirectHosts.map((host) => JSON.stringify(host)).join(", ")}]\n` : ""}`);
  // 0, like none, is a free one.
  const port = options.port || await freePort();
  const sessionSecret = randomBytes(32).toString("base64url");
  // The gateway's own entrypoint, beside this file as source or as built.
  const entrypoint = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./main.ts" : "./main.js", import.meta.url));
  // The gateway exits once its stdin closes: when this process dies, however
  // it dies, the gateway goes with it.
  const child = `process.stdin.on("end", () => process.exit(0)).resume(); `
    + `await (await import(${JSON.stringify(entrypoint)})).runSelfHostedGateway();`;
  const gateway = Bun.spawn([process.execPath, "-e", child], {
    env: {
      PATH: process.env.PATH ?? "",
      DARI_GATEWAY_KEYS: gatewayKey,
      DARI_GATEWAY_CONFIG: configPath,
      DARI_GATEWAY_DB: dbPath,
      DARI_LINK_SESSION_SECRET: sessionSecret,
      DARI_GATEWAY_ENCRYPTION_KEY: encryptionKey,
      // The operator's own keys for the stand-in providers.
      ...Object.fromEntries(["anthropic", "openai", ...keys].map((key) => [`STUB_${key.toUpperCase().replaceAll("-", "_")}_API_KEY`, "stub-operator-key"])),
      PORT: String(port),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const killGateway = () => gateway.kill();
  process.on("exit", killGateway);
  const stderr = echo(gateway.stderr as ReadableStream<Uint8Array>);
  try {
    await waitForLine(gateway.stdout as ReadableStream<Uint8Array>, "dari-gateway listening");
  } catch {
    await gateway.exited;
    await provider.stop(true);
    throw new Error(`The stub gateway did not start:\n${(await stderr).trim()}`);
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  const userCookie = linkUserCookie(sessionSecret, STUB_USER);
  approve = async (authorizeUrl, approveOptions = {}) => {
    const result = await driveApproval(baseUrl, userCookie, authorizeUrl, approveOptions);
    messages.push(result);
    return result;
  };
  const registered = await fetch(`${baseUrl}/v1/link/apps`, {
    method: "POST",
    headers: { authorization: `Bearer ${gatewayKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Stub App",
      redirect_uris: [options.redirectUri ?? "https://app.test/dari/callback"],
      confidential: true,
    }),
  });
  if (!registered.ok) throw new Error(`The stub app was not registered:\n${await registered.text()}`);
  const { client_id: clientId, client_secret: clientSecret } = (await registered.json()) as { client_id: string; client_secret: string };
  const app: StubLinkApp = {
    gatewayUrl: baseUrl,
    clientId,
    clientSecret,
    redirectUri: options.redirectUri ?? "https://app.test/dari/callback",
  };
  connect = async ({ credentialIds, deny, ...request } = {}) => {
    const { url, codeVerifier, state } = await authorizeUrl({ ...app, ...request, responseMode: "web_message" });
    const { message } = await approve(url, { ...(credentialIds ? { credentialIds } : {}), ...(deny ? { deny } : {}) });
    if (message.code === undefined) {
      throw new LinkError(message.error ?? "invalid_request", message.error_description ?? "Dari Link was not approved.", 0);
    }
    return { code: message.code, codeVerifier, state };
  };
  return {
    baseUrl,
    gatewayKey,
    planIds,
    keyIds,
    userCookie,
    encryptionKey,
    served,
    calls,
    controlUrl: stubUrl,
    dbPath,
    messages,
    approve: (url, approveOptions) => approve(url, approveOptions),
    app,
    connect: (connectOptions) => connect(connectOptions),
    setState,
    stop: async () => {
      process.off("exit", killGateway);
      gateway.kill();
      await gateway.exited;
      await provider.stop(true);
    },
  };
}

// The approval page as the plans' user goes through it: keep the plans it
// ticks (or tick the given ones), approve or deny; then what the page hands the app.
async function driveApproval(
  baseUrl: string,
  cookie: string,
  authorizeUrl: string,
  options: { credentialIds?: string[]; deny?: boolean },
): Promise<StubLinkMessage> {
  const url = new URL(authorizeUrl);
  const page = `${baseUrl}${url.pathname}${url.search}`;
  const params = [...url.searchParams];
  const choose = await (await fetch(page, { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(choose)?.[1];
  if (csrf === undefined) {
    throw new Error(
      "The approval page offers this app nothing to approve: none of the stub user's plans or keys serves it. "
        + 'A Claude Code plan serves only an app that asks for clients: ["claude_code"].',
    );
  }
  const ticked = [...choose.matchAll(/name="credential_id" value="([^"]+)"[^>]* checked>/g)].map((match) => match[1]!);
  const decided = await fetch(`${baseUrl}${url.pathname}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie },
    body: new URLSearchParams([
      ...params,
      ["csrf", csrf],
      ["decision", options.deny ? "deny" : "approve"],
      ...(options.credentialIds ?? ticked).map((id) => ["credential_id", id]),
    ]),
  });
  const location = decided.headers.get("location");
  if (location !== null) {
    const back = new URL(location);
    return { message: { type: "dari-link", ...Object.fromEntries(back.searchParams) }, targetOrigin: back.origin };
  }
  const html = await decided.text();
  const posted = /const \[message, origin(?:, fallback)?\] = (.+);\n/.exec(html)?.[1];
  if (posted === undefined) throw new Error(`The approval did not return to the app:\n${html}`);
  const [message, targetOrigin] = JSON.parse(posted) as [Record<string, string>, string];
  return { message, targetOrigin };
}

// A usage-limit refusal in the plan's provider protocol, resetting at `until`.
function limitRefusal(kind: SubscriptionKind, until: Date): Response {
  const reset = String(Math.floor(until.getTime() / 1000));
  if (kind === "openai_codex") {
    return Response.json(
      { error: { type: "usage_limit_reached", code: "usage_limit_reached", message: "The usage limit has been reached", resets_at: Number(reset) } },
      { status: 429 },
    );
  }
  return Response.json(
    { type: "error", error: { type: "rate_limit_error", message: "usage limit" } },
    {
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": reset,
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
      },
    },
  );
}

// The plan usage a reply reports, in the plan's provider headers.
function usageHeaders(kind: SubscriptionKind, state: StubState): Record<string, string> {
  const windows: Array<[number | undefined, string, string, number]> = [
    [state.five_hour, "5h", "primary", 300],
    [state.weekly, "7d", "secondary", 10080],
  ];
  const headers: Record<string, string> = {};
  for (const [used, claude, codex, minutes] of windows) {
    if (used === undefined) continue;
    const reset = String(Math.floor(Date.now() / 1000) + minutes * 60);
    if (kind === "openai_codex") {
      headers[`x-codex-${codex}-used-percent`] = String(used * 100);
      headers[`x-codex-${codex}-reset-at`] = reset;
      headers[`x-codex-${codex}-window-minutes`] = String(minutes);
    } else {
      headers[`anthropic-ratelimit-unified-${claude}-utilization`] = String(used);
      headers[`anthropic-ratelimit-unified-${claude}-reset`] = reset;
    }
  }
  return headers;
}

/** A short streamed reply in the plan's provider protocol. */
export function stubReply(kind: SubscriptionKind, model: string, headers: Record<string, string> = {}): Response {
  return kind === "openai_codex" ? codexReply(model, headers) : anthropicReply(headers);
}

/** A streamed Anthropic reply with the given response headers. */
export function anthropicReply(headers: Record<string, string> = {}): Response {
  return sse([
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ], headers);
}

/** A streamed OpenAI chat completions reply, as an OpenAI or gateway API key gets. */
export function chatReply(model: string): Response {
  const chunk = (fields: Record<string, unknown>) =>
    `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model, ...fields })}\n\n`;
  const text = [
    chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    chunk({ choices: [], usage: { prompt_tokens: 14, completion_tokens: 2, total_tokens: 16 } }),
    "data: [DONE]\n\n",
  ].join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

/** A streamed Codex backend (OpenAI Responses) reply. */
export function codexReply(model: string, headers: Record<string, string> = {}): Response {
  const message = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "hi", annotations: [] }],
  };
  const response = { id: "resp_1", object: "response", model, status: "in_progress", output: [] };
  return sse([
    { type: "response.created", sequence_number: 0, response },
    { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", sequence_number: 2, output_index: 0, item_id: "msg_1", content_index: 0, delta: "hi" },
    { type: "response.output_item.done", sequence_number: 3, output_index: 0, item: message },
    {
      type: "response.completed",
      sequence_number: 4,
      response: {
        ...response,
        status: "completed",
        output: [message],
        // The Responses API counts cached tokens inside input_tokens.
        usage: { input_tokens: 14, input_tokens_details: { cached_tokens: 4 }, output_tokens: 2, total_tokens: 16 },
      },
    },
  ], headers);
}

function sse(events: Array<Record<string, unknown>>, headers: Record<string, string>): Response {
  const text = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { headers: { "content-type": "text/event-stream", ...headers } });
}

// A ChatGPT access token is a JWT naming its account; the stand-in is unsigned.
function codexToken(accountId: string): string {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: accountId } };
  return ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  return port!;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Copy the gateway's stderr to this process's, and resolve with all of it once it closes.
async function echo(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of stream) {
    process.stderr.write(chunk);
    output += decoder.decode(chunk, { stream: true });
  }
  return output;
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

// Anthropic models with a per-turn effort carry it in system messages with
// `output_config.effort`; the latest one is the level this call is served at.
function effortMarker(messages: unknown): unknown {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; output_config?: { effort?: unknown } } | null;
    if (message?.role === "system" && message.output_config?.effort !== undefined) return message.output_config.effort;
  }
  return undefined;
}
