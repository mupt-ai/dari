import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { handleSubscriptionRequest } from "./http.js";
import { SubscriptionStore, type ConnectedAccount } from "./store.js";
import { codexAccessToken, fakeFetch, jsonResponse, tokens, type RecordedCall } from "./test_support.js";

const BASE = "http://gateway.test/v1/organizations/current/credentials";
const CLAUDE_USAGE = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";
const now = new Date("2026-10-20T12:00:00Z");

// The JSON tags of the CLI's `subscriptionCredential` struct
// (internal/cli/credentials.go at the repository root), which it decodes from list results.
const CLI_CREDENTIAL_FIELDS = [
  "name",
  "label",
  "safe_metadata",
  "credential_scope",
  "oauth_provider",
  "created_at",
  "last_used_at",
  "unavailable_until",
  "unavailable_reason",
  "model_holds",
  "subscription_active",
  "usage",
  "private",
];

function gateway(
  responses: Array<() => Response> = [],
  hostedAccounts?: () => Promise<ConnectedAccount[]>,
) {
  const store = new SubscriptionStore(new Database(":memory:"));
  const fetch = fakeFetch(responses);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await handleSubscriptionRequest(
      new Request(BASE + path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      }),
      { store, fetch, now: () => now, ...(hostedAccounts === undefined ? {} : { hostedAccounts }) },
    );
    return response === null ? null : { status: response.status, body: (await response.json()) as any };
  };
  return { store, fetch, call };
}

async function connectClaude(g: ReturnType<typeof gateway>, credentialName?: string, isPrivate?: boolean) {
  const started = await g.call("POST", "/oauth/sessions", {
    provider: "anthropic_claude_code",
    ...(credentialName === undefined ? {} : { credential_name: credentialName }),
    ...(isPrivate === undefined ? {} : { private: isPrivate }),
  });
  const state = new URL(started!.body.authorization_url).searchParams.get("state");
  return g.call("POST", "/oauth/sessions/complete", {
    session_token: started!.body.session_token,
    authorization_response: `pasted-code#${state}`,
  });
}

const claudeToken = (email: string) =>
  jsonResponse({ access_token: "sk-ant-oat01-a", refresh_token: "r", expires_in: 3600, account: { email_address: email } });

describe("connecting", () => {
  test("a plan connects private, and moves on and off hosted Dari", async () => {
    const g = gateway([claudeToken("me@example.com")]);
    const connected = await connectClaude(g, undefined, true);
    expect(connected!.body.private).toBe(true);
    const path = `/${connected!.body.name}/private`;
    expect((await g.call("PUT", path, { private: false }))!.body.private).toBe(false);
    expect((await g.call("GET", ""))!.body.credentials[0].private).toBe(false);
    expect((await g.call("PUT", path, { private: "yes" }))!.status).toBe(400);
  });

  test("a reconnected plan keeps its place unless the caller names one", async () => {
    const g = gateway([claudeToken("me@example.com"), claudeToken("me@example.com")]);
    const name = (await connectClaude(g, undefined, true))!.body.name;
    expect((await connectClaude(g, name))!.body.private).toBe(true);
  });

  test("Claude Code start and complete match the CLI's shapes", async () => {
    const g = gateway([claudeToken("me@example.com")]);
    const started = await g.call("POST", "/oauth/sessions", { provider: "anthropic_claude_code" });
    expect(started!.status).toBe(201);
    expect(started!.body).toEqual({
      provider: "anthropic_claude_code",
      session_token: expect.any(String),
      authorization_url: expect.stringMatching(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/),
      expires_at: "2026-10-20T12:15:00.000Z",
      user_code: null,
    });

    const state = new URL(started!.body.authorization_url).searchParams.get("state");
    const completed = await g.call("POST", "/oauth/sessions/complete", {
      session_token: started!.body.session_token,
      authorization_response: `pasted-code#${state}`,
    });
    expect(completed).toEqual({
      status: 200,
      body: {
        id: expect.stringMatching(/^cred_/),
        name: "ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN",
        label: null,
        safe_metadata: { account_email: "me@example.com" },
        credential_scope: "user",
        oauth_provider: "anthropic_claude_code",
        private: false,
        created_at: "2026-10-20T12:00:00.000Z",
        last_used_at: null,
        unavailable_until: null,
        unavailable_reason: null,
        model_holds: [],
        subscription_active: true,
        usage: null,
      },
    });
    expect(JSON.parse((g.fetch.calls as RecordedCall[])[0]!.body).code).toBe("pasted-code");

    // A completed session cannot be replayed.
    const replay = await g.call("POST", "/oauth/sessions/complete", {
      session_token: started!.body.session_token,
      authorization_response: "x",
    });
    expect(replay).toEqual({ status: 400, body: { detail: "Invalid subscription authorization session." } });
  });

  test("ChatGPT device flow reports pending until approved, then connects", async () => {
    const g = gateway([
      jsonResponse({ device_auth_id: "dev-1", user_code: "ABCD-1234" }),
      jsonResponse({}, 403),
      jsonResponse({ authorization_code: "code", code_verifier: "verifier" }),
      jsonResponse({ access_token: codexAccessToken("acct-1"), refresh_token: "rt", expires_in: 3600 }),
    ]);
    const started = await g.call("POST", "/oauth/sessions", { provider: "openai_codex" });
    expect(started!.body).toMatchObject({
      authorization_url: "https://auth.openai.com/codex/device",
      user_code: "ABCD-1234",
    });

    const complete = { session_token: started!.body.session_token, authorization_response: "" };
    const pending = await g.call("POST", "/oauth/sessions/complete", complete);
    expect(pending!.status).toBe(400);
    // The CLI retries on exactly this prefix.
    expect(pending!.body.detail.startsWith("OpenAI approval is still pending.")).toBe(true);

    const approved = await g.call("POST", "/oauth/sessions/complete", complete);
    expect(approved!.body).toMatchObject({
      name: "OPENAI_CODEX_OAUTH_TOKEN",
      oauth_provider: "openai_codex",
      safe_metadata: {},
      subscription_active: true,
    });
    expect(g.store.list("openai_codex")[0]!.accountId).toBe("acct-1");
  });

  test("a sign-in whose account hosted Dari already holds is refused with a 409 that says where it lives", async () => {
    const hosted: ConnectedAccount = {
      provider: "anthropic_claude_code",
      accountId: null,
      accountEmail: "me@example.com",
      place: "dari",
      name: "ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN",
    };
    const g = gateway([claudeToken("me@example.com")], async () => [hosted]);
    const refused = await connectClaude(g);
    expect(refused).toEqual({
      status: 409,
      body: {
        detail: "This Claude account is already connected on Dari as ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN. Run `dari accounts subscription connect` again and choose Move, or disconnect it first.",
      },
    });
    expect(g.store.list()).toHaveLength(0);
  });

  test("moving a hosted plan here signs its account in, though hosted Dari still holds it", async () => {
    const onDari = (name: string): ConnectedAccount => ({
      provider: "anthropic_claude_code",
      accountId: null,
      accountEmail: "me@example.com",
      place: "dari",
      name,
    });
    const move = async (movingFrom: string) => {
      const g = gateway([claudeToken("me@example.com")], async () => [onDari("ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN_2")]);
      const started = await g.call("POST", "/oauth/sessions", { provider: "anthropic_claude_code", moving_from: movingFrom });
      const state = new URL(started!.body.authorization_url).searchParams.get("state");
      return g.call("POST", "/oauth/sessions/complete", {
        session_token: started!.body.session_token,
        authorization_response: `pasted-code#${state}`,
      });
    };
    expect((await move("ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN_2"))!.status).toBe(200);
    // Moving another plan does not excuse a second copy of this one.
    expect((await move("ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN"))!.status).toBe(409);
  });

  test("reconnecting a plan to the account it holds does not read hosted Dari", async () => {
    let read = 0;
    const g = gateway([claudeToken("me@example.com")], async () => {
      read += 1;
      throw new Error("hosted Dari is down");
    });
    g.store.connect(tokens({ accountEmail: "me@example.com" }), null, now);
    expect((await connectClaude(g, "ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN"))!.status).toBe(200);
    expect(read).toBe(0);
  });

  test("a sign-in still connects while hosted Dari cannot be read", async () => {
    const g = gateway([claudeToken("me@example.com")], async () => {
      throw new Error("hosted Dari is down");
    });
    expect((await connectClaude(g))!.status).toBe(200);
    expect(g.store.list().map((c) => c.accountEmail)).toEqual(["me@example.com"]);
  });

  test("reconnect targets the named subscription", async () => {
    const g = gateway([claudeToken("one@example.com"), claudeToken("two@example.com"), claudeToken("three@example.com")]);
    await connectClaude(g);
    await connectClaude(g);
    const reconnected = await connectClaude(g, "ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN");
    expect(reconnected!.body).toMatchObject({
      name: "ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN",
      safe_metadata: { account_email: "three@example.com" },
    });
    expect(g.store.list().map((c) => c.accountEmail)).toEqual(["three@example.com", "two@example.com"]);
  });

  test("bad starts are rejected before contacting the provider", async () => {
    const g = gateway();
    expect(await g.call("POST", "/oauth/sessions", { provider: "gemini" })).toMatchObject({ status: 400 });
    expect(await g.call("POST", "/oauth/sessions", { provider: "openai_codex", credential_name: "MISSING" }))
      .toEqual({ status: 404, body: { detail: 'Unknown subscription credential "MISSING".' } });
    expect(g.fetch.calls).toHaveLength(0);
  });

  test("provider failures are 502s with a detail", async () => {
    const g = gateway([jsonResponse({}, 503)]);
    expect(await g.call("POST", "/oauth/sessions", { provider: "openai_codex" })).toEqual({
      status: 502,
      body: { detail: "OpenAI device code request failed with provider status 503." },
    });
  });
});

describe("managing", () => {
  test("list carries every field the CLI reads, in connection order", async () => {
    const g = gateway([claudeToken("one@example.com"), claudeToken("two@example.com")]);
    await connectClaude(g);
    await connectClaude(g);
    const [first, second] = g.store.list();
    g.store.markUnavailable(first!.id, new Date("2026-10-20T17:00:00Z"), "usage_limit", now);
    g.store.holdModel(second!.id, "anthropic/claude-fable-5", new Date("2026-10-21T12:00:00Z"), "seven day fable", now);

    const listed = await g.call("GET", "");
    expect(listed!.status).toBe(200);
    expect(listed!.body.autorouting_allowed).toBe(true);
    for (const credential of listed!.body.credentials) {
      expect(Object.keys(credential)).toEqual(expect.arrayContaining(CLI_CREDENTIAL_FIELDS));
      expect(credential).not.toHaveProperty("access_token");
    }
    expect(listed!.body.credentials.map((c: any) => [c.name, c.subscription_active, c.unavailable_until])).toEqual([
      ["ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN", false, "2026-10-20T17:00:00.000Z"],
      ["ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN_2", true, null],
    ]);
    expect(listed!.body.credentials[1].model_holds).toEqual([
      {
        model: "anthropic/claude-fable-5",
        display_name: "Claude Fable 5",
        unavailable_until: "2026-10-21T12:00:00.000Z",
        reason: "seven day fable",
      },
    ]);
  });

  test("usage names every window and shows a held plan's window full", async () => {
    const g = gateway([claudeToken("one@example.com")]);
    await connectClaude(g);
    const id = g.store.list()[0]!.id;
    const fiveHours = new Date("2026-10-20T14:00:00Z");
    const week = new Date("2026-10-24T12:00:00Z");
    g.store.recordUsage(id, {
      utilization: 0.4,
      resetsAt: fiveHours,
      windows: [
        { minutes: 300, utilization: 0.4, resetsAt: fiveHours },
        { minutes: 10080, utilization: 0.01, resetsAt: week },
        { modelFamily: "fable", minutes: 10080, utilization: 0.02, resetsAt: new Date("2026-10-23T12:00:00Z") },
      ],
    }, now);
    const windows = async () => (await g.call("GET", ""))!.body.credentials[0].usage.windows
      .map((window: any) => [window.label, window.utilization]);
    expect(await windows()).toEqual([["5 Hour", 0.4], ["Weekly", 0.01], ["Claude Fable Weekly", 0.02]]);

    // The plan's hold fills its weekly window, never the Fable one.
    g.store.markUnavailable(id, week, "usage_limit", now);
    expect(await windows()).toEqual([["5 Hour", 0.4], ["Weekly", 1], ["Claude Fable Weekly", 0.02]]);
  });

  test("rename, mark-available, and disconnect", async () => {
    const g = gateway([claudeToken("one@example.com")]);
    await connectClaude(g);
    const name = "ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN";
    g.store.markUnavailable(g.store.list()[0]!.id, new Date("2026-10-20T17:00:00Z"), "usage_limit", now);

    expect((await g.call("PUT", `/${name}/label`, { label: "Work" }))!.body).toMatchObject({ label: "Work" });
    expect((await g.call("PUT", `/${name}/label`, { label: "x".repeat(121) }))!.status).toBe(400);

    const released = await g.call("POST", `/${name}/mark-available`);
    expect(released!.body).toMatchObject({ unavailable_until: null, unavailable_reason: null, subscription_active: true });

    expect((await g.call("DELETE", `/${name}`))!.status).toBe(400);
    const removed = await g.call("DELETE", `/${name}?scope=user`);
    expect(removed!.body).toMatchObject({ name, subscription_active: false });
    expect(g.store.list()).toHaveLength(0);
    expect(await g.call("POST", `/${name}/mark-available`)).toEqual({
      status: 404,
      body: { detail: `Unknown subscription credential "${name}".` },
    });
  });

  test("other routes are left to the caller", async () => {
    const g = gateway();
    expect(await g.call("DELETE", "/provider-credentials/pc_1")).toBeNull();
    expect(await g.call("POST", "/provider-credentials", {})).toBeNull();
    expect(await g.call("PATCH", "/NAME")).toBeNull();
    const elsewhere = await handleSubscriptionRequest(new Request("http://gateway.test/v1/routers"), {
      store: g.store,
      fetch: g.fetch,
    });
    expect(elsewhere).toBeNull();
  });
});

describe("plan usage reads", () => {
  function routedGateway(routes: Record<string, () => Response>) {
    const store = new SubscriptionStore(new Database(":memory:"));
    const calls: RecordedCall[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init, body: String(init.body) });
      const route = routes[url];
      if (route === undefined) throw new Error(`unexpected request to ${url}`);
      return route();
    };
    const list = async (at: Date, refresh = true) => {
      const response = await handleSubscriptionRequest(
        new Request(`${BASE}${refresh ? "?refresh_usage=true" : ""}`),
        { store, fetch, now: () => at },
      );
      const body = (await response!.json()) as any;
      return Object.fromEntries(body.credentials.map((c: any) => [c.oauth_provider, c.usage]));
    };
    return { store, calls, list };
  }

  const refused = () => Response.json({}, { status: 429 });
  const goUsage = jsonResponse({
    usage: {
      rolling: { status: "ok", percent: 5, resetsAt: "2026-10-20T16:00:00.000Z" },
      weekly: { status: "ok", percent: 40, resetsAt: "2026-10-25T00:00:00.000Z" },
      monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-11-01T00:00:00.000Z" },
    },
  });

  function connectPlans(store: SubscriptionStore) {
    store.connect(tokens({ provider: "meta_muse", accessToken: "meta-minted-key", refreshToken: "meta-sign-in", accountEmail: "muse@example.com" }), null, now);
    store.connect(tokens({ provider: "opencode_go", accessToken: "oc-access", refreshToken: "oc-refresh", accountId: "wrk_go", accountEmail: "go@example.com" }), null, now);
    store.connect(tokens(), null, now);
  }

  test("refresh_usage reads OpenCode Go from its usage report", async () => {
    const g = routedGateway({ "https://opencode.ai/zen/go/v1/usage": goUsage, [CLAUDE_USAGE]: refused });
    connectPlans(g.store);

    expect(await g.list(now, false)).toEqual({ meta_muse: null, opencode_go: null, anthropic_claude_code: null });
    expect(g.calls).toHaveLength(0);

    const usage = await g.list(now);
    // Muse Code reports usage only on the responses it serves.
    expect(usage.meta_muse).toBeNull();
    const goCalls = () => g.calls.filter((call) => call.url.startsWith("https://opencode.ai/"));
    expect(usage.opencode_go.windows.map((w: any) => [w.minutes, w.utilization])).toEqual([
      [300, 0.05], [10080, 0.4], [43200, 1],
    ]);
    expect(goCalls()).toHaveLength(1);
    expect(goCalls()[0]!.init.headers).toMatchObject({ Authorization: "Bearer oc-access", "x-opencode-org-id": "wrk_go" });
    // Reading the plan is not using it.
    expect(g.store.list().every((credential) => credential.lastUsedAt === null)).toBe(true);

    // A fresh reading is not read again; a stale one is.
    await g.list(new Date(now.getTime() + 30_000));
    expect(goCalls()).toHaveLength(1);
    await g.list(new Date(now.getTime() + 2 * 60_000));
    expect(goCalls()).toHaveLength(2);
  });

  test("refresh_usage reads an idle Claude Code plan from Claude Code's usage report", async () => {
    const g = routedGateway({
      [CLAUDE_USAGE]: jsonResponse({
        five_hour: { utilization: 25, resets_at: "2026-10-20T16:00:00+00:00" },
        seven_day: { utilization: 60, resets_at: "2026-10-24T00:00:00+00:00" },
      }),
    });
    g.store.connect(tokens({ expiresAt: new Date("2026-10-21T00:00:00Z") }), null, now);

    const usage = await g.list(now);
    expect(usage.anthropic_claude_code.windows.map((w: any) => [w.label, w.utilization])).toEqual([["5 Hour", 0.25], ["Weekly", 0.6]]);
    expect(g.calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer sk-ant-oat01-access", "anthropic-beta": "oauth-2025-04-20" });
  });

  test("refresh_usage reads Token Pass from its remaining credit", async () => {
    const g = routedGateway({
      "https://ai-gateway.vercel.sh/v1/credits": jsonResponse({
        balance: "10",
        token_pass: { remaining: "112.50", resets_at: "2026-11-01T00:00:00.000Z" },
      }),
    });
    g.store.connect(tokens({ provider: "vercel_token_pass", accessToken: "vck_pass", refreshToken: "vck_pass" }), null, now);

    const usage = await g.list(now);
    expect(usage.vercel_token_pass.windows.map((w: any) => [w.minutes, w.utilization])).toEqual([[43200, 0.25]]);
    expect(g.calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer vck_pass" });
  });

  test("a failed read keeps the listing", async () => {
    const g = routedGateway({ "https://opencode.ai/zen/go/v1/usage": () => Response.json({}, { status: 403 }), [CLAUDE_USAGE]: refused });
    connectPlans(g.store);
    expect(await g.list(now)).toEqual({ meta_muse: null, opencode_go: null, anthropic_claude_code: null });
  });
});

describe("banked resets", () => {
  // Claude Code's and Codex's reset endpoints, answering by method and URL.
  function resetGateway(routes: Record<string, (body: any) => Response>) {
    const store = new SubscriptionStore(new Database(":memory:"));
    const calls: Array<{ key: string; body: any }> = [];
    const fetch = async (url: string, init: RequestInit) => {
      const key = `${init.method ?? "GET"} ${url}`;
      const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ key, body });
      const route = routes[key];
      if (route === undefined) throw new Error(`unexpected request ${key}`);
      return route(body);
    };
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await handleSubscriptionRequest(
        new Request(BASE + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
        { store, fetch, now: () => now },
      );
      return { status: response!.status, body: (await response!.json()) as any };
    };
    return { store, calls, call };
  }

  const expiresAt = new Date("2026-10-21T00:00:00Z");
  const claudeReport = (grants: unknown[]) => () => Response.json({
    five_hour: { utilization: 10, resets_at: "2026-10-20T16:00:00+00:00" },
    cedar_ember: { eligible: true, next_grant_id: "grant_1", grants },
  });

  test("a Claude Code plan's resets list, and spending one releases the plan", async () => {
    const g = resetGateway({
      [`GET ${CLAUDE_USAGE}`]: claudeReport([
        { id: "grant_1", clears: ["seven_day"], resets_left: 2, usable_now: true, ends_at: "2026-11-01T00:00:00Z" },
        { id: "grant_spent", clears: ["five_hour"], resets_left: 0, usable_now: true },
      ]),
      "GET https://api.anthropic.com/api/oauth/profile": () => Response.json({ organization: { uuid: "org_1" } }),
      "POST https://api.anthropic.com/api/organizations/org_1/reset_rate_limits": () => Response.json({ result: "reset" }),
    });
    const plan = g.store.connect(tokens({ expiresAt }), null, now)!;
    g.store.markUnavailable(plan.id, new Date("2026-10-24T00:00:00Z"), "usage_limit", now);

    expect((await g.call("GET", `/${plan.name}/resets`)).body).toEqual({
      resets: [{ id: "grant_1", label: "Weekly reset", expires_at: "2026-11-01T00:00:00.000Z", usable: true }],
      read_at: null,
    });
    expect((await g.call("POST", `/${plan.name}/resets/grant_missing/use`)).body).toEqual({ result: "unavailable" });

    expect((await g.call("POST", `/${plan.name}/resets/grant_1/use`)).body).toEqual({ result: "reset" });
    const claim = g.calls.find((c) => c.key.startsWith("POST"))!;
    expect(claim.body).toMatchObject({ program: "cedar_ember", grant_id: "grant_1", request_id: expect.any(String) });
    // The plan serves again, with the usage Claude reports after the reset.
    const released = g.store.get(plan.id)!;
    expect(released.unavailableUntil).toBeNull();
    expect(released.usage?.utilization).toBe(0.1);
  });

  test("a ChatGPT plan spends a credit", async () => {
    const codex = "https://chatgpt.com/backend-api";
    const g = resetGateway({
      [`GET ${codex}/wham/rate-limit-reset-credits`]: () => Response.json({
        credits: [
          { id: "credit_1", reset_type: "codex_rate_limits", status: "available", expires_at: "2026-11-01T00:00:00Z" },
          { id: "credit_used", reset_type: "codex_rate_limits", status: "redeemed" },
        ],
      }),
      [`POST ${codex}/wham/rate-limit-reset-credits/consume`]: () => Response.json({ code: "reset" }),
      [`GET ${codex}/wham/usage`]: () => Response.json({ rate_limit: { allowed: true } }),
    });
    const plan = g.store.connect(tokens({ provider: "openai_codex", accessToken: codexAccessToken("acct_1"), accountId: "acct_1", expiresAt }), null, now)!;

    expect((await g.call("GET", `/${plan.name}/resets`)).body.resets.map((r: any) => r.id)).toEqual(["credit_1"]);
    expect((await g.call("POST", `/${plan.name}/resets/credit_1/use`)).body).toEqual({ result: "reset" });
    expect(g.calls.find((c) => c.key.startsWith("POST"))!.body).toMatchObject({ credit_id: "credit_1" });
  });

  test("only ChatGPT and Claude Code plans have banked resets", async () => {
    const g = resetGateway({});
    const muse = g.store.connect(tokens({ provider: "meta_muse", accountEmail: "muse@example.com", expiresAt }), null, now)!;
    expect((await g.call("GET", `/${muse.name}/resets`)).status).toBe(400);
  });

  test("a provider that fails to list resets is a bad gateway", async () => {
    const g = resetGateway({ [`GET ${CLAUDE_USAGE}`]: () => Response.json({}, { status: 500 }) });
    const plan = g.store.connect(tokens({ expiresAt }), null, now)!;
    expect((await g.call("GET", `/${plan.name}/resets`)).status).toBe(502);
  });
});
