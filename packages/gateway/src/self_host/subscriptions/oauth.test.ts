import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  CODEX_APPROVAL_PENDING,
  META_APPROVAL_PENDING,
  SubscriptionOAuthInputError,
  SubscriptionOAuthProviderError,
  completeOAuth,
  parseAuthorizationResponse,
  refreshOAuth,
  startOAuth,
} from "./oauth.js";
import { codexAccessToken, fakeFetch, jsonResponse, jwt } from "./test_support.js";

const now = new Date("2026-10-20T12:00:00Z");

describe("Claude Code PKCE", () => {
  test("start builds the authorization URL without any request", async () => {
    const fetch = fakeFetch([]);
    const started = await startOAuth("anthropic_claude_code", { fetch, now });
    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://claude.com/cai/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      code: "true",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      response_type: "code",
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
      code_challenge: createHash("sha256").update(started.flow.code_verifier!).digest("base64url"),
      code_challenge_method: "S256",
      state: started.flow.state!,
    });
    expect(started.flow.state).not.toBe(started.flow.code_verifier);
    expect(started.userCode).toBeNull();
    expect(started.expiresAt).toEqual(new Date("2026-10-20T12:15:00Z"));
    expect(fetch.calls).toHaveLength(0);
  });

  test("complete exchanges the pasted code#state", async () => {
    const fetch = fakeFetch([
      jsonResponse({
        access_token: "sk-ant-oat01-a",
        refresh_token: "sk-ant-ort01-r",
        expires_in: 3600,
        account: { email_address: "me@example.com" },
      }),
    ]);
    const result = await completeOAuth(
      "anthropic_claude_code",
      { code_verifier: "verifier", state: "state-1" },
      "  the-code#state-1 \n",
      { fetch, now },
    );
    expect(fetch.calls[0]!.url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(new Headers(fetch.calls[0]!.init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(fetch.calls[0]!.body)).toEqual({
      grant_type: "authorization_code",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      code: "the-code",
      state: "state-1",
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      code_verifier: "verifier",
    });
    expect(result).toEqual({
      provider: "anthropic_claude_code",
      accessToken: "sk-ant-oat01-a",
      refreshToken: "sk-ant-ort01-r",
      expiresAt: new Date("2026-10-20T13:00:00Z"),
      accountId: null,
      accountEmail: "me@example.com",
    });
  });

  test("complete rejects a mismatched state and an empty response", async () => {
    const flow = { code_verifier: "verifier", state: "expected" };
    const fetch = fakeFetch([]);
    await expect(completeOAuth("anthropic_claude_code", flow, "code#other", { fetch, now }))
      .rejects.toThrow(new SubscriptionOAuthInputError("Anthropic authorization state does not match. Start again."));
    await expect(completeOAuth("anthropic_claude_code", flow, "  ", { fetch, now }))
      .rejects.toBeInstanceOf(SubscriptionOAuthInputError);
    expect(fetch.calls).toHaveLength(0);
  });

  test("a bare code uses the stored state", async () => {
    const fetch = fakeFetch([jsonResponse({ access_token: "a", refresh_token: "r", expires_in: "60" })]);
    await completeOAuth("anthropic_claude_code", { code_verifier: "v", state: "s" }, "bare", { fetch, now });
    expect(JSON.parse(fetch.calls[0]!.body)).toMatchObject({ code: "bare", state: "s" });
  });

  test("refresh sends the scope and keeps the old refresh token when none returns", async () => {
    const fetch = fakeFetch([jsonResponse({ access_token: "new", expires_in: 28800 })]);
    const result = await refreshOAuth(
      { provider: "anthropic_claude_code", refreshToken: "old-refresh", accountId: null },
      { fetch, now },
    );
    expect(JSON.parse(fetch.calls[0]!.body)).toEqual({
      grant_type: "refresh_token",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      refresh_token: "old-refresh",
      scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    });
    expect(result.accessToken).toBe("new");
    expect(result.refreshToken).toBe("old-refresh");
    expect(result.expiresAt).toEqual(new Date("2026-10-20T20:00:00Z"));
  });

  test("a token response without expires_in is incomplete", async () => {
    const fetch = fakeFetch([jsonResponse({ access_token: "a", refresh_token: "r" })]);
    await expect(
      refreshOAuth({ provider: "anthropic_claude_code", refreshToken: "r", accountId: null }, { fetch, now }),
    ).rejects.toThrow("Subscription OAuth provider returned an incomplete response.");
  });
});

describe("parseAuthorizationResponse", () => {
  test.each([
    ["https://platform.claude.com/oauth/code/callback?code=c1&state=s1", "c1", "s1"],
    ["https://platform.claude.com/oauth/code/callback?code=c1", "c1", null],
    ["c2#s2", "c2", "s2"],
    ["c3#", "c3", null],
    ["code=c4&state=s4", "c4", "s4"],
    ["c5", "c5", null],
  ])("%s", (input, code, state) => {
    expect(parseAuthorizationResponse(input)).toEqual({ code, state });
  });

  test("empty input is rejected", () => {
    expect(() => parseAuthorizationResponse("   ")).toThrow(SubscriptionOAuthInputError);
  });
});

describe("ChatGPT device code", () => {
  test("start requests a user code", async () => {
    const fetch = fakeFetch([jsonResponse({ device_auth_id: "dev-1", usercode: "ABCD-EFGH" })]);
    const started = await startOAuth("openai_codex", { fetch, now });
    expect(fetch.calls[0]!.url).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
    expect(JSON.parse(fetch.calls[0]!.body)).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
    expect(started).toEqual({
      authorizationUrl: "https://auth.openai.com/codex/device",
      expiresAt: new Date("2026-10-20T12:15:00Z"),
      userCode: "ABCD-EFGH",
      flow: { device_auth_id: "dev-1", user_code: "ABCD-EFGH" },
    });
  });

  test("an unapproved device reports pending", async () => {
    for (const status of [403, 404]) {
      const fetch = fakeFetch([jsonResponse({ error: "pending" }, status)]);
      const pending = completeOAuth("openai_codex", { device_auth_id: "d", user_code: "u" }, "", { fetch, now });
      await expect(pending).rejects.toThrow(new SubscriptionOAuthInputError(CODEX_APPROVAL_PENDING));
    }
    expect(CODEX_APPROVAL_PENDING.startsWith("OpenAI approval is still pending.")).toBe(true);
  });

  test("an approved device exchanges its code with a form post", async () => {
    const idToken = jwt({
      email: "me@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-id-token" },
    });
    const fetch = fakeFetch([
      jsonResponse({ authorization_code: "auth-code", code_verifier: "provider-verifier" }),
      jsonResponse({
        access_token: codexAccessToken("acct-access"),
        refresh_token: "rt",
        id_token: idToken,
        expires_in: 864000,
      }),
    ]);
    const result = await completeOAuth("openai_codex", { device_auth_id: "dev-1", user_code: "ABCD" }, "", {
      fetch,
      now,
    });
    expect(fetch.calls[0]!.url).toBe("https://auth.openai.com/api/accounts/deviceauth/token");
    expect(JSON.parse(fetch.calls[0]!.body)).toEqual({ device_auth_id: "dev-1", user_code: "ABCD" });
    expect(fetch.calls[1]!.url).toBe("https://auth.openai.com/oauth/token");
    expect(new Headers(fetch.calls[1]!.init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(fetch.calls[1]!.body))).toEqual({
      grant_type: "authorization_code",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code: "auth-code",
      code_verifier: "provider-verifier",
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
    });
    expect(result).toMatchObject({
      provider: "openai_codex",
      refreshToken: "rt",
      accountId: "acct-id-token",
      accountEmail: "me@example.com",
      expiresAt: new Date("2026-10-30T12:00:00Z"),
    });
  });

  test("refresh falls back to the JWT expiry, stored account id, and old refresh token", async () => {
    const exp = Date.parse("2026-10-21T00:00:00Z") / 1000;
    const fetch = fakeFetch([jsonResponse({ access_token: jwt({ exp }) })]);
    const result = await refreshOAuth({ provider: "openai_codex", refreshToken: "old", accountId: "acct-1" }, {
      fetch,
      now,
    });
    expect(JSON.parse(fetch.calls[0]!.body)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "old",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });
    expect(result).toMatchObject({
      refreshToken: "old",
      accountId: "acct-1",
      accountEmail: null,
      expiresAt: new Date("2026-10-21T00:00:00Z"),
    });
  });

  test("a token without any account id is rejected", async () => {
    const fetch = fakeFetch([jsonResponse({ access_token: "opaque", refresh_token: "r", expires_in: 60 })]);
    await expect(refreshOAuth({ provider: "openai_codex", refreshToken: "r", accountId: null }, { fetch, now }))
      .rejects.toThrow("OpenAI subscription token is missing its account identifier.");
  });
});

describe("Muse Code device code", () => {
  const mint = (overrides: Record<string, unknown> = {}) => jsonResponse({
    api_key: "meta-minted-key",
    user_email: "muse@example.com",
    is_subs_active: true,
    ...overrides,
  });

  test("start requests Meta's device code with a form post", async () => {
    const fetch = fakeFetch([jsonResponse({
      device_code: "device-1",
      user_code: "BLXG-CHNZ",
      verification_uri: "https://auth.meta.com/oauth/device/",
      verification_uri_complete: "https://auth.meta.com/oauth/device/?code=BLXG-CHNZ",
      expires_in: 600,
    })]);
    const started = await startOAuth("meta_muse", { fetch, now });
    expect(fetch.calls[0]!.url).toBe("https://auth.meta.com/oidc/device/authorization/");
    expect(fetch.calls[0]!.body).toBe("client_id=1031625952748946");
    expect(started).toEqual({
      authorizationUrl: "https://auth.meta.com/oauth/device/?code=BLXG-CHNZ",
      expiresAt: new Date("2026-10-20T12:15:00Z"),
      userCode: "BLXG-CHNZ",
      flow: { device_code: "device-1" },
    });
  });

  test("an approved device mints the plan's key from the sign-in token", async () => {
    const fetch = fakeFetch([jsonResponse({ access_token: "meta-sign-in", token_type: "bearer" }), mint()]);
    const result = await completeOAuth("meta_muse", { device_code: "device-1" }, "", { fetch, now });
    expect(Object.fromEntries(new URLSearchParams(fetch.calls[0]!.body))).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "device-1",
      client_id: "1031625952748946",
    });
    expect(fetch.calls[1]!.url).toBe("https://api.meta.ai/muse-code/key");
    const mintHeaders = new Headers(fetch.calls[1]!.init.headers);
    expect(mintHeaders.get("authorization")).toBe("Bearer meta-sign-in");
    expect(mintHeaders.get("x-api-version")).toBe("1.0.0");
    expect(result).toEqual({
      provider: "meta_muse",
      accessToken: "meta-minted-key",
      refreshToken: "meta-sign-in",
      expiresAt: new Date("2026-10-21T00:00:00Z"),
      accountId: null,
      accountEmail: "muse@example.com",
    });
  });

  test("Meta's device errors become messages the user can act on", async () => {
    for (const [error, message] of [
      ["authorization_pending", META_APPROVAL_PENDING],
      ["slow_down", META_APPROVAL_PENDING],
      ["access_denied", "The sign-in was declined on Meta. Start again to retry."],
      ["expired_token", "The Meta sign-in code expired. Start again."],
    ]) {
      const fetch = fakeFetch([jsonResponse({ error }, 400)]);
      await expect(completeOAuth("meta_muse", { device_code: "d" }, "", { fetch, now }))
        .rejects.toThrow(new SubscriptionOAuthInputError(message!));
    }
    const failing = fakeFetch([jsonResponse({ error: "invalid_client" }, 400)]);
    await expect(completeOAuth("meta_muse", { device_code: "d" }, "", { fetch: failing, now }))
      .rejects.toBeInstanceOf(SubscriptionOAuthProviderError);
  });

  test("an account without an active plan is refused, since its key would bill pay-as-you-go", async () => {
    const fetch = fakeFetch([jsonResponse({ access_token: "meta-sign-in" }), mint({ is_subs_active: false })]);
    await expect(completeOAuth("meta_muse", { device_code: "d" }, "", { fetch, now }))
      .rejects.toThrow("no active Muse Code subscription");
  });

  test("refresh mints a new key from the stored sign-in token", async () => {
    const fetch = fakeFetch([mint({ api_key: "meta-reminted-key" })]);
    const refreshed = await refreshOAuth(
      { provider: "meta_muse", refreshToken: "meta-sign-in", accountId: null },
      { fetch, now },
    );
    expect(new Headers(fetch.calls[0]!.init.headers).get("authorization")).toBe("Bearer meta-sign-in");
    expect(refreshed).toMatchObject({ accessToken: "meta-reminted-key", refreshToken: "meta-sign-in" });
  });

  test("a sign-in refresh token is kept and exchanged before each remint", async () => {
    const fetch = fakeFetch([
      jsonResponse({ access_token: "meta-sign-in", refresh_token: "meta-refresh", expires_in: 3600 }),
      mint(),
      jsonResponse({ access_token: "meta-sign-in-2", expires_in: 3600 }),
      mint({ api_key: "meta-reminted-key" }),
    ]);
    const completed = await completeOAuth("meta_muse", { device_code: "d" }, "", { fetch, now });
    expect(completed.refreshToken).toBe("refresh:meta-refresh");
    const refreshed = await refreshOAuth({ provider: "meta_muse", refreshToken: completed.refreshToken, accountId: null }, { fetch, now });
    expect(fetch.calls[2]!.url).toBe("https://auth.meta.com/oidc/device/token/");
    expect(Object.fromEntries(new URLSearchParams(fetch.calls[2]!.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "meta-refresh",
      client_id: "1031625952748946",
    });
    expect(new Headers(fetch.calls[3]!.init.headers).get("authorization")).toBe("Bearer meta-sign-in-2");
    expect(refreshed).toMatchObject({ accessToken: "meta-reminted-key", refreshToken: "refresh:meta-refresh" });
  });

  test("refreshing a lapsed plan is a provider failure", async () => {
    const fetch = fakeFetch([mint({ is_subs_active: false })]);
    await expect(refreshOAuth({ provider: "meta_muse", refreshToken: "meta-sign-in", accountId: null }, { fetch, now }))
      .rejects.toBeInstanceOf(SubscriptionOAuthProviderError);
  });
});

test("provider failures carry the status; network failures do not", async () => {
  const failing = fakeFetch([jsonResponse({ error: "boom" }, 500)]);
  const error = await startOAuth("openai_codex", { fetch: failing, now }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SubscriptionOAuthProviderError);
  expect(error).toMatchObject({
    status: 500,
    errorCode: "boom",
    message: "OpenAI device code request failed with provider status 500.",
  });

  const offline = fakeFetch([() => { throw new TypeError("network down"); }]);
  await expect(startOAuth("openai_codex", { fetch: offline, now }))
    .rejects.toThrow("OpenAI device code request could not reach the provider.");
});
