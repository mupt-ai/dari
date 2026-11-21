import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import { handleLinkRequest, pkceChallenge } from "./endpoints.js";
import { parseGatewayConfig } from "../self_host/config.js";
import { SqliteLinkStore } from "./sqlite_store.js";
import { createSelfHostedPlatform } from "../self_host/platform.js";
import { PrefixStore } from "../self_host/prefix_store.js";
import { RouterModelStore } from "../self_host/router_models.js";
import { RouterSpecStore } from "../self_host/router_specs.js";
import { SecretBox } from "../self_host/secret_box.js";
import { SessionPinStore } from "../self_host/session_pin_store.js";
import { SubscriptionStore } from "../self_host/subscriptions/index.js";
import { codexAccessToken, fakeFetch, jsonResponse } from "../self_host/subscriptions/test_support.js";
import { addTestApp, approveTestGrant } from "./test_support.js";
import type { LinkSignIn } from "../platform/platform.js";
import { ActivityStore } from "../self_host/activity_store.js";

const BASE = "http://gateway.test";
const REDIRECT_URI = "http://127.0.0.1:9999/callback";

// A gateway whose provider sign-ins answer from `responses`, and a browser
// that keeps the approval page's cookies; with `signIn`, a platform whose
// users sign in with an account.
function gateway(responses: Array<() => Response>, signIn?: LinkSignIn) {
  const db = new Database(":memory:");
  const secrets = new SecretBox([randomBytes(32)]);
  const subscriptions = new SubscriptionStore(db, secrets);
  const links = new SqliteLinkStore(db, secrets);
  const selfHosted = createSelfHostedPlatform({
    config: parseGatewayConfig({ routers: { default: { models: ["anthropic/claude-sonnet-5-5", "openai/gpt-5.5"] } } }),
    activity: new ActivityStore(db),
    routerModels: new RouterModelStore(db),
    routerSpecs: new RouterSpecStore(db),
    gatewayKeys: ["k"],
    subscriptions,
    links,
    prefixes: new PrefixStore(db),
    sessionPins: new SessionPinStore(db),
    providerApiKey: async () => undefined,
    autoRouting: false,
    env: {},
    fetch: fakeFetch(responses),
  });
  const withSignIn = (signIn: LinkSignIn | undefined) => signIn === undefined
    ? selfHosted
    : { ...selfHosted, link: { ...selfHosted.link!, approval: { ...selfHosted.link!.approval, signIn } } };
  let platform = withSignIn(signIn);
  const app = addTestApp(links, "Notes App", [REDIRECT_URI], false);
  const params = {
    response_type: "code",
    client_id: app.clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: pkceChallenge("v".repeat(43)),
    code_challenge_method: "S256",
    client: "claude_code codex",
  };
  const cookies = new Map<string, string>();
  const send = async (request: Request): Promise<Response> => {
    request.headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    const response = await handleLinkRequest(request, platform);
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [name, ...value] = pair!.split("=");
      if (value.join("=") === "") cookies.delete(name!);
      else cookies.set(name!, value.join("="));
    }
    return response;
  };
  return {
    subscriptions,
    links,
    cookies,
    // The same gateway with a sign-in added or taken away.
    setSignIn: (next: LinkSignIn | undefined) => { platform = withSignIn(next); },
    get: async (path: string) => await send(new Request(`${BASE}${path}`)),
    // The approval page as the browser lands on it, following its own redirect.
    page: async () => {
      const open = () => send(new Request(`${BASE}/v1/link/authorize?${new URLSearchParams(params)}`));
      const response = await open();
      return await (response.status === 303 ? await open() : response).text();
    },
    submit: async (form: Record<string, string>, headers: Record<string, string> = {}) =>
      await send(new Request(`${BASE}/v1/link/authorize`, { method: "POST", headers, body: new URLSearchParams({ ...params, ...form }) })),
    connections: async () => await (await send(new Request(`${BASE}/v1/link/connections`))).text(),
    manage: async (form: Record<string, string>) =>
      await send(new Request(`${BASE}/v1/link/connections`, { method: "POST", body: new URLSearchParams(form) })),
  };
}

// A self-hosted gateway needs no account: the user picks a plan, signs in to its provider,
// and allows the app; the cookie that remembers them makes the next app one click.
test("a new user connects plans by signing in to their providers, then allows the app", async () => {
  const browser = gateway([
    jsonResponse({ access_token: "sk-ant-oat01-a", refresh_token: "r", expires_in: 3600, account: { email_address: "me@example.com" } }),
    jsonResponse({ device_auth_id: "dev_1", user_code: "ABCD-1234" }),
    jsonResponse({}, 403),
    jsonResponse({ authorization_code: "code", code_verifier: "verifier" }),
    jsonResponse({ access_token: codexAccessToken("acct_1"), refresh_token: "r2", expires_in: 3600 }),
  ]);

  expect(await browser.page()).toContain("Notes App Uses Dari To Connect Your AI Subscriptions");
  const select = await (await browser.submit({ decision: "select" })).text();
  expect(select).toContain('name="connect" value="anthropic_claude_code"');
  expect(select).toContain('name="connect" value="openai_codex"');

  // Claude shows the user a code to bring back.
  expect((await browser.submit({ connect: "anthropic_claude_code" })).status).toBe(303);
  const claude = await browser.page();
  expect(claude).toContain('href="https://claude.com/cai/oauth/authorize?');
  expect(claude).toContain('name="authorization_response"');
  const state = new URL(/href="([^"]+)"/.exec(claude)![1]!.replaceAll("&amp;", "&")).searchParams.get("state")!;
  // A code for another sign-in is refused on the page, which stays open.
  expect(await (await browser.submit({ decision: "complete", authorization_response: "code#other" })).text())
    .toContain("does not match");
  expect((await browser.submit({ decision: "complete", authorization_response: `code#${state}` })).status).toBe(303);

  // The plan is there, ticked, and one more can be connected.
  const first = await browser.page();
  expect(first).toContain("Share With Notes App");
  // Without accounts the cookie is who they are: there is nothing to sign out of.
  expect(first).not.toContain('value="sign_out"');
  expect(first).toContain("me@example.com");
  expect(first).toMatch(/name="credential_id" value="cred_[0-9a-f]+" checked/);

  // ChatGPT gives the user a code to enter there; the page asks until they have.
  expect((await browser.submit({ connect: "openai_codex" })).status).toBe(303);
  const waiting = await browser.page();
  expect(waiting).toContain("ABCD-1234");
  expect(waiting).toContain('<meta http-equiv="refresh"');
  expect(await browser.page()).toContain("Share With Notes App");

  const choose = await browser.page();
  const ids = [...choose.matchAll(/name="credential_id" value="([^"]+)" checked/g)].map((match) => match[1]!);
  expect(ids).toHaveLength(2);
  const csrf = /name="csrf" value="([^"]+)"/.exec(choose)![1]!;
  const allowed = await browser.submit({ decision: "approve", csrf, credential_id: ids[0]! });
  expect(allowed.status).toBe(303);
  expect(new URL(allowed.headers.get("location")!).searchParams.get("code")).toStartWith("dlk_code_");

  // The plans are the user's alone: no gateway key is served by them, and
  // another browser starts as a new user.
  expect(browser.subscriptions.list()).toEqual([]);
  const owners = new Set(browser.subscriptions.withIds(new Set(ids)).map((plan) => plan.owner));
  expect(owners.size).toBe(1);
  expect([...owners][0]).toStartWith("lu_");
  // The user deletes what Dari holds on the connections page, which the
  // approval page links to: it needs their form token, and a grant left with
  // nothing is revoked.
  expect(choose).toContain('href="/v1/link/connections"');
  await browser.manage({ decision: "remove_confirmed", remove_id: ids[0]!, csrf: "forged" });
  expect(browser.subscriptions.withIds(new Set(ids))).toHaveLength(2);
  await browser.manage({ decision: "remove_confirmed", remove_id: ids[0]!, csrf });
  expect(browser.subscriptions.withIds(new Set(ids)).map((plan) => plan.id)).toEqual([ids[1]!]);
  expect(browser.links.grants(null)).toEqual([]);

  browser.cookies.clear();
  expect(await browser.page()).toContain("Uses Dari To Connect");
});

// GitHub answers a sign-in still awaiting approval with HTTP 200, and a Token
// Pass is a key the user creates at Vercel: both connect from the page.
test("a user connects GitHub Copilot by its device code and Vercel Token Pass by a pasted key", async () => {
  const browser = gateway([
    jsonResponse({ device_code: "gh-dev", user_code: "WXYZ-0001", verification_uri: "https://github.com/login/device", expires_in: 900 }),
    jsonResponse({ error: "authorization_pending" }),
    jsonResponse({ access_token: "gho_github" }),
    jsonResponse({ token: "tid=1;proxy-ep=proxy.individual.githubcopilot.com", expires_at: Math.floor(Date.now() / 1000) + 1800 }),
    jsonResponse({ login: "octocat" }),
  ]);
  await browser.page();
  const select = await (await browser.submit({ decision: "select" })).text();
  expect(select).toContain('name="connect" value="github_copilot"');
  expect(select).toContain('name="connect" value="vercel_token_pass"');

  expect((await browser.submit({ connect: "github_copilot" })).status).toBe(303);
  // The page asks GitHub on each load until the user approves.
  const waiting = await browser.page();
  expect(waiting).toContain("WXYZ-0001");
  expect(waiting).toContain("Waiting for your approval");
  expect(await browser.page()).toContain("octocat");

  expect((await browser.submit({ connect: "vercel_token_pass" })).status).toBe(303);
  const vercel = await browser.page();
  expect(vercel).toContain("Add Your Vercel Token Pass Key");
  expect(vercel).toContain('href="https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Ftoken-pass"');
  expect(await (await browser.submit({ decision: "complete", authorization_response: "not a key" })).text())
    .toContain("Paste the Token Pass key you created at Vercel.");
  expect((await browser.submit({ decision: "complete", authorization_response: "vck_pass" })).status).toBe(303);
  const plans = await browser.page();
  expect([...plans.matchAll(/name="credential_id" value="[^"]+" checked/g)]).toHaveLength(2);
  expect(browser.subscriptions.withIds(new Set(
    [...plans.matchAll(/name="credential_id" value="([^"]+)"/g)].map((match) => match[1]!),
  )).map((plan) => [plan.provider, plan.accessToken])).toEqual([
    ["github_copilot", "tid=1;proxy-ep=proxy.individual.githubcopilot.com"],
    ["vercel_token_pass", "vck_pass"],
  ]);
});

// Another site's form arrives without the user's cookie; it must not replace
// their identity, or plant a key of its own in a new one.
test("the page takes no submission another site sends", async () => {
  const browser = gateway([]);
  await browser.page();
  const before = new Map(browser.cookies);
  const forged = await browser.submit({ decision: "add_key", key_provider: "openai", api_key: "sk-attacker" }, { "sec-fetch-site": "cross-site", origin: "https://evil.example" });
  expect(forged.status).toBe(403);
  expect(browser.cookies).toEqual(before);
  expect((await browser.submit({ decision: "select" }, { origin: "https://evil.example" })).status).toBe(403);
});

// A gateway that would store other people's tokens unencrypted takes none.
test("without an encryption key the page connects nothing and says why", async () => {
  const db = new Database(":memory:");
  const subscriptions = new SubscriptionStore(db);
  const links = new SqliteLinkStore(db);
  const platform = createSelfHostedPlatform({
    config: parseGatewayConfig({ routers: { default: { models: ["openai/gpt-5.5"] } } }),
    activity: new ActivityStore(db),
    routerModels: new RouterModelStore(db),
    routerSpecs: new RouterSpecStore(db),
    gatewayKeys: ["k"],
    subscriptions,
    links,
    prefixes: new PrefixStore(db),
    sessionPins: new SessionPinStore(db),
    providerApiKey: async () => undefined,
    autoRouting: false,
    env: {},
    fetch: fakeFetch([]),
  });
  const app = addTestApp(links, "Notes App", [REDIRECT_URI], false);
  const submit = async (form: Record<string, string>) =>
    await (await handleLinkRequest(new Request(`${BASE}/v1/link/authorize`, {
      method: "POST",
      body: new URLSearchParams({
        response_type: "code",
        client_id: app.clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: pkceChallenge("v".repeat(43)),
        code_challenge_method: "S256",
        ...form,
      }),
    }), platform)).text();
  expect(await submit({ connect: "openai_codex" })).toContain("DARI_GATEWAY_ENCRYPTION_KEY");
  expect(await submit({ decision: "add_key", key_provider: "openai", api_key: "sk-test" })).toContain("DARI_GATEWAY_ENCRYPTION_KEY");
  expect(subscriptions.owned("lu_any")).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS n FROM link_api_keys").get()).toEqual({ n: 0 });
});

// The user manages what they connected on the connections page, known by the
// same cookie: each app's spend limits, Disconnect, and their plans.
test("the connections page sets a grant's spend limits, disconnects it, and removes plans", async () => {
  const browser = gateway([
    jsonResponse({ access_token: "sk-ant-oat01-a", refresh_token: "r", expires_in: 3600, account: { email_address: "me@example.com" } }),
  ]);
  expect(await browser.connections()).toContain("No apps are connected in this browser");

  await browser.submit({ connect: "anthropic_claude_code" });
  const claude = await browser.page();
  const state = new URL(/href="([^"]+)"/.exec(claude)![1]!.replaceAll("&amp;", "&")).searchParams.get("state")!;
  await browser.submit({ decision: "complete", authorization_response: `code#${state}` });
  const choose = await browser.page();
  const id = /name="credential_id" value="([^"]+)"/.exec(choose)![1]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(choose)![1]!;
  await browser.submit({ decision: "approve", csrf, credential_id: id });
  const [grant] = browser.links.grants(null);

  const page = await browser.connections();
  expect(page).toContain("Notes App");
  expect(page).toContain('aria-label="Shares Claude"');
  expect(page).toContain(`id="${grant!.id}"`);

  // A limit is dollars a month on a shared plan; a forged form changes nothing.
  expect(page).toContain("Set Limit");
  expect(page).not.toContain("Most Tokens");
  expect(await (await browser.manage({ csrf, grant_id: grant!.id, decision: "limits", [`usd_${id}`]: "lots" })).text())
    .toContain("dollar amount");
  await browser.manage({ csrf: "forged", grant_id: grant!.id, decision: "limits", [`usd_${id}`]: "10" });
  expect(browser.links.grant(grant!.id)!.limits).toEqual([]);
  expect((await browser.manage({ csrf, grant_id: grant!.id, decision: "limits", [`usd_${id}`]: "$10" })).status).toBe(303);
  expect(browser.links.grant(grant!.id)!.limits).toEqual([{ credentialId: id, monthlyUsd: 10 }]);
  expect(await browser.connections()).toContain('value="10"');

  await browser.manage({ csrf, grant_id: grant!.id, decision: "disconnect" });
  expect(browser.links.grants(null)).toEqual([]);
  expect(await browser.connections()).toContain("No apps are connected.");

  // Removing a plan asks once.
  expect(await (await browser.manage({ csrf, remove_id: id, decision: "remove" })).text()).toContain("Remove Claude");
  await browser.manage({ csrf, remove_id: id, decision: "remove_confirmed" });
  expect(browser.subscriptions.withIds(new Set([id]))).toEqual([]);
});

// On a platform with accounts the user signs in first, and is that account:
// the plans it already has are there to share, in any browser.
test("a user who signs in with their account finds the plans it has", async () => {
  const tickets = new Map<string, { subject: string; state: string; issuedAt: number }>();
  const browser = gateway([], {
    url: () => "https://app.test/link/sign-in",
    signOutUrl: () => "https://app.test/link/sign-out",
    redeem: async (ticket) => tickets.get(ticket) ?? null,
  });
  browser.links.addKey("usr_me", "openrouter", "sk-or-mine");

  // Nothing happens before they sign in: every step goes to the sign-in.
  expect(await browser.page()).toContain("Notes App Uses Dari To Connect Your AI Subscriptions");
  const sent = await browser.submit({ decision: "select" });
  expect(sent.status).toBe(303);
  const at = new URL(sent.headers.get("location")!);
  expect(`${at.origin}${at.pathname}`).toBe("https://app.test/link/sign-in");
  const state = at.searchParams.get("state")!;
  const next = at.searchParams.get("next")!;
  expect(next).toStartWith("/v1/link/authorize?");
  expect(browser.cookies.has("dari_link_sign_in")).toBe(true);

  // A ticket for another browser's state, a stale one, or a `next` off the
  // Link pages signs no one in.
  const session = (ticket: string, to = next) => browser.get(`/v1/link/session?${new URLSearchParams({ ticket, next: to })}`);
  tickets.set("other", { subject: "usr_me", state: "someone-elses", issuedAt: Date.now() });
  tickets.set("stale", { subject: "usr_me", state, issuedAt: Date.now() - 10 * 60 * 1000 });
  tickets.set("good", { subject: "usr_me", state, issuedAt: Date.now() });
  for (const refused of [await session("other"), await session("stale"), await session("good", "https://evil.test/")]) {
    expect(refused.status).toBe(400);
  }
  expect(browser.cookies.has("dari_link_user")).toBe(false);

  const signedIn = await session("good");
  expect(signedIn.status).toBe(303);
  expect(signedIn.headers.get("location")).toBe(next);
  // Signed in for a month; the platform's sign-in is a click away after that.
  expect(signedIn.headers.getSetCookie().find((cookie) => cookie.startsWith("dari_link_user="))).toContain(`Max-Age=${30 * 24 * 60 * 60};`);
  expect(browser.cookies.has("dari_link_sign_in")).toBe(false);
  const choose = await browser.page();
  expect(choose).toContain("Share With Notes App");
  expect(choose).toContain("Key ending mine");

  // They can sign out, from the approval page or the connections page. The
  // platform ends its own sign-in too, then returns them to the page, so they
  // can sign in as another account.
  const signedOut = await browser.submit({ decision: "sign_out" });
  expect(signedOut.status).toBe(303);
  const out = new URL(signedOut.headers.get("location")!);
  expect(`${out.origin}${out.pathname}`).toBe("https://app.test/link/sign-out");
  expect(out.searchParams.get("next")).toStartWith("/v1/link/authorize?");
  expect(browser.cookies.has("dari_link_user")).toBe(false);
  expect(await browser.page()).toContain("Notes App Uses Dari To Connect Your AI Subscriptions");
  // The ticket that signed them in does not sign them back in.
  expect((await session("good")).status).toBe(400);
  const again = new URL((await browser.submit({ decision: "select" })).headers.get("location")!).searchParams.get("state")!;
  tickets.set("again", { subject: "usr_me", state: again, issuedAt: Date.now() });
  expect((await session("again")).status).toBe(303);
  const connections = await browser.connections();
  expect(connections).toContain('value="sign_out"');
  const csrf = /name="csrf" value="([^"]+)"/.exec(connections)![1]!;
  browser.cookies.set("dari_link_connect", "a-sign-in-under-way");
  const managedOut = await browser.manage({ decision: "sign_out", csrf });
  expect(managedOut.status).toBe(303);
  expect(managedOut.headers.get("location")).toBe(`https://app.test/link/sign-out?${new URLSearchParams({ next: "/v1/link/connections" })}`);
  expect(browser.cookies.has("dari_link_user")).toBe(false);
  expect(browser.cookies.has("dari_link_connect")).toBe(false);

  // The connections page asks a browser with no one signed in to sign in.
  browser.cookies.clear();
  expect(await (await browser.get("/v1/link/connections")).text()).toContain('value="sign_in"');
  const fromConnections = await browser.manage({ decision: "sign_in" });
  expect(new URL(fromConnections.headers.get("location")!).searchParams.get("next")).toBe("/v1/link/connections");
});

test("a browser Link remembered before it had accounts signs in", async () => {
  const signIn: LinkSignIn = { url: () => "https://app.test/link/sign-in", signOutUrl: () => "https://app.test/link/sign-out", redeem: async () => null };
  const browser = gateway([jsonResponse({ data: [] }), jsonResponse({ device_auth_id: "dev_1", user_code: "ABCD-1234" })]);
  await browser.page();
  expect((await browser.submit({ decision: "add_key", key_provider: "openrouter", api_key: "sk-or-before" })).status).toBe(303);
  expect(await browser.connections()).toContain("Key ending fore");
  expect((await browser.submit({ connect: "openai_codex" })).status).toBe(303);

  // Neither that user nor their provider sign-in under way carries over.
  browser.setSignIn(signIn);
  expect(await browser.page()).toContain("Notes App Uses Dari To Connect Your AI Subscriptions");
  expect(new URL((await browser.submit({ decision: "select" })).headers.get("location")!).pathname).toBe("/link/sign-in");
  expect(await browser.connections()).toContain('value="sign_in"');
});

