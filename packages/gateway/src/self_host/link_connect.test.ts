import { afterEach, expect, test } from "bun:test";

import {
  authorizeUrl,
  createAuthorization,
  DariLink,
  exchange,
  type LinkBrowser,
  type LinkExit,
  type LinkStep,
} from "../link_client.js";
import { startStubGateway, type StubGateway } from "./stub_gateway.js";

// Connect with Dari as an app builds it: update mode, plan states, the stub's
// approval driver and error states, and the popup's step events.

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

const REDIRECT_URI = "http://127.0.0.1:9999/callback";

async function start(plans: Array<"openai_codex" | "anthropic_claude_code">): Promise<StubGateway & { clientId: string }> {
  const gateway = await startStubGateway({ plans });
  stop = gateway.stop;
  const response = await fetch(`${gateway.baseUrl}/v1/link/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Bench", redirect_uris: [REDIRECT_URI] }),
  });
  const { client_id: clientId } = (await response.json()) as { client_id: string };
  return Object.assign(gateway, { clientId });
}

async function connect(gateway: StubGateway & { clientId: string }, options: { credentialIds?: string[]; grantId?: string } = {}) {
  const client = { gatewayUrl: gateway.baseUrl, clientId: gateway.clientId, redirectUri: REDIRECT_URI };
  const request = await authorizeUrl({ ...client, ...(options.grantId ? { grantId: options.grantId } : {}) });
  const { message, targetOrigin } = await gateway.approve(request.url, options);
  expect(targetOrigin).toBe(new URL(REDIRECT_URI).origin);
  expect(message.state).toBe(request.state);
  return await exchange({ ...client, code: message.code!, codeVerifier: request.codeVerifier });
}

async function grantOf(gateway: StubGateway, accessToken: string) {
  const response = await fetch(`${gateway.baseUrl}/v1/link/grant`, { headers: { authorization: `Bearer ${accessToken}` } });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    grant_id: string;
    user: unknown;
    manage_url: string | null;
    state: string;
    available_at: string | null;
    plans: Array<{ id: string; state: string; available_at: string | null; usage: Array<{ utilization: number }> }>;
  };
}

async function chat(gateway: StubGateway, accessToken: string) {
  return await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "dari/routing", messages: [{ role: "user", content: "hello" }] }),
  });
}

test("update mode changes a grant's plans in place, and its tokens keep working", async () => {
  const gateway = await start(["openai_codex", "openai_codex"]);
  const [a, b] = gateway.planIds as [string, string];
  const first = await connect(gateway, { credentialIds: [a] });
  expect(first.grantId).toStartWith("lgr_");
  // A self-hosted gateway has no accounts or Connected Apps page.
  expect(first.user).toBeNull();
  expect(first.manageUrl).toBeNull();

  // The page opens on the grant as it stands: titled for an update, its plan ticked.
  const request = await authorizeUrl({ gatewayUrl: gateway.baseUrl, clientId: gateway.clientId, redirectUri: REDIRECT_URI, grantId: first.grantId! });
  const cookie = gateway.userCookie;
  const page = await (await fetch(request.url, { headers: { cookie } })).text();
  expect(page).toContain("<title>Update Plans For Bench</title>");
  expect(page).toContain(`value="${a}" checked`);
  expect(page).not.toContain(`value="${b}" checked`);

  const updated = await connect(gateway, { credentialIds: [b], grantId: first.grantId! });
  expect(updated.grantId).toBe(first.grantId);
  // The first tokens still work, now on the new plan only.
  expect((await chat(gateway, first.accessToken)).status).toBe(200);
  expect((await grantOf(gateway, first.accessToken)).plans.map((plan) => plan.id)).toEqual([b]);

  // A grant that is not this app's, or this app's grant opened by anyone but
  // the user who approved it, starts a new connection and changes nothing.
  const unknown = await authorizeUrl({ gatewayUrl: gateway.baseUrl, clientId: gateway.clientId, redirectUri: REDIRECT_URI, grantId: "lgr_nope" });
  for (const [url, headers] of [[unknown.url, { cookie }], [request.url, {}]] as Array<[string, Record<string, string>]>) {
    const page = await fetch(url, { headers, redirect: "manual" });
    expect(page.headers.get("location") ?? "").not.toContain("error=");
    expect(await page.text()).not.toContain('name="grant_id"');
  }
  expect((await grantOf(gateway, first.accessToken)).plans.map((plan) => plan.id)).toEqual([b]);
});

test("each plan says whether it serves the app now, and the stub forces each state", async () => {
  const gateway = await start(["openai_codex"]);
  const tokens = await connect(gateway);
  expect(gateway.messages).toHaveLength(1);
  const listed = (await (await fetch(`${gateway.controlUrl}/messages`)).json()) as { messages: unknown[] };
  expect(listed.messages).toHaveLength(1);
  expect((await grantOf(gateway, tokens.accessToken)).plans[0]).toMatchObject({ state: "ready", available_at: null });

  // A reply reporting usage fills the plan's windows, and the request's own
  // usage is readable by its X-Request-Id once recorded.
  gateway.setState({ weekly: 0.1 });
  const served = await chat(gateway, tokens.accessToken);
  expect(served.status).toBe(200);
  const requestId = served.headers.get("x-request-id")!;
  const one = async (id: string) =>
    await fetch(`${gateway.baseUrl}/v1/link/usage/requests/${id}`, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
  let recorded = await one(requestId);
  for (let attempt = 0; attempt < 50 && recorded.status === 404; attempt += 1) {
    await Bun.sleep(20);
    recorded = await one(requestId);
  }
  expect(recorded.status).toBe(200);
  expect(await recorded.json()).toMatchObject({ requests: 1, input_tokens: 10, by_model: [{ model: "openai/gpt-5.5" }] });
  expect((await one("not-a-request")).status).toBe(404);
  expect((await grantOf(gateway, tokens.accessToken)).plans[0]!.usage[0]!.utilization).toBeCloseTo(0.1);

  // Past the user's token budget: the grant is at budget_limit until it rolls on.
  const put = await fetch(`${gateway.baseUrl}/v1/link/grants/${tokens.grantId}/budget`, {
    method: "PUT",
    headers: { authorization: "Bearer k", "content-type": "application/json" },
    body: JSON.stringify({ budget: [{ window_minutes: 300, max_tokens: 10 }] }),
  });
  expect(put.status).toBe(200);
  const limited = await grantOf(gateway, tokens.accessToken);
  expect(limited).toMatchObject({ state: "budget_limit", plans: [{ state: "ready" }] });
  expect(Date.parse(limited.available_at!)).toBeGreaterThan(Date.now());
  const capped = await chat(gateway, tokens.accessToken);
  expect(capped.status).toBe(424);
  expect(((await capped.json()) as { error: { code: string } }).error.code).toBe("grant_budget_exhausted");

  // At the plan's own limit: plan_limit.
  await fetch(`${gateway.baseUrl}/v1/link/grants/${tokens.grantId}/budget`, {
    method: "PUT",
    headers: { authorization: "Bearer k", "content-type": "application/json" },
    body: JSON.stringify({ budget: [] }),
  });
  await fetch(`${gateway.controlUrl}/state`, { method: "POST", body: JSON.stringify({ limited: true }) });
  expect((await chat(gateway, tokens.accessToken)).status).not.toBe(200);
  const plan = (await grantOf(gateway, tokens.accessToken)).plans[0]!;
  expect(plan.state).toBe("plan_limit");
  expect(Date.parse(plan.available_at!)).toBeGreaterThan(Date.now());
  const exhausted = await chat(gateway, tokens.accessToken);
  expect(((await exhausted.json()) as { error: { code: string } }).error.code).toBe("subscription_exhausted");
});

// The parts of a window a popup test needs, posting what the gateway's pages post.
function fakeBrowser() {
  const listeners = new Set<(event: { source: unknown; origin: string; data: unknown }) => void>();
  const popup = { closed: false, close() { popup.closed = true; }, location: { href: "" } };
  const browser: LinkBrowser = {
    open: () => popup,
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
  };
  const post = (data: unknown, origin: string) => {
    for (const listener of [...listeners]) listener({ source: popup, origin, data });
  };
  return { browser, popup, post };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await Bun.sleep(5);
  expect(condition()).toBe(true);
}

// The step event a page posts to the window that opened it.
function stepEvent(html: string): [Record<string, string>, string] {
  return JSON.parse(/const \[event, eventOrigin\] = (.+);\n/.exec(html)![1]!) as [Record<string, string>, string];
}

test("the popup tells the app each step the user reached and where they left", async () => {
  const gateway = await start(["openai_codex"]);
  const origin = new URL(gateway.baseUrl).origin;
  const { browser, popup, post } = fakeBrowser();
  const steps: LinkStep[] = [];
  const exits: LinkExit[] = [];
  // The options may come late, after the popup is open.
  const opened = DariLink.open(async () => ({
    gatewayUrl: gateway.baseUrl,
    clientId: gateway.clientId,
    redirectUri: REDIRECT_URI,
    onEvent: (step) => steps.push(step),
    onExit: (exit) => exits.push(exit),
  }), browser).catch((error: unknown) => error);
  await until(() => popup.location.href !== "");

  // A new user starts at connecting a plan.
  const introPage = await (await fetch(popup.location.href)).text();
  const [introEvent, eventOrigin] = stepEvent(introPage);
  expect(eventOrigin).toBe(new URL(REDIRECT_URI).origin);
  expect(introEvent).toMatchObject({ type: "dari-link-event", version: "1", event: "connect_subscription" });
  // A dari-link message with neither code nor error is no result.
  post({ type: "dari-link", state: introEvent.state }, origin);
  post(introEvent, origin);

  const choose = await (await fetch(popup.location.href, { headers: { cookie: gateway.userCookie } })).text();
  // End-user copy names no CLI command, and a purpose ends in one period.
  expect(choose).not.toContain("dari link");
  expect(choose).not.toContain("..");
  post(stepEvent(choose)[0], origin);
  expect(steps).toEqual(["connect_subscription", "choose_plans"]);

  // Closing now leaves at choose_plans.
  popup.close();
  expect(await opened).toMatchObject({ code: "popup_closed" });
  expect(exits).toEqual([{ error: "popup_closed", step: "choose_plans" }]);

  // Denying leaves at denied.
  const denying = fakeBrowser();
  const denyExits: LinkExit[] = [];
  const denied = DariLink.open({
    gatewayUrl: gateway.baseUrl,
    clientId: gateway.clientId,
    redirectUri: REDIRECT_URI,
    window: denying.browser,
    onExit: (exit) => denyExits.push(exit),
  }).catch((error: unknown) => error);
  await until(() => denying.popup.location.href !== "");
  const { message } = await gateway.approve(denying.popup.location.href, { deny: true });
  denying.post(message, origin);
  expect(await denied).toMatchObject({ code: "access_denied" });
  expect(denyExits).toEqual([{ error: "access_denied", step: "denied" }]);
});

test("the gateway serves the callback script, and the stub approves through its control URL", async () => {
  const gateway = await start(["openai_codex"]);
  const metadata = (await (await fetch(`${gateway.baseUrl}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  expect(metadata.callback_script).toBe(`${gateway.baseUrl}/v1/link/callback.js`);
  expect(metadata.connected_apps_uri).toBeNull();
  const script = await fetch(`${gateway.baseUrl}/v1/link/callback.js`);
  expect(script.headers.get("content-type")).toStartWith("text/javascript");
  const text = await script.text();
  expect(text).toContain('new BroadcastChannel("dari-link")');
  expect(text).toContain('type: "dari-link"');

  const request = await authorizeUrl({ gatewayUrl: gateway.baseUrl, clientId: gateway.clientId, redirectUri: REDIRECT_URI });
  const approved = await fetch(`${gateway.controlUrl}/approve`, { method: "POST", body: JSON.stringify({ url: request.url }) });
  const body = (await approved.json()) as { message: Record<string, string>; target_origin: string };
  expect(body.message).toMatchObject({ type: "dari-link", state: request.state });
  expect(body.message.code).toStartWith("dlk_code_");
  expect(body.target_origin).toBe(new URL(REDIRECT_URI).origin);
});

// link_client.ts uses only erasable TypeScript, so Node runs it as is.
test.skipIf(Bun.which("node") === null)("Node imports the link client with type stripping", () => {
  const path = new URL("../link_client.ts", import.meta.url).pathname;
  const run = Bun.spawnSync([
    "node",
    "--input-type=module",
    "-e",
    `const m = await import(${JSON.stringify(path)}); console.log(typeof m.DariLink.open, typeof m.renderButton);`,
  ]);
  expect(run.stderr.toString()).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
  expect(run.stdout.toString().trim()).toBe("function function");
});

test("renderButton draws the Connect with Dari button and wires its click", () => {
  let clicked = 0;
  let listener: (() => void) | undefined;
  const container = {
    innerHTML: "",
    querySelector: (selector: string) =>
      selector === "button[data-dari-link]" ? { addEventListener: (_type: "click", handler: () => void) => void (listener = handler) } : null,
  };
  DariLink.renderButton(container, { onClick: () => void (clicked += 1), theme: "light", label: "Connect <Dari>" });
  expect(container.innerHTML).toContain("<svg");
  expect(container.innerHTML).toContain("Connect &lt;Dari&gt;");
  expect(container.innerHTML).toContain("background:#fff");
  listener!();
  expect(clicked).toBe(1);
});

// A server app makes the PKCE pair itself: the page needs no Web Crypto and
// never sees the verifier.
test("DariLink.open takes a challenge and state from the server, and refuses an insecure page without one", async () => {
  const gateway = await start(["openai_codex"]);
  const client = { gatewayUrl: gateway.baseUrl, clientId: gateway.clientId, redirectUri: REDIRECT_URI };
  const origin = new URL(gateway.baseUrl).origin;

  const insecure = fakeBrowser();
  const exits: LinkExit[] = [];
  const refused = await DariLink.open({ ...client, window: { ...insecure.browser, isSecureContext: false }, onExit: (exit) => exits.push(exit) })
    .catch((error: unknown) => error);
  expect(refused).toMatchObject({ code: "insecure_context" });
  expect(exits).toEqual([{ error: "insecure_context", step: null }]);
  expect(insecure.popup.location.href).toBe("");

  const pkce = await createAuthorization();
  const { browser, popup, post } = fakeBrowser();
  const opened = DariLink.open(
    async () => ({ ...client, codeChallenge: pkce.codeChallenge, state: pkce.state }),
    { ...browser, isSecureContext: false },
  );
  await until(() => popup.location.href !== "");
  const params = new URL(popup.location.href).searchParams;
  expect(params.get("code_challenge")).toBe(pkce.codeChallenge);
  expect(params.get("state")).toBe(pkce.state);
  const { message } = await gateway.approve(popup.location.href);
  post(message, origin);
  const result = await opened;
  expect(result).toEqual({ code: message.code!, state: pkce.state, codeVerifier: null });
  const tokens = await exchange({ ...client, code: result.code, codeVerifier: pkce.codeVerifier });
  expect(tokens.accessToken).toStartWith("dlk_at_");
});
