import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import { handleLinkRequest, pkceChallenge } from "./endpoints.js";
import { parseGatewayConfig } from "../self_host/config.js";
import { SqliteLinkStore } from "./sqlite_store.js";
import { createSelfHostedPlatform } from "../self_host/platform.js";
import { PrefixStore } from "../self_host/prefix_store.js";
import { RouterModelStore } from "../self_host/router_models.js";
import { SecretBox } from "../self_host/secret_box.js";
import { SessionPinStore } from "../self_host/session_pin_store.js";
import { SubscriptionStore } from "../self_host/subscriptions/index.js";
import { codexAccessToken, fakeFetch, jsonResponse } from "../self_host/subscriptions/test_support.js";
import { addTestApp, approveTestGrant } from "./test_support.js";

const BASE = "http://gateway.test";
const REDIRECT_URI = "http://127.0.0.1:9999/callback";

// A gateway whose provider sign-ins answer from `responses`, and a browser
// that keeps the approval page's cookies.
function gateway(responses: Array<() => Response>) {
  const db = new Database(":memory:");
  const secrets = new SecretBox([randomBytes(32)]);
  const subscriptions = new SubscriptionStore(db, secrets);
  const links = new SqliteLinkStore(db, secrets);
  const platform = createSelfHostedPlatform({
    config: parseGatewayConfig({ routers: { default: { models: ["anthropic/claude-sonnet-5-5", "openai/gpt-5.5"] } } }),
    routerModels: new RouterModelStore(db),
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

// Dari Link needs no account: the user picks a plan, signs in to its provider,
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
  // The user can delete what Dari holds: it asks once, needs their form token,
  // and a grant left with nothing is revoked.
  expect(await (await browser.submit({ remove: ids[0]! })).text()).toContain("Remove Claude");
  await browser.submit({ decision: "remove", remove_id: ids[0]!, csrf: "forged" });
  expect(browser.subscriptions.withIds(new Set(ids))).toHaveLength(2);
  await browser.submit({ decision: "remove", remove_id: ids[0]!, csrf });
  expect(browser.subscriptions.withIds(new Set(ids)).map((plan) => plan.id)).toEqual([ids[1]!]);
  expect(browser.links.grants(null)).toEqual([]);

  browser.cookies.clear();
  expect(await browser.page()).toContain("Uses Dari To Connect");
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
    routerModels: new RouterModelStore(db),
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
// same cookie: each app's budget, Disconnect, and their plans.
test("the connections page sets a grant's budget, disconnects it, and removes plans", async () => {
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
  expect(page).toContain("Shares Claude");
  expect(page).toContain(`id="${grant!.id}"`);

  // A limit is whole tokens; a forged form changes nothing.
  expect(await (await browser.manage({ csrf, grant_id: grant!.id, decision: "budget", max_300: "lots" })).text())
    .toContain("whole number of tokens");
  await browser.manage({ csrf: "forged", grant_id: grant!.id, decision: "budget", max_300: "1000" });
  expect(browser.links.grant(grant!.id)!.budget).toEqual([]);
  expect((await browser.manage({ csrf, grant_id: grant!.id, decision: "budget", max_300: "1,000", max_10080: "" })).status).toBe(303);
  expect(browser.links.grant(grant!.id)!.budget).toEqual([{ windowMinutes: 300, maxTokens: 1000 }]);
  expect(await browser.connections()).toContain('value="1000"');

  await browser.manage({ csrf, grant_id: grant!.id, decision: "disconnect" });
  expect(browser.links.grants(null)).toEqual([]);
  expect(await browser.connections()).toContain("No apps are connected.");

  // Removing a plan asks once.
  expect(await (await browser.manage({ csrf, remove_id: id, decision: "remove" })).text()).toContain("Remove Claude");
  await browser.manage({ csrf, remove_id: id, decision: "remove_confirmed" });
  expect(browser.subscriptions.withIds(new Set([id]))).toEqual([]);
});
