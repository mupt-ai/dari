import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import { pkceChallenge } from "./endpoints.js";
import {
  authorizeUrl,
  childToken,
  exchange,
  DariLink,
  grant as linkGrant,
  LinkError,
  linkFetch,
  type LinkBrowser,
  refresh as refreshTokens,
  revoke as revokeToken,
  usage as linkUsage,
  type LinkTokenSet,
} from "./client.js";
import { startStubGateway, type StubGateway, type StubLinkApp } from "../self_host/stub_gateway.js";
import { anthropicReply, startSubscriptionGateway } from "../self_host/subscription_test_gateway.js";
import { codexReply } from "../self_host/stub_gateway.js";

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

const REDIRECT_URI = "http://127.0.0.1:9999/callback";
const RESET = () => String(Math.floor(Date.now() / 1000) + 3600);

type Gateway = { baseUrl: string; planIds: string[]; userCookie: string };

function usageLimitRefusal(): Response {
  return Response.json(
    { type: "error", error: { type: "rate_limit_error", message: "usage limit" } },
    {
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": RESET(),
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
      },
    },
  );
}

async function registerApp(gateway: Gateway): Promise<string> {
  const response = await fetch(`${gateway.baseUrl}/v1/link/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Notes App", redirect_uris: [REDIRECT_URI] }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

// The browser flow of a user who connected the plans before: the approval
// page shows them ticked, and Allow shares the ones left ticked. Returns the
// code the app receives.
async function approve(
  gateway: Gateway,
  clientId: string,
  verifier: string,
  credentialIds: string[],
  extra: Record<string, string> = {},
): Promise<string> {
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state: "state-1",
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    ...extra,
  };
  // A new user has no account to sign in to: the page says what connecting
  // means and offers one button.
  const page = await fetch(`${gateway.baseUrl}/v1/link/authorize?${new URLSearchParams(params)}`);
  expect(page.status).toBe(200);
  const intro = await page.text();
  expect(intro).toContain("Notes App Uses Dari To Connect Your AI Subscriptions");
  expect(intro).toContain('name="decision" value="select">Continue');
  expect(intro).not.toContain("credential_id");

  const cookie = gateway.userCookie;
  const choose = await fetch(`${gateway.baseUrl}/v1/link/authorize?${new URLSearchParams(params)}`, {
    headers: { cookie },
  });
  const choices = await choose.text();
  expect(choices).toContain("Share With Notes App");
  const csrf = /name="csrf" value="([^"]+)"/.exec(choices)![1]!;

  const approved = await fetch(`${gateway.baseUrl}/v1/link/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie },
    body: new URLSearchParams([
      ...Object.entries(params),
      ["csrf", csrf],
      ["decision", "approve"],
      ...credentialIds.map((id) => ["credential_id", id]),
    ]),
  });
  expect(approved.status).toBe(303);
  const location = new URL(approved.headers.get("location")!);
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
  expect(location.searchParams.get("state")).toBe(params.state);
  return location.searchParams.get("code")!;
}

async function token(gateway: Gateway, body: Record<string, string>) {
  const response = await fetch(`${gateway.baseUrl}/v1/link/token`, { method: "POST", body: new URLSearchParams(body) });
  return { status: response.status, body: (await response.json()) as Record<string, string> & Record<string, unknown> };
}

async function link(gateway: Gateway, credentialIds: string[], extra: Record<string, string> = {}) {
  const clientId = await registerApp(gateway);
  const verifier = randomBytes(32).toString("base64url");
  const code = await approve(gateway, clientId, verifier, credentialIds, extra);
  const exchanged = await token(gateway, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
  expect(exchanged.status).toBe(200);
  return { clientId, verifier, code, tokens: exchanged.body };
}

async function chat(gateway: Pick<Gateway, "baseUrl">, accessToken: string, model = "dari/routing", extra: Record<string, unknown> = {}) {
  return await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], ...extra }),
  });
}

type ErrorBody = { code: string; resets_at?: string; revoked_by?: string; revoked_at?: string; message: string };

async function errorOf(response: Response): Promise<ErrorBody> {
  return ((await response.json()) as { error: ErrorBody }).error;
}

// A confidential client, registered with the gateway key.
async function registerConfidentialApp(gateway: Gateway): Promise<{ clientId: string; clientSecret: string }> {
  const response = await fetch(`${gateway.baseUrl}/v1/link/apps`, {
    method: "POST",
    headers: { authorization: "Bearer k", "content-type": "application/json" },
    body: JSON.stringify({ name: "Notes App", redirect_uris: [REDIRECT_URI], confidential: true }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string; client_secret: string; token_endpoint_auth_method: string };
  expect(body.token_endpoint_auth_method).toBe("client_secret_basic");
  expect(body.client_secret).toStartWith("dlk_cs_");
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

// A ChatGPT plan serves any app: a plain OpenAI chat/completions client runs on
// it, sees only its models, and learns its grant from the token response.
test("a ChatGPT plan serves a plain chat/completions app on its grant", async () => {
  const gateway: StubGateway = await startStubGateway({ plans: ["openai_codex", "anthropic_claude_code"] });
  stop = gateway.stop;
  const [codex] = gateway.planIds;
  const { tokens } = await link(gateway, [codex!]);
  expect(tokens).toMatchObject({
    token_type: "Bearer",
    scope: "route",
    grant_id: expect.stringMatching(/^lgr_/),
    app_name: "Notes App",
    routes: true,
    plans: [{
      id: codex,
      kind: "openai_codex",
      plan: "ChatGPT Plus/Pro",
      // A person's name for the plan, never its stored name.
      label: "a@example.com",
      account_email: "a@example.com",
      serves: "any_app",
      unavailable_until: null,
      usage: [],
    }],
  });
  // Every catalog model the plan serves, apart from any router, each by the
  // name a request uses, with the catalog's display name.
  const named = tokens.models as unknown as Array<{ id: string; name: string }>;
  expect(named).toContainEqual({ id: "dari/model/openai/gpt-6.1-sol", name: "GPT-6.1 Sol" });
  const models = named.map((model) => model.id);
  expect(models).toContain("dari/model/openai/gpt-5.6-sol");
  expect(models.every((model) => model.startsWith("dari/model/openai/"))).toBe(true);

  const response = await chat(gateway, tokens.access_token!);
  expect(response.status).toBe(200);
  expect(((await response.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe("hi");
  // One usage shape whatever protocol the app speaks.
  expect(JSON.parse(response.headers.get("x-dari-usage")!)).toEqual({
    input_tokens: 10,
    output_tokens: 2,
    cache_read_tokens: 4,
    cache_write_tokens: 0,
  });
  expect(gateway.served).toHaveLength(1);
  expect(gateway.served[0]!.split(".")).toHaveLength(3);

  const listed = await fetch(`${gateway.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  expect(((await listed.json()) as { data: Array<{ id: string }> }).data.map((model) => model.id))
    .toEqual(["dari/routing", ...models]);

  // A catalog model the router does not list is served when named.
  const unlisted = await chat(gateway, tokens.access_token!, "dari/model/openai/gpt-5.6-sol");
  expect(unlisted.status).toBe(200);
  expect(unlisted.headers.get("x-dari-selected-model")).toBe("openai/gpt-5.6-sol");
  expect(gateway.calls.at(-1)!.model).toBe("gpt-5.6-sol");

  const grant = await fetch(`${gateway.baseUrl}/v1/link/grant`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  expect(grant.status).toBe(200);
  expect(await grant.json()).toMatchObject({ grant_id: tokens.grant_id, plans: [{ id: codex }] });

  // A model the grant cannot serve.
  const claude = await chat(gateway, tokens.access_token!, "dari/model/anthropic/claude-sonnet-5-5");
  expect(claude.status).toBe(424);
  expect((await errorOf(claude)).code).toBe("model_not_granted");
  // A bare catalog id is that exact model; a name no catalog model has fails.
  const bare = await chat(gateway, tokens.access_token!, "gpt-6.1-sol");
  expect(bare.status).toBe(200);
  expect(bare.headers.get("x-dari-selected-model")).toBe("openai/gpt-6.1-sol");
  expect(gateway.calls.at(-1)!.model).toBe("gpt-6.1-sol");
  const unknown = await chat(gateway, tokens.access_token!, "gpt-nonexistent");
  expect(unknown.status).toBe(424);
  expect((await errorOf(unknown)).code).toBe("model_not_granted");
});

// A Claude Code plan serves only Claude Code itself: the approval page offers
// it only to an app that says it runs Claude Code, and a plain client on such a
// grant is told why it cannot be served.
test("Claude Code plans serve only Claude Code, and the page and errors say so", async () => {
  const gateway = await startStubGateway({ plans: ["anthropic_claude_code", "openai_codex"] });
  stop = gateway.stop;
  const [claude, codex] = gateway.planIds;
  const clientId = await registerApp(gateway);
  const verifier = randomBytes(32).toString("base64url");
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  };
  const cookie = gateway.userCookie;
  const pageFor = async (query: Record<string, string>) =>
    await (await fetch(`${gateway.baseUrl}/v1/link/authorize?${new URLSearchParams(query)}`, { headers: { cookie } })).text();
  // A plain app is offered only the plans it can use, ticked.
  const html = await pageFor(params);
  expect(html).toContain(`value="${codex}" checked`);
  expect(html).not.toContain(claude!);
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const refused = await fetch(`${gateway.baseUrl}/v1/link/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie },
    body: new URLSearchParams({ ...params, csrf, decision: "approve", credential_id: claude! }),
  });
  expect(refused.status).toBe(200);
  expect(await refused.text()).toContain("cannot use one of the plans");
  // Nor is it offered a Claude plan to connect.
  const select = await (await fetch(`${gateway.baseUrl}/v1/link/authorize`, {
    method: "POST",
    headers: { cookie },
    body: new URLSearchParams({ ...params, decision: "select" }),
  })).text();
  expect(select).toContain('name="connect" value="openai_codex"');
  expect(select).not.toContain('value="anthropic_claude_code"');

  // An app that runs Claude Code can be granted the plan; a plain client on
  // that grant gets subscription_client_mismatch and an empty model list.
  const running = { ...params, client: "claude_code codex", purpose_claude_code: "Runs <your> agents" };
  const offered = await pageFor(running);
  expect(offered).toContain(`value="${claude}" checked`);
  expect(offered).toContain('title="Runs &lt;your&gt; agents"');
  // `plans` limits the page to the kinds the app asked to connect.
  const onlyCodex = await pageFor({ ...running, plans: "openai_codex" });
  expect(onlyCodex).toContain(`value="${codex}"`);
  expect(onlyCodex).not.toContain(`value="${claude}"`);

  const { tokens } = await link(gateway, [claude!], { client: "claude_code" });
  expect(tokens.plans as unknown).toEqual([expect.objectContaining({ id: claude, serves: "claude_code_only" })]);
  expect(tokens.models as unknown).toEqual([]);
  expect(tokens.routes as unknown).toBe(false);
  const plain = await chat(gateway, tokens.access_token!);
  expect(plain.status).toBe(424);
  const error = await errorOf(plain);
  expect(error.code).toBe("subscription_client_mismatch");
  expect(error.message).toContain("ChatGPT");
  const models = await fetch(`${gateway.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  expect(await models.json()).toEqual({ object: "list", data: [] });
});

// The grant names plan a. When plan a is exhausted the app's requests fail:
// neither plan b nor an API key serves them. The user's plans serve only
// their grants, never the gateway key.
test("a linked app is served only by the subscriptions it was granted", async () => {
  let aExhausted = false;
  const gateway = await startSubscriptionGateway((token) =>
    token === "sk-ant-oat01-a" && aExhausted ? usageLimitRefusal() : anthropicReply(), undefined, "link_user");
  stop = gateway.stop;
  const [a] = gateway.planIds;
  const { tokens } = await link(gateway, [a!], { client: "claude_code" });
  const session = "55555555-5555-4555-8555-555555555555";
  const model = "dari/model/anthropic/claude-sonnet-5-5";

  expect((await gateway.claudeCode(session, "hello", model, tokens.access_token!)).status).toBe(200);
  expect(gateway.served).toEqual(["sk-ant-oat01-a"]);

  aExhausted = true;
  expect((await gateway.claudeCode(session, "again", model, tokens.access_token!)).status).not.toBe(200);
  expect(gateway.served).toEqual(["sk-ant-oat01-a", "sk-ant-oat01-a"]);

  const held = await gateway.claudeCode(session, "once more", model, tokens.access_token!);
  expect(held.status).toBe(424);
  expect(held.headers.get("retry-after")).not.toBeNull();
  const body = (await held.json()) as { error: { code: string; resets_at: string } };
  expect(body.error.code).toBe("subscription_exhausted");
  expect(Date.parse(body.error.resets_at)).toBeGreaterThan(Date.now());
  expect(gateway.served).toHaveLength(2);

  // The gateway key reaches neither plan: the gateway's own provider key serves it.
  expect((await gateway.claudeCode(session, "owner", model)).status).toBe(200);
  expect(gateway.served.at(-1)).not.toStartWith("sk-ant-oat01-");
});

test("codes are single-use, access tokens outlive a refresh, and revoking a grant stops its tokens", async () => {
  const gateway = await startSubscriptionGateway(() => anthropicReply(), undefined, "link_user");
  stop = gateway.stop;
  const [a] = gateway.planIds;
  const clientId = await registerApp(gateway);
  const verifier = randomBytes(32).toString("base64url");
  const code = await approve(gateway, clientId, verifier, [a!], { client: "claude_code" });
  const exchange = { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: clientId };

  // A verifier that does not match the challenge is refused.
  const wrongVerifier = await token(gateway, { ...exchange, code_verifier: randomBytes(32).toString("base64url") });
  expect(wrongVerifier).toEqual({ status: 400, body: expect.objectContaining({ error: "invalid_grant" }) });
  const first = await token(gateway, { ...exchange, code_verifier: verifier });
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
  expect((await token(gateway, { ...exchange, code_verifier: verifier })).body.error).toBe("invalid_grant");

  const refreshed = await token(gateway, { grant_type: "refresh_token", refresh_token: first.body.refresh_token!, client_id: clientId });
  expect(refreshed.status).toBe(200);
  expect(refreshed.body.refresh_token).not.toBe(first.body.refresh_token);
  // A request in flight on the previous access token still completes: each
  // access token lives until its own expiry.
  const session = "66666666-6666-4666-8666-666666666666";
  const model = "dari/model/anthropic/claude-sonnet-5-5";
  expect((await gateway.claudeCode(session, "old", model, first.body.access_token!)).status).toBe(200);
  expect((await gateway.claudeCode(session, "new", model, refreshed.body.access_token!)).status).toBe(200);

  // A link token cannot manage grants; the gateway key lists and revokes them.
  const asLink = await fetch(`${gateway.baseUrl}/v1/link/grants`, {
    headers: { authorization: `Bearer ${refreshed.body.access_token}` },
  });
  expect(asLink.status).toBe(401);
  const listed = await fetch(`${gateway.baseUrl}/v1/link/grants`, { headers: { authorization: "Bearer k" } });
  const grants = ((await listed.json()) as { grants: Array<{ id: string; app_name: string; credential_ids: string[] }> }).grants;
  expect(grants).toEqual([expect.objectContaining({ app_name: "Notes App", credential_ids: [a] })]);

  const revoked = await fetch(`${gateway.baseUrl}/v1/link/grants/${grants[0]!.id}`, {
    method: "DELETE",
    headers: { authorization: "Bearer k" },
  });
  expect(revoked.status).toBe(200);
  for (const accessToken of [first.body.access_token!, refreshed.body.access_token!]) {
    const dead = await gateway.claudeCode(session, "after", model, accessToken);
    expect(dead.status).toBe(401);
    expect(((await dead.json()) as { error: ErrorBody }).error).toMatchObject({ code: "grant_revoked", revoked_by: "user" });
  }
  const afterRevoke = await token(gateway, { grant_type: "refresh_token", refresh_token: refreshed.body.refresh_token!, client_id: clientId });
  expect(afterRevoke.body.error).toBe("invalid_grant");
  const relisted = await fetch(`${gateway.baseUrl}/v1/link/grants`, { headers: { authorization: "Bearer k" } });
  expect(((await relisted.json()) as { grants: unknown[] }).grants).toEqual([]);
});

test("a refresh that loses a rotation race is refused without revoking the grant", async () => {
  const gateway = await startStubGateway({ plans: ["openai_codex"] });
  stop = gateway.stop;
  const { clientId, tokens: first } = await link(gateway, [gateway.planIds[0]!]);
  // Two instances refresh the same token at once: one wins.
  const [a, b] = await Promise.all([1, 2].map(() =>
    token(gateway, { grant_type: "refresh_token", refresh_token: first.refresh_token!, client_id: clientId })));
  const [won, lost] = a!.status === 200 ? [a!, b!] : [b!, a!];
  expect(won.status).toBe(200);
  expect(lost).toEqual({ status: 400, body: expect.objectContaining({ error: "invalid_grant", error_code: "refresh_race" }) });
  // The winner's tokens work, and the grant lives on.
  expect((await chat(gateway, won.body.access_token!)).status).toBe(200);
  const next = await token(gateway, { grant_type: "refresh_token", refresh_token: won.body.refresh_token!, client_id: clientId });
  expect(next.status).toBe(200);
});

test("a confidential client proves its secret and keeps one refresh token", async () => {
  const gateway = await startStubGateway({ plans: ["openai_codex"] });
  stop = gateway.stop;
  const { clientId, clientSecret } = await registerConfidentialApp(gateway);
  const client = { gatewayUrl: gateway.baseUrl, clientId, clientSecret };
  const { url, codeVerifier, state } = await authorizeUrl({ ...client, redirectUri: REDIRECT_URI, plans: ["openai_codex"] });
  expect(new URL(url).searchParams.get("plans")).toBe("openai_codex");
  const code = await approve(gateway, clientId, codeVerifier, [gateway.planIds[0]!], { state, scope: "route", plans: "openai_codex" });

  // Without the secret, or with a wrong one, the code is not redeemed.
  const exchangeArgs = { ...client, redirectUri: REDIRECT_URI, code, codeVerifier };
  for (const wrong of [undefined, "dlk_cs_wrong"]) {
    const refused = await exchange({ ...exchangeArgs, clientSecret: wrong }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(LinkError);
    expect(refused).toMatchObject({ code: "invalid_client", status: 401 });
  }
  const tokens = await exchange(exchangeArgs);

  // Any number of instances refresh at once: the refresh token never rotates.
  const refreshed = await Promise.all([1, 2, 3].map(() => refreshTokens({ ...client, refreshToken: tokens.refreshToken })));
  expect(refreshed.map((set) => set.refreshToken)).toEqual(Array(3).fill(tokens.refreshToken));
  expect(new Set(refreshed.map((set) => set.accessToken)).size).toBe(3);
  for (const set of [tokens, ...refreshed]) expect((await chat(gateway, set.accessToken)).status).toBe(200);
  const withoutSecret = await refreshTokens({ ...client, clientSecret: undefined, refreshToken: tokens.refreshToken })
    .catch((error: unknown) => error);
  expect(withoutSecret).toMatchObject({ code: "invalid_client", status: 401 });

  // Revoking needs the secret too, and ends every token.
  expect(await revokeToken({ ...client, clientSecret: undefined, token: tokens.refreshToken }).catch((error: unknown) => error))
    .toMatchObject({ code: "invalid_client" });
  await revokeToken({ ...client, token: tokens.refreshToken });
  const dead = await chat(gateway, refreshed[0]!.accessToken);
  expect(dead.status).toBe(401);
  expect(await errorOf(dead)).toMatchObject({ code: "grant_revoked", revoked_by: "app", revoked_at: expect.any(String) });
  const grant = await fetch(`${gateway.baseUrl}/v1/link/grant`, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
  expect(grant.status).toBe(401);
  expect((await errorOf(grant)).code).toBe("grant_revoked");
  expect(await refreshTokens({ ...client, refreshToken: tokens.refreshToken }).catch((error: unknown) => error))
    .toMatchObject({ code: "invalid_grant" });
});

test("a child token serves its models, each at its pinned level, and nothing else", async () => {
  const gateway = await startStubGateway({ plans: ["openai_codex", "anthropic_claude_code"] });
  stop = gateway.stop;
  const { clientId, tokens } = await link(gateway, [gateway.planIds[0]!]);
  const client = { gatewayUrl: gateway.baseUrl, clientId };
  const child = await childToken({
    ...client,
    accessToken: tokens.access_token!,
    models: [{ model: "dari/model/openai/gpt-5.6-sol", thinking: "high" }, { model: "gpt-6.1-sol" }],
    expiresIn: 12 * 60 * 60,
    tags: { run: "r1", trial: "7" },
  });
  expect(child.accessToken).toStartWith("dlk_ct_");
  expect(child.models).toEqual([
    { model: "dari/model/openai/gpt-5.6-sol", thinking: "high" },
    { model: "dari/model/openai/gpt-6.1-sol", thinking: null },
  ]);
  expect(child.expiresAt - Date.now()).toBeGreaterThan(11 * 60 * 60_000);

  // Its model, at its level, whatever level the request names.
  const served = await chat(gateway, child.accessToken, "dari/model/openai/gpt-5.6-sol", { reasoning_effort: "low" });
  expect(served.status).toBe(200);
  expect(served.headers.get("x-dari-selected-model")).toBe("openai/gpt-5.6-sol");
  expect(served.headers.get("x-dari-thinking-level")).toBe("high");
  expect(gateway.calls.at(-1)).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
  // Its unpinned model is served at whatever the request asks.
  const unpinned = await chat(gateway, child.accessToken, "dari/model/openai/gpt-6.1-sol", { reasoning_effort: "low" });
  expect(unpinned.status).toBe(200);
  expect(gateway.calls.at(-1)).toMatchObject({ model: "gpt-6.1-sol", effort: "low" });

  const listed = await fetch(`${gateway.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${child.accessToken}` } });
  expect(((await listed.json()) as { data: Array<{ id: string }> }).data.map((model) => model.id).sort())
    .toEqual(["dari/model/openai/gpt-5.6-sol", "dari/model/openai/gpt-6.1-sol"]);

  // No other model, no routing, no grant, no minting, no refreshing.
  for (const model of ["dari/model/openai/gpt-5.4", "dari/routing"]) {
    const other = await chat(gateway, child.accessToken, model);
    expect(other.status).toBe(424);
    expect((await errorOf(other)).code).toBe("model_not_granted");
  }
  expect((await fetch(`${gateway.baseUrl}/v1/link/grant`, { headers: { authorization: `Bearer ${child.accessToken}` } })).status).toBe(403);
  expect(await childToken({ ...client, accessToken: child.accessToken, models: [{ model: "openai/gpt-6.1-sol" }] }).catch((error: unknown) => error))
    .toMatchObject({ code: "invalid_grant" });
  expect(await refreshTokens({ ...client, refreshToken: child.accessToken }).catch((error: unknown) => error))
    .toMatchObject({ code: "invalid_grant" });
  // Any model no granted plan could serve refuses the whole mint, and thinking
  // is given once or once per model.
  expect(await childToken({
    ...client,
    accessToken: tokens.access_token!,
    models: [{ model: "openai/gpt-6.1-sol" }, { model: "anthropic/claude-sonnet-5-5" }],
  }).catch((error: unknown) => error)).toMatchObject({ code: "invalid_target" });
  const mismatched = await token(gateway, {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: clientId,
    subject_token: tokens.access_token!,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    model: "openai/gpt-6.1-sol",
    thinking: "high",
  });
  expect(mismatched.status).toBe(200);
  const counted = await fetch(`${gateway.baseUrl}/v1/link/token`, {
    method: "POST",
    body: new URLSearchParams([
      ["grant_type", "urn:ietf:params:oauth:grant-type:token-exchange"],
      ["client_id", clientId],
      ["subject_token", tokens.access_token!],
      ["subject_token_type", "urn:ietf:params:oauth:token-type:access_token"],
      ["model", "openai/gpt-6.1-sol"],
      ["model", "openai/gpt-5.6-sol"],
      ["thinking", "high"],
      ["thinking", "low"],
      ["thinking", "low"],
    ]),
  });
  expect(counted.status).toBe(400);

  // The child dies with its grant.
  await revokeToken({ ...client, token: tokens.refresh_token! });
  const dead = await chat(gateway, child.accessToken, "dari/model/openai/gpt-5.6-sol");
  expect(dead.status).toBe(401);
  expect((await errorOf(dead)).code).toBe("grant_revoked");
});

// A named model is served with the client's own thinking settings: no level
// is chosen for it, a named level is served exactly, and one the model does
// not offer is refused, never replaced.
test("a link token's named model is served exactly as the client asked", async () => {
  const gateway = await startStubGateway({ plans: ["anthropic_claude_code", "openai_codex"] });
  stop = gateway.stop;
  const [claude, codex] = gateway.planIds;
  const { tokens } = await link(gateway, [claude!, codex!], { client: "claude_code" });
  const access = tokens.access_token!;

  const unnamed = await chat(gateway, access, "dari/model/openai/gpt-6.1-sol");
  expect(unnamed.status).toBe(200);
  expect(unnamed.headers.get("x-dari-thinking-level")).toBe("default");
  expect(gateway.calls.at(-1)).toMatchObject({ model: "gpt-6.1-sol", effort: null });

  const named = await chat(gateway, access, "dari/model/openai/gpt-6.1-sol", { reasoning_effort: "high" });
  expect(named.headers.get("x-dari-thinking-level")).toBe("high");
  expect(gateway.calls.at(-1)).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });

  // Claude Code's own requests: a budget is forwarded, a concrete model id is
  // that model and never a routed substitute, and one no plan serves fails.
  const claudeCode = async (model: string, thinking?: Record<string, unknown>, outputConfig?: Record<string, unknown>) =>
    await fetch(`${gateway.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": access,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "user-agent": "claude-cli/2.1.300 (external, cli)",
        "x-app": "cli",
        "x-claude-code-session-id": "77777777-7777-4777-8777-777777777777",
      },
      body: JSON.stringify({
        model,
        max_tokens: 20_000,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
        ...(thinking ? { thinking } : {}),
        ...(outputConfig ? { output_config: outputConfig } : {}),
      }),
    });
  const plainClaude = await claudeCode("claude-sonnet-5-5");
  expect(plainClaude.status).toBe(200);
  expect(plainClaude.headers.get("x-dari-selected-model")).toBe("anthropic/claude-sonnet-5-5");
  expect(plainClaude.headers.get("x-dari-thinking-level")).toBe("default");
  expect(gateway.calls.at(-1)).toMatchObject({ model: "claude-sonnet-5-5", effort: null, thinking: null });
  expect(gateway.calls.at(-1)!.headers["user-agent"]).toContain("claude-cli/");

  const budget = await claudeCode("dari/model/anthropic/claude-sonnet-5-5", { type: "enabled", budget_tokens: 8000 });
  expect(budget.status).toBe(200);
  expect(budget.headers.get("x-dari-thinking-level")).toBe("budget:8000");
  expect(gateway.calls.at(-1)).toMatchObject({ effort: null, thinking: { type: "enabled", budget_tokens: 8000 } });

  // A concrete id the catalog serves but the router does not list is still
  // that model; one nothing serves is refused, not routed.
  const haiku = await claudeCode("claude-haiku-4-5");
  expect(haiku.status).toBe(200);
  expect(haiku.headers.get("x-dari-selected-model")).toBe("anthropic/claude-haiku-4-5");
  expect(gateway.calls.at(-1)).toMatchObject({ model: "claude-haiku-4-5", effort: null, thinking: null });
  // A dated snapshot is the catalog model it dates, served as exactly that.
  const dated = await claudeCode("claude-haiku-4-5-20251001");
  expect(dated.status).toBe(200);
  expect(dated.headers.get("x-dari-selected-model")).toBe("anthropic/claude-haiku-4-5");
  expect(gateway.calls.at(-1)).toMatchObject({ model: "claude-haiku-4-5", effort: null, thinking: null });
  const unknown = await claudeCode("claude-nonexistent-9");
  expect(unknown.status).toBe(424);
  expect(((await unknown.json()) as { error: ErrorBody }).error.code).toBe("model_not_granted");

  // Claude Code's own effort is what reaches the provider (Sonnet 5.5 takes it
  // as a per-turn effort message), and disabled thinking is passed through
  // though the model has no off level.
  const effort = await claudeCode("claude-sonnet-5-5", { type: "adaptive" }, { effort: "high" });
  expect(effort.status).toBe(200);
  expect(effort.headers.get("x-dari-thinking-level")).toBe("high");
  expect(gateway.calls.at(-1)).toMatchObject({ model: "claude-sonnet-5-5", effort: "high", thinking: { type: "adaptive" } });
  const disabled = await claudeCode("claude-sonnet-5-5", { type: "disabled" });
  expect(disabled.status).toBe(200);
  expect(disabled.headers.get("x-dari-thinking-level")).toBe("off");
  expect(gateway.calls.at(-1)).toMatchObject({ effort: null, thinking: { type: "disabled" } });

  // A plain client naming a Claude model learns the plan serves only Claude Code.
  const mismatch = await chat(gateway, access, "dari/model/anthropic/claude-sonnet-5-5");
  expect(mismatch.status).toBe(424);
  expect((await errorOf(mismatch)).code).toBe("subscription_client_mismatch");
});

// An app reads back what its grant's requests used, in one shape whatever
// protocol served them, streamed or not, and narrows it by tag and time.
test("an app reads back its grant's usage by tag, in one shape for every protocol", async () => {
  const gateway = await startStubGateway({ plans: ["openai_codex", "anthropic_claude_code"] });
  stop = gateway.stop;
  const [codex, claude] = gateway.planIds;
  const { clientId, tokens } = await link(gateway, [codex!, claude!], { client: "claude_code" });
  const access = tokens.access_token!;
  const send = async (path: string, body: Record<string, unknown>, tags: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${gateway.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json", "x-dari-tags": tags, ...headers },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    await response.text();
  };
  const messages = [{ role: "user", content: "hello" }];
  const gpt = "dari/model/openai/gpt-6.1-sol";
  await send("/v1/chat/completions", { model: gpt, messages }, "run=r1,trial=1");
  await send("/v1/chat/completions", { model: gpt, messages, stream: true }, "run=r1,trial=2");
  await send("/v1/responses", { model: gpt, input: "hello", reasoning: { effort: "high" } }, "run=r1,trial=3");
  await send("/v1/responses", { model: gpt, input: "hello", stream: true }, "run=r1,trial=4");
  const claudeCodeHeaders = {
    "anthropic-version": "2023-06-01",
    "user-agent": "claude-cli/2.1.300 (external, cli)",
    "x-app": "cli",
    "x-claude-code-session-id": "77777777-7777-4777-8777-777777777777",
  };
  await send("/v1/messages", { model: "claude-sonnet-5-5", max_tokens: 100, messages }, "run=r1,trial=5", claudeCodeHeaders);
  await send("/v1/messages", { model: "claude-sonnet-5-5", max_tokens: 100, messages, stream: true }, "run=r1,trial=6", claudeCodeHeaders);
  // A child token's own tags label its requests.
  const child = await childToken({
    gatewayUrl: gateway.baseUrl,
    clientId,
    accessToken: access,
    models: [{ model: gpt }],
    tags: { run: "r2", trial: "9" },
  });
  expect((await chat(gateway, child.accessToken, gpt)).status).toBe(200);

  const read = async (query = "", bearer = access) =>
    await fetch(`${gateway.baseUrl}/v1/link/usage${query}`, { headers: { authorization: `Bearer ${bearer}` } });
  // Requests are recorded once they finish, a moment after the response.
  let all: WireUsage | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    all = (await (await read()).json()) as WireUsage;
    if (all.requests === 7) break;
    await Bun.sleep(20);
  }
  // Input excludes cache reads and writes for every protocol: the Codex stub
  // reports 14 input including 4 cached, the Anthropic one 10 plus 4 read and
  // 1 written.
  expect(all).toEqual({
    requests: 7,
    errors: 0,
    input_tokens: 70,
    output_tokens: 14,
    cache_read_tokens: 28,
    cache_write_tokens: 2,
    complete_through: expect.any(String),
    by_model: [
      { model: "openai/gpt-6.1-sol", thinking: "default", requests: 4, errors: 0, input_tokens: 40, output_tokens: 8, cache_read_tokens: 16, cache_write_tokens: 0 },
      { model: "anthropic/claude-sonnet-5-5", thinking: "default", requests: 2, errors: 0, input_tokens: 20, output_tokens: 4, cache_read_tokens: 8, cache_write_tokens: 2 },
      { model: "openai/gpt-6.1-sol", thinking: "high", requests: 1, errors: 0, input_tokens: 10, output_tokens: 2, cache_read_tokens: 4, cache_write_tokens: 0 },
    ],
  });
  // With nothing in flight, every request until moments ago is counted.
  expect(Date.parse(all!.complete_through!)).toBeGreaterThan(Date.now() - 60_000);
  // Totals per value of one tag; requests without it come first, as null.
  expect(((await (await read("?group_by=tag%3Arun")).json()) as WireUsage).by_tag).toEqual([
    { value: "r1", requests: 6, errors: 0, input_tokens: 60, output_tokens: 12, cache_read_tokens: 24, cache_write_tokens: 2 },
    { value: "r2", requests: 1, errors: 0, input_tokens: 10, output_tokens: 2, cache_read_tokens: 4, cache_write_tokens: 0 },
  ]);
  expect((await read("?group_by=run")).status).toBe(400);

  const filtered = async (query: string) => (await (await read(query)).json()) as WireUsage;
  expect((await filtered("?tag=run%3Dr1")).requests).toBe(6);
  expect(await filtered("?tag=run%3Dr1&tag=trial%3D6")).toMatchObject({
    requests: 1,
    by_model: [{ model: "anthropic/claude-sonnet-5-5", requests: 1 }],
  });
  expect(await filtered("?tag=run%3Dr2")).toMatchObject({ requests: 1, by_model: [{ model: "openai/gpt-6.1-sol" }] });
  expect((await filtered(`?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).requests).toBe(0);
  expect((await filtered(`?until=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).requests).toBe(7);

  const badTag = await read("?tag=nope");
  expect(badTag.status).toBe(400);
  // A child token reads neither its grant nor its usage.
  const fromChild = await read("", child.accessToken);
  expect(fromChild.status).toBe(403);
  expect((await errorOf(fromChild)).code).toBe("permission_denied");

  // The link client reads it from token storage.
  let stored: LinkTokenSet = {
    accessToken: access,
    refreshToken: tokens.refresh_token!,
    expiresAt: Date.now() + 3_600_000,
    grantId: tokens.grant_id as string,
    scope: "route",
    budget: [],
    state: "ready",
    availableAt: null,
    plans: [],
    models: [],
    routes: true,
    manageUrl: "",
  };
  const storage = { gatewayUrl: gateway.baseUrl, clientId, loadTokens: () => stored, saveTokens: (next: LinkTokenSet) => { stored = next; } };
  const viaClient = await linkUsage({ ...storage, tags: { run: "r1", trial: "3" } });
  expect(viaClient).toMatchObject({ requests: 1, inputTokens: 10, byModel: [{ model: "openai/gpt-6.1-sol", thinking: "high", cacheReadTokens: 4 }] });
  expect(viaClient.completeThrough).toEqual(expect.any(String));
  // Or through the app's own linkFetch, sharing its refresh.
  const viaFetcher = await linkUsage({ fetcher: linkFetch(storage), groupByTag: "trial", tags: { run: "r2" } });
  expect(viaFetcher.byTag).toMatchObject([{ value: "9", requests: 1 }]);
});

// A budget caps the tokens the app may use per window, counted from the
// grant's own recorded requests.
test("a grant stops at the token budget the user set until the user lifts it", async () => {
  const gateway = await startStubGateway({ plans: ["openai_codex"] });
  stop = gateway.stop;
  const { tokens } = await link(gateway, gateway.planIds);
  const access = tokens.access_token!;
  // A connection starts without a budget; the gateway's owner sets one with a key.
  expect(tokens.budget as unknown).toEqual([]);
  const put = (grantId: string, budget: unknown, key = "k") => fetch(`${gateway.baseUrl}/v1/link/grants/${grantId}/budget`, {
    method: "PUT",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ budget }),
  });
  expect((await put(tokens.grant_id!, [{ window_minutes: 10080, max_tokens: 40 }])).status).toBe(200);

  type Grant = {
    state: string;
    available_at: string | null;
    budget: Array<{ window_minutes: number; max_tokens: number; used_tokens: number; resets_at: string | null }>;
  };
  const grant = async (): Promise<Grant> =>
    (await (await fetch(`${gateway.baseUrl}/v1/link/grant`, { headers: { authorization: `Bearer ${access}` } })).json()) as Grant;
  // Usage is recorded just after each response.
  const settle = async (used: number) => {
    for (let attempt = 0; attempt < 50 && (await grant()).budget[0]!.used_tokens !== used; attempt += 1) await Bun.sleep(20);
    return await grant();
  };
  // Each reply uses 16 tokens (10 input, 4 cache read, 2 output).
  const before = Date.now();
  for (const used of [16, 32]) {
    expect((await chat(gateway, access)).status).toBe(200);
    expect(await settle(used)).toMatchObject({ state: "ready", budget: [{ used_tokens: used, resets_at: null }] });
  }
  // A request in flight may go over; the next one is refused.
  expect((await chat(gateway, access)).status).toBe(200);
  const capped = await settle(48);
  expect(capped).toMatchObject({ state: "budget_limit", budget: [{ max_tokens: 40, used_tokens: 48 }] });
  // Back once the first request rolls off the week: 32 is under the cap.
  const back = Date.parse(capped.budget[0]!.resets_at!);
  expect(back).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
  expect(back).toBeLessThan(Date.now() + 7 * 86_400_000);
  expect(capped.available_at).toBe(capped.budget[0]!.resets_at);

  const refused = await chat(gateway, access);
  expect(refused.status).toBe(424);
  const error = await errorOf(refused);
  expect(error.code).toBe("grant_budget_exhausted");
  expect(error.resets_at).toBe(capped.budget[0]!.resets_at!);

  // The gateway's owner sees and changes the budget with a key.
  const grants = await (await fetch(`${gateway.baseUrl}/v1/link/grants`, { headers: { authorization: "Bearer k" } })).json() as {
    grants: Array<{ id: string; budget: unknown }>;
  };
  expect(grants.grants[0]!.budget).toEqual([{ window_minutes: 10080, max_tokens: 40 }]);
  expect((await put(grants.grants[0]!.id, [{ window_minutes: 10080, max_tokens: 0 }])).status).toBe(400);
  expect((await put(grants.grants[0]!.id, [{ window_minutes: 60, max_tokens: 100 }])).status).toBe(400);
  expect((await put("lgr_nope", [])).status).toBe(404);
  expect((await put(grants.grants[0]!.id, [], access)).status).toBe(401);
  expect((await put(grants.grants[0]!.id, [])).status).toBe(200);
  expect((await chat(gateway, access)).status).toBe(200);
});

test("an app discovers the endpoints, registers itself, and revokes its own grant", async () => {
  const gateway = await startStubGateway({ plans: ["openai_codex"] });
  stop = gateway.stop;
  const metadata = await fetch(`${gateway.baseUrl}/.well-known/oauth-authorization-server`);
  expect(metadata.headers.get("access-control-allow-origin")).toBe("*");
  expect(await metadata.json()).toMatchObject({
    issuer: gateway.baseUrl,
    authorization_endpoint: `${gateway.baseUrl}/v1/link/authorize`,
    token_endpoint: `${gateway.baseUrl}/v1/link/token`,
    registration_endpoint: `${gateway.baseUrl}/v1/link/register`,
    revocation_endpoint: `${gateway.baseUrl}/v1/link/revoke`,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:token-exchange"],
  });

  const insecure = await fetch(`${gateway.baseUrl}/v1/link/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Insecure", redirect_uris: ["http://example.com/callback"] }),
  });
  expect(insecure.status).toBe(400);
  expect(((await insecure.json()) as { error: string }).error).toBe("invalid_redirect_uri");
  const secret = await fetch(`${gateway.baseUrl}/v1/link/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Secret", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "client_secret_basic" }),
  });
  // A server registers itself as a confidential client and gets its secret once.
  expect(secret.status).toBe(201);
  const confidential = (await secret.json()) as { client_id: string; client_secret: string; token_endpoint_auth_method: string };
  expect(confidential.token_endpoint_auth_method).toBe("client_secret_basic");
  expect(confidential.client_secret).toStartWith("dlk_cs_");
  const unsupported = await fetch(`${gateway.baseUrl}/v1/link/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Jwt", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "private_key_jwt" }),
  });
  expect(((await unsupported.json()) as { error: string }).error).toBe("invalid_client_metadata");
  // Its secret is required at the token endpoint.
  const noSecret = await token(gateway, { grant_type: "refresh_token", refresh_token: "dlk_rt_x", client_id: confidential.client_id });
  expect(noSecret.status).toBe(401);
  expect(noSecret.body.error).toBe("invalid_client");

  const { clientId, tokens } = await link(gateway, [gateway.planIds[0]!]);
  // Another client's revoke does nothing; the owner's ends the grant.
  await revokeToken({ gatewayUrl: gateway.baseUrl, clientId: await registerApp(gateway), token: tokens.refresh_token! });
  expect((await chat(gateway, tokens.access_token!)).status).toBe(200);
  const revoked = await fetch(`${gateway.baseUrl}/v1/link/revoke`, {
    method: "POST",
    headers: { origin: "https://app.example" },
    body: new URLSearchParams({ client_id: clientId, token: tokens.refresh_token! }),
  });
  expect(revoked.status).toBe(200);
  expect(revoked.headers.get("access-control-allow-origin")).toBe("*");
  expect((await chat(gateway, tokens.access_token!)).status).toBe(401);
  expect((await fetch(`${gateway.baseUrl}/v1/link/grant`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
});

test("the link client authorizes, exchanges, and refreshes for an app", async () => {
  const gateway = await startStubGateway({ plans: ["openai_codex"] });
  stop = gateway.stop;
  const clientId = await registerApp(gateway);
  const { url, codeVerifier, state } = await authorizeUrl({ gatewayUrl: gateway.baseUrl, clientId, redirectUri: REDIRECT_URI });
  const params = Object.fromEntries(new URL(url).searchParams);
  expect(params).toMatchObject({ state, scope: "route", code_challenge: pkceChallenge(codeVerifier) });
  const code = await approve(gateway, clientId, codeVerifier, [gateway.planIds[0]!], { state, scope: "route" });
  const tokens = await exchange({ gatewayUrl: gateway.baseUrl, clientId, redirectUri: REDIRECT_URI, code, codeVerifier });
  expect(tokens.models.map((model) => model.id)).toContain("dari/model/openai/gpt-6.1-sol");

  // Storage is the source of truth: an expired set is refreshed before the
  // call, and the new set saved.
  let stored: LinkTokenSet = { ...tokens, expiresAt: 0 };
  const saved: string[] = [];
  const gatewayFetch = linkFetch({
    gatewayUrl: gateway.baseUrl,
    clientId,
    loadTokens: () => stored,
    saveTokens: (next) => {
      saved.push(next.refreshToken);
      stored = next;
    },
  });
  const call = () => gatewayFetch("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "dari/routing", messages: [{ role: "user", content: "hi" }] }),
  });
  const responses = await Promise.all([call(), call()]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  // Both calls shared one refresh.
  expect(saved).toHaveLength(1);
  expect(saved[0]).not.toBe(tokens.refreshToken);

  // Tokens another process saved are used as they are.
  const elsewhere = await refreshTokens({ gatewayUrl: gateway.baseUrl, clientId, refreshToken: stored.refreshToken });
  stored = elsewhere;
  expect((await call()).status).toBe(200);
  expect(saved).toHaveLength(1);

  // A revoked grant's 401 comes back as it is, with no refresh attempted.
  await revokeToken({ gatewayUrl: gateway.baseUrl, clientId, token: stored.accessToken });
  const dead = await call();
  expect(dead.status).toBe(401);
  expect((await errorOf(dead)).code).toBe("grant_revoked");
  expect(saved).toHaveLength(1);

  // With no tokens stored, nothing reaches the gateway.
  let reached = false;
  const unlinked = linkFetch({
    gatewayUrl: gateway.baseUrl,
    clientId,
    fetch: (async () => {
      reached = true;
      return new Response(null);
    }) as unknown as typeof fetch,
    loadTokens: () => null,
    saveTokens: () => undefined,
  });
  expect(await unlinked("/v1/models").catch((error: unknown) => error)).toMatchObject({ code: "not_linked" });
  expect(reached).toBe(false);
});

// A server stores one string per user: every call takes the refresh token and
// makes its own access tokens.
test("a server app runs on the refresh token alone", async () => {
  const gateway = await startStubGateway({ plans: ["openai_codex"] });
  stop = gateway.stop;
  let refreshes = 0;
  const counting = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.body instanceof URLSearchParams && init.body.get("grant_type") === "refresh_token") refreshes += 1;
    return await fetch(input, init);
  }) as typeof fetch;
  const { gatewayUrl, clientId, clientSecret, redirectUri } = gateway.app;
  const client = { gatewayUrl, clientId, clientSecret, fetch: counting };
  // The stub's user denies, then approves, as Connect with Dari would report each.
  expect(await gateway.connect({ deny: true }).catch((error: unknown) => error)).toMatchObject({ code: "access_denied" });
  const { refreshToken, grantId } = await exchange({ ...client, redirectUri, ...(await gateway.connect()) });

  // Calls at once, and every later call in the process, share one refresh.
  const call = () => linkFetch({ ...client, refreshToken })("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6.1-sol", messages: [{ role: "user", content: "hi" }] }),
  });
  expect((await Promise.all([call(), call()])).map((response) => response.status)).toEqual([200, 200]);
  const held = await linkGrant({ ...client, refreshToken });
  expect(held).toMatchObject({ grantId, state: "ready", plans: [{ id: gateway.planIds[0], kind: "openai_codex", state: "ready" }] });
  expect(held.manageUrl).toEndWith(`#${grantId}`);
  const child = await childToken({ ...client, refreshToken, models: [{ model: "gpt-6.1-sol" }], tags: { trial: "1" } });
  expect((await chat(gateway, child.accessToken, "gpt-6.1-sol")).status).toBe(200);
  expect(refreshes).toBe(1);
  // An access token near its expiry is replaced.
  await linkGrant({ ...client, refreshToken, now: () => Date.now() + 2 * 3_600_000 });
  expect(refreshes).toBe(2);

  // A public client's refresh token rotates, so it cannot be the one string stored.
  expect(() => linkFetch({ gatewayUrl, clientId, refreshToken })).toThrow(expect.objectContaining({ code: "invalid_request" }));

  // Once the grant is revoked, every call says the user is unlinked.
  await revokeToken({ ...client, token: refreshToken });
  const gone = await linkGrant({ ...client, refreshToken }).catch((error: unknown) => error);
  expect(gone).toMatchObject({ code: "grant_revoked", unlinked: true });
  expect(await childToken({ ...client, refreshToken: `${refreshToken}x`, models: [{ model: "gpt-6.1-sol" }] }).catch((error: unknown) => error))
    .toMatchObject({ code: "invalid_grant", unlinked: true });
});

test("a child token is minted from token storage, by the names a request uses", async () => {
  const gateway = await startStubGateway({ plans: ["openai_codex", "anthropic_claude_code"] });
  stop = gateway.stop;
  const { clientId, tokens } = await link(gateway, gateway.planIds, { client: "claude_code" });
  const client = { gatewayUrl: gateway.baseUrl, clientId };
  // An expired set is refreshed and saved before minting.
  let stored: LinkTokenSet | null = {
    accessToken: tokens.access_token!,
    refreshToken: tokens.refresh_token!,
    expiresAt: 0,
  } as LinkTokenSet;
  const storage = { loadTokens: () => stored, saveTokens: (next: LinkTokenSet) => { stored = next; } };
  const child = await childToken({ ...client, ...storage, models: [{ model: "gpt-6.1-sol" }] });
  expect(child.models).toEqual([{ model: "dari/model/openai/gpt-6.1-sol", thinking: null }]);
  expect(stored!.accessToken).not.toBe(tokens.access_token);

  // A dated Claude snapshot names its catalog model; its child lists it for
  // any client, though only Claude Code may call it.
  const claude = await childToken({ ...client, ...storage, models: [{ model: "claude-haiku-4-5-20251001" }] });
  expect(claude.models[0]!.model).toBe("dari/model/anthropic/claude-haiku-4-5");
  const listed = await fetch(`${gateway.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${claude.accessToken}` } });
  expect(((await listed.json()) as { data: Array<{ id: string }> }).data.map((model) => model.id))
    .toEqual(["dari/model/anthropic/claude-haiku-4-5"]);

  // A name the grant serves no model by, or a level the model lacks, is refused at mint.
  for (const refused of [{ model: "gpt-nonexistent" }, { model: "anthropic/claude-sonnet-5-5", thinking: "minimal" }]) {
    expect(await childToken({ ...client, ...storage, models: [refused] }).catch((error: unknown) => error))
      .toMatchObject({ code: "invalid_target" });
  }

  stored = null;
  expect(await childToken({ ...client, ...storage, models: [{ model: "gpt-6.1-sol" }] }).catch((error: unknown) => error))
    .toMatchObject({ code: "not_linked" });
});

test("the approval page approves only for the plans' user, with their form token", async () => {
  const gateway = await startSubscriptionGateway(() => anthropicReply(), undefined, "link_user");
  stop = gateway.stop;
  const clientId = await registerApp(gateway);
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: pkceChallenge(randomBytes(32).toString("base64url")),
    code_challenge_method: "S256",
    client: "claude_code",
  };

  const unregistered = await fetch(`${gateway.baseUrl}/v1/link/authorize?${new URLSearchParams({
    ...params,
    redirect_uri: "https://attacker.example/callback",
  })}`, { redirect: "manual" });
  expect(unregistered.status).toBe(400);

  const denied = await fetch(`${gateway.baseUrl}/v1/link/authorize`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ ...params, decision: "deny" }),
  });
  expect(denied.status).toBe(303);
  expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("access_denied");

  // Approving as nobody, as a cookie this gateway did not sign, or without
  // the user's form token is refused: the first two start over as a new user.
  const [a] = gateway.planIds;
  for (const headers of [{}, { cookie: `${gateway.userCookie.slice(0, -4)}AAAA` }] as Array<Record<string, string>>) {
    const stranger = await fetch(`${gateway.baseUrl}/v1/link/authorize`, {
      method: "POST",
      redirect: "manual",
      headers,
      body: new URLSearchParams({ ...params, decision: "approve", credential_id: a! }),
    });
    expect(stranger.status).toBe(303);
    expect(new URL(stranger.headers.get("location")!, gateway.baseUrl).pathname).toBe("/v1/link/authorize");
  }
  const cookie = gateway.userCookie;
  const forged = await fetch(`${gateway.baseUrl}/v1/link/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie },
    body: new URLSearchParams({ ...params, csrf: "forged", decision: "approve", credential_id: a! }),
  });
  expect(forged.status).toBe(403);

  const insecure = await fetch(`${gateway.baseUrl}/v1/link/apps`, {
    method: "POST",
    headers: { authorization: "Bearer k", "content-type": "application/json" },
    body: JSON.stringify({ name: "Insecure", redirect_uris: ["http://example.com/callback"] }),
  });
  expect(insecure.status).toBe(400);
});

// A browser window for `DariLink.open`: it records the popup and delivers
// messages to the opener's listeners.
function fakeBrowser() {
  const listeners = new Set<(event: { source: unknown; origin: string; data: unknown }) => void>();
  const popup = { closed: false, close() { popup.closed = true; }, location: { href: "" } };
  const browser: LinkBrowser = {
    open: () => popup,
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
  };
  const post = (event: { source: unknown; origin: string; data: unknown }) => {
    for (const listener of [...listeners]) listener(event);
  };
  return { browser, popup, post, listeners };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

test("a Connect button opens a popup and gets the code posted back", async () => {
  const gateway = await startStubGateway({ plans: ["openai_codex"] });
  stop = gateway.stop;
  const clientId = await registerApp(gateway);
  const client = { gatewayUrl: gateway.baseUrl, clientId, redirectUri: REDIRECT_URI };
  const gatewayOrigin = new URL(gateway.baseUrl).origin;
  const metadata = (await (await fetch(`${gateway.baseUrl}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  expect(metadata.response_modes_supported).toEqual(["query", "web_message"]);
  expect(metadata.web_message_origin).toBe(gatewayOrigin);

  const { browser, popup, post, listeners } = fakeBrowser();
  const opened = DariLink.open({ ...client, window: browser });
  await until(() => popup.location.href !== "");
  const params = Object.fromEntries(new URL(popup.location.href).searchParams);
  expect(params.response_mode).toBe("web_message");

  // The user signs in and approves in the popup; the page that answers posts
  // the code to the opener, addressed to the app's own origin.
  const cookie = gateway.userCookie;
  const choices = await (await fetch(popup.location.href, { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(choices)![1]!;
  const approved = await fetch(`${gateway.baseUrl}/v1/link/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie },
    body: new URLSearchParams({ ...params, csrf, decision: "approve", credential_id: gateway.planIds[0]! }),
  });
  expect(approved.status).toBe(200);
  const nonce = /script-src 'nonce-([^']+)'/.exec(approved.headers.get("content-security-policy")!)![1]!;
  const html = await approved.text();
  expect(html).toContain(`<script nonce="${nonce}">`);
  const [message, targetOrigin, fallback] = JSON.parse(/const \[message, origin, fallback\] = (.+);\n/.exec(html)![1]!) as [
    Record<string, string>,
    string,
    string,
  ];
  expect(targetOrigin).toBe(new URL(REDIRECT_URI).origin);
  // Without an opener the page sends the result to the redirect URI instead.
  expect(html).toContain("window.location.replace(fallback)");
  expect(Object.fromEntries(new URL(fallback).searchParams)).toEqual({ code: message.code, state: params.state });
  expect(message).toMatchObject({ type: "dari-link", state: params.state });

  // Another window, another origin, or another state is not the answer.
  post({ source: {}, origin: gatewayOrigin, data: message });
  post({ source: popup, origin: "https://evil.example", data: message });
  post({ source: popup, origin: gatewayOrigin, data: { ...message, state: "other" } });
  expect(listeners.size).toBe(1);
  post({ source: popup, origin: gatewayOrigin, data: message });
  const result = await opened;
  expect(result.state).toBe(params.state!);
  expect(popup.closed).toBe(true);
  expect(listeners.size).toBe(0);
  const tokens = await exchange({ ...client, code: result.code, codeVerifier: result.codeVerifier! });
  expect((await chat(gateway, tokens.accessToken)).status).toBe(200);

  // Denying, closing the popup, and a blocked popup each say so.
  const denying = fakeBrowser();
  const denied = DariLink.open({ ...client, window: denying.browser }).catch((error: unknown) => error);
  await until(() => denying.popup.location.href !== "");
  const denyParams = Object.fromEntries(new URL(denying.popup.location.href).searchParams);
  const denial = await fetch(`${gateway.baseUrl}/v1/link/authorize`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ ...denyParams, decision: "deny" }),
  });
  const [denyMessage] = JSON.parse(/const \[message, origin, fallback\] = (.+);\n/.exec(await denial.text())![1]!) as [Record<string, string>];
  denying.post({ source: denying.popup, origin: gatewayOrigin, data: denyMessage });
  expect(await denied).toMatchObject({ code: "access_denied" });

  const closing = fakeBrowser();
  const closed = DariLink.open({ ...client, window: closing.browser }).catch((error: unknown) => error);
  await until(() => closing.popup.location.href !== "");
  closing.popup.close();
  expect(await closed).toMatchObject({ code: "popup_closed" });
  const blocked = await DariLink.open({ ...client, window: { ...closing.browser, open: () => null } }).catch((error: unknown) => error);
  expect(blocked).toMatchObject({ code: "popup_blocked" });

  // A popup that lost its opener lands on the app's redirect URI with the
  // code; that page hands it over on a channel only the app's origin shares.
  const lost = fakeBrowser();
  const Channel = BroadcastChannel as unknown as LinkBrowser["BroadcastChannel"];
  const viaRedirect = DariLink.open({ ...client, window: { ...lost.browser, BroadcastChannel: Channel } });
  await until(() => lost.popup.location.href !== "");
  const lostState = new URL(lost.popup.location.href).searchParams.get("state")!;
  let closedRedirectPage = false;
  const redirectPage = (search: string): LinkBrowser => ({
    ...lost.browser,
    BroadcastChannel: Channel,
    location: { search },
    close: () => void (closedRedirectPage = true),
  });
  expect(DariLink.callback({ window: redirectPage("?unrelated=1") })).toBe(false);
  expect(DariLink.callback({ window: redirectPage("?code=dlk_code_other&state=not-this-one") })).toBe(true);
  expect(DariLink.callback({ window: redirectPage(`?code=dlk_code_x&state=${lostState}`) })).toBe(true);
  expect(closedRedirectPage).toBe(true);
  expect(await viaRedirect).toMatchObject({ code: "dlk_code_x", state: lostState });
});

// A user without a plan adds an API key instead: it serves its provider's
// models to any app, where a Claude plan serves only Claude Code.
test("an API key the user adds on the page serves a plain app on its grant", async () => {
  const gateway = await startStubGateway({ plans: [] });
  stop = gateway.stop;
  const clientId = await registerApp(gateway);
  const verifier = randomBytes(32).toString("base64url");
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  };
  const submit = async (form: Record<string, string>, cookie?: string) =>
    await fetch(`${gateway.baseUrl}/v1/link/authorize`, {
      method: "POST",
      redirect: "manual",
      ...(cookie ? { headers: { cookie } } : {}),
      body: new URLSearchParams({ ...params, ...form }),
    });

  const select = await (await submit({ decision: "select" })).text();
  expect(select).toContain('<p class="label">API Keys</p>');
  for (const provider of ["anthropic", "openai", "openrouter", "vercel-ai-gateway"]) {
    expect(select).toContain(`name="key" value="${provider}"`);
  }
  // An app that can use only some providers' keys is offered only those.
  const some = await (await submit({ decision: "select", key_providers: "anthropic openrouter" })).text();
  expect(some).toContain('name="key" value="openrouter"');
  expect(some).not.toContain('name="key" value="openai"');
  // An app that asks only for plans is offered no keys.
  expect(await (await submit({ decision: "select", plans: "openai_codex" })).text()).not.toContain('name="key"');
  expect(await (await submit({ key: "anthropic" })).text()).toContain("Add Your Anthropic API Key");

  const added = await submit({ decision: "add_key", key_provider: "anthropic", api_key: "sk-ant-api03-test-1234" });
  expect(added.status).toBe(303);
  const cookie = added.headers.getSetCookie().map((value) => value.split(";")[0]!).find((value) => value.startsWith("dari_link_user="))!;
  const choose = await (await fetch(`${gateway.baseUrl}/v1/link/authorize?${new URLSearchParams(params)}`, { headers: { cookie } })).text();
  // The page names the key by its ending, never the key.
  expect(choose).toContain("Key ending 1234");
  expect(choose).not.toContain("sk-ant-api03");
  const keyId = /name="credential_id" value="(key_[0-9a-f]+)" checked/.exec(choose)![1]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(choose)![1]!;
  const approved = await submit({ decision: "approve", csrf, credential_id: keyId }, cookie);
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const { body: tokens } = await token(gateway, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
  expect(tokens.plans as unknown).toEqual([expect.objectContaining({ id: keyId, kind: "api_key", provider: "anthropic", serves: "any_app", label: "Key ending 1234" })]);
  expect(JSON.stringify(tokens)).not.toContain("sk-ant-api03");

  const response = await chat(gateway, tokens.access_token!, "dari/model/anthropic/claude-sonnet-5-5");
  expect(response.status).toBe(200);
  expect(gateway.calls.at(-1)).toMatchObject({ kind: "api_key", token: "sk-ant-api03-test-1234", model: "claude-sonnet-5-5" });
  // It serves only its own provider's models.
  expect((await errorOf(await chat(gateway, tokens.access_token!, "dari/model/openai/gpt-6.1-sol"))).code).toBe("model_not_granted");
});

// A gateway key serves whatever model of its gateway the app names, and an
// OpenAI key its catalog models; the stub stands in for both.
test("the stub gives its user API keys, and a gateway key serves any model of its gateway", async () => {
  const gateway = await startStubGateway({ plans: [], keys: ["openai", "openrouter"] });
  stop = gateway.stop;
  const { tokens, clientId } = await link(gateway, gateway.keyIds);
  expect((tokens.plans as unknown as Array<{ kind: string; provider: string }>).map((plan) => [plan.kind, plan.provider]))
    .toEqual([["api_key", "openai"], ["api_key", "openrouter"]]);

  const viaGateway = await chat(gateway, tokens.access_token!, "dari/model/openrouter/anthropic/claude-sonnet-4.5");
  expect(viaGateway.status).toBe(200);
  expect(gateway.calls.at(-1)).toMatchObject({ kind: "api_key", provider: "openrouter", token: "stub-key-openrouter", path: "/openrouter/chat/completions", model: "anthropic/claude-sonnet-4.5" });
  expect(tokens.plans as unknown).toEqual([
    expect.objectContaining({ title: "OpenAI", provider: "openai" }),
    expect.objectContaining({ title: "OpenRouter", provider: "openrouter", model_prefix: "openrouter/", models: [] }),
  ]);
  const direct = await chat(gateway, tokens.access_token!, "gpt-6.1-sol");
  expect(direct.status).toBe(200);
  expect(gateway.calls.at(-1)).toMatchObject({ kind: "api_key", token: "stub-key-openai", path: "/openai/chat/completions", model: "gpt-6.1-sol" });
  // No key for Vercel's gateway on this grant.
  expect((await errorOf(await chat(gateway, tokens.access_token!, "dari/model/vercel-ai-gateway/openai/gpt-5"))).code).toBe("model_not_granted");

  // A child token pins a gateway model too, and serves that model alone.
  const mint = async (model: string) => await token(gateway, {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: clientId,
    subject_token: tokens.access_token!,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    model,
  });
  const child = await mint("openrouter/openai/gpt-4o-mini");
  expect(child.status).toBe(200);
  expect((await chat(gateway, child.body.access_token!, "dari/model/openrouter/openai/gpt-4o-mini")).status).toBe(200);
  expect(gateway.calls.at(-1)).toMatchObject({ token: "stub-key-openrouter", model: "openai/gpt-4o-mini" });
  expect((await chat(gateway, child.body.access_token!, "dari/model/openrouter/anthropic/claude-sonnet-4.5")).status).not.toBe(200);
  expect((await mint("vercel-ai-gateway/openai/gpt-5")).body.error).toBe("invalid_target");
  expect((await mint("openrouter/")).body.error).toBe("invalid_target");
});

// The stub gateway as a process, for test runners that are not Bun: one JSON
// line to find it by, and the provider calls it made at /served.
test("the stub gateway runs as a process and reports the calls it served", async () => {
  const stub = Bun.spawn([process.execPath, new URL("../self_host/stub_main.ts", import.meta.url).pathname, "--plans", "openai_codex"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  stop = async () => {
    stub.kill();
    await stub.exited;
  };
  const reader = (stub.stdout as ReadableStream<Uint8Array>).getReader();
  let line = "";
  while (!line.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    line += new TextDecoder().decode(value);
  }
  const started = JSON.parse(line) as { planIds: string[]; controlUrl: string; app: StubLinkApp };
  expect(started.planIds).toHaveLength(1);
  // The stub's own app, approved by its user: what Connect with Dari hands a page.
  const connected = (await (await fetch(`${started.controlUrl}/connect`, { method: "POST" })).json()) as { code: string; code_verifier: string };
  const tokens = await exchange({ ...started.app, code: connected.code, codeVerifier: connected.code_verifier });
  const response = await chat({ baseUrl: started.app.gatewayUrl }, tokens.accessToken, "dari/model/openai/gpt-6.1-sol");
  expect(response.status).toBe(200);
  const served = (await (await fetch(`${started.controlUrl}/served`)).json()) as { calls: Array<Record<string, unknown>> };
  expect(served.calls).toEqual([expect.objectContaining({ kind: "openai_codex", model: "gpt-6.1-sol", path: "/backend-api/codex/responses" })]);
});

test("a browser app calls the model endpoints from its own origin", async () => {
  const gateway = await startStubGateway({ plans: ["openai_codex"] });
  stop = gateway.stop;
  const { tokens } = await link(gateway, [gateway.planIds[0]!]);
  const origin = "https://app.example";

  // The preflight a browser sends first, for each endpoint and the headers each client sends.
  for (const [path, method, asked] of [
    ["/v1/chat/completions", "POST", "authorization,content-type,x-stainless-os"],
    ["/v1/responses", "POST", "authorization,content-type,x-dari-tags"],
    ["/v1/messages", "POST", "x-api-key,anthropic-version,content-type"],
    ["/v1/models", "GET", "authorization"],
  ] as const) {
    const preflight = await fetch(`${gateway.baseUrl}${path}`, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": method, "access-control-request-headers": asked },
    });
    expect([path, preflight.status]).toEqual([path, 204]);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toContain(method);
    expect(preflight.headers.get("access-control-allow-headers")).toBe(asked);
  }

  // The request itself: the page can read the reply, and its headers.
  const chat = (accessToken: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = { origin }) =>
    fetch(`${gateway.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "dari/routing", messages: [{ role: "user", content: "hello" }], ...extra }),
    });
  const reply = await chat(tokens.access_token!);
  expect(reply.status).toBe(200);
  expect(reply.headers.get("access-control-allow-origin")).toBe("*");
  expect(reply.headers.get("access-control-expose-headers")).toBe("*");
  expect(reply.headers.get("x-request-id")).toBeTruthy();
  expect(((await reply.json()) as { choices: unknown[] }).choices).toHaveLength(1);

  // A stream, and a refusal the page must read to show Reconnect.
  const stream = await chat(tokens.access_token!, { stream: true });
  expect(stream.headers.get("access-control-allow-origin")).toBe("*");
  expect(await stream.text()).toContain("[DONE]");
  const refused = await chat("dlk_at_unknown");
  expect(refused.status).toBe(401);
  expect(refused.headers.get("access-control-allow-origin")).toBe("*");
  const models = await fetch(`${gateway.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${tokens.access_token!}`, origin } });
  expect(models.headers.get("access-control-allow-origin")).toBe("*");

  // A request with no Origin (a server, a coding agent) is served as before.
  const server = await chat(tokens.access_token!, {}, {});
  expect(server.status).toBe(200);
  expect(server.headers.get("access-control-allow-origin")).toBeNull();
  expect(server.headers.get("access-control-expose-headers")).toBeNull();
  expect((await fetch(`${gateway.baseUrl}/v1/chat/completions`, { method: "OPTIONS" })).status).toBe(404);
});

// /v1/link/usage as the wire carries it.
type WireUsage = Record<string, unknown> & { requests: number; complete_through: string | null; by_tag?: unknown[] };
