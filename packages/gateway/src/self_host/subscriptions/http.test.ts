import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { handleSubscriptionRequest } from "./http.js";
import { SubscriptionStore } from "./store.js";
import { codexAccessToken, fakeFetch, jsonResponse, type RecordedCall } from "./test_support.js";

const BASE = "http://gateway.test/v1/organizations/current/credentials";
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
  "auto_redeem_resets",
];

function gateway(responses: Array<() => Response> = []) {
  const store = new SubscriptionStore(new Database(":memory:"));
  const fetch = fakeFetch(responses);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await handleSubscriptionRequest(
      new Request(BASE + path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      }),
      { store, fetch, now: () => now },
    );
    return response === null ? null : { status: response.status, body: (await response.json()) as any };
  };
  return { store, fetch, call };
}

async function connectClaude(g: ReturnType<typeof gateway>, credentialName?: string) {
  const started = await g.call("POST", "/oauth/sessions", {
    provider: "anthropic_claude_code",
    ...(credentialName === undefined ? {} : { credential_name: credentialName }),
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
        created_at: "2026-10-20T12:00:00.000Z",
        last_used_at: null,
        unavailable_until: null,
        unavailable_reason: null,
        model_holds: [],
        subscription_active: true,
        usage: null,
        auto_redeem_resets: false,
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

  test("banked resets are refused explicitly", async () => {
    const g = gateway();
    expect((await g.call("POST", "/OPENAI_CODEX_OAUTH_TOKEN/auto-reset", { enabled: true }))!.status).toBe(400);
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
