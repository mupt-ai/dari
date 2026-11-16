/**
 * A small Dari Link client for apps: register, send the user to approve,
 * exchange the code, and call the gateway with tokens that refresh
 * themselves. It uses only `fetch` and Web Crypto, so it runs in browsers,
 * Node, Bun, and Deno.
 *
 * In a browser, one button does the approval: `DariLink.open` opens Dari in a
 * popup, the user signs in, picks plans, and approves, and the popup closes.
 *
 * ```ts
 * import { DariLink } from "@mupt-ai/dari-gateway/link/client";
 *
 * button.onclick = async () => {
 *   const { code, codeVerifier } = await DariLink.open({ gatewayUrl, clientId, redirectUri });
 *   await fetch("/api/dari/exchange", { method: "POST", body: JSON.stringify({ code, codeVerifier }) });
 * };
 * ```
 *
 * Without a popup, send the user to the approval URL yourself:
 *
 * ```ts
 * import { authorizeUrl, exchange, linkFetch } from "@mupt-ai/dari-gateway/link/client";
 *
 * const { url, codeVerifier, state } = await authorizeUrl({ gatewayUrl, clientId, redirectUri });
 * // Keep codeVerifier and state with the user's session, send them to `url`;
 * // on the redirect back, check `state`, then:
 * await db.save(user, await exchange({ gatewayUrl, clientId, redirectUri, code, codeVerifier }));
 * const gatewayFetch = linkFetch({
 *   gatewayUrl,
 *   clientId,
 *   loadTokens: () => db.load(user),
 *   saveTokens: (next) => db.save(user, next),
 * });
 * await gatewayFetch("/v1/chat/completions", {
 *   method: "POST",
 *   headers: { "content-type": "application/json" },
 *   body: JSON.stringify({ model: "dari/routing", messages }),
 * });
 * ```
 *
 * A server keeps a secret: register it as a confidential client
 * (`registerClient({ confidential: true })`, or Settings → Dari Link Apps on
 * hosted Dari) and pass `clientSecret` to every
 * call. Its refresh token then never rotates, so any number of processes can
 * refresh the same grant. A public client's refresh token rotates on every
 * use; `linkFetch` reads the tokens from your storage on each call, so
 * processes that share that storage share the rotation.
 */

export type LinkPlan = {
  id: string;
  // A plan kind such as "openai_codex", or "api_key" for an API key the user added.
  kind: string;
  // What to call it on screen: "Claude", "ChatGPT", "OpenRouter".
  title: string;
  // For an API key: the model provider or gateway it is a key for, such as "openrouter".
  provider?: string;
  // For a gateway's API key: it serves any model named with this prefix, such
  // as "openrouter/" for `openrouter/anthropic/claude-sonnet-4.5`; `models` lists none.
  model_prefix?: string;
  // Such as "ChatGPT Plus/Pro".
  plan: string;
  label: string;
  account_email: string | null;
  // "any_app", or the one client the plan serves, such as "claude_code_only".
  serves: string;
  unavailable_until: string | null;
  // Quota windows the plan last reported, shortest first; empty when unknown.
  usage: Array<{ window_minutes: number; utilization: number; resets_at: string }>;
  // Why the plan does or does not serve the app now, and when it will again.
  state: "ready" | "plan_limit";
  available_at: string | null;
  // The models the plan serves its clients now: the name a request uses, and the display name.
  models: LinkModel[];
};

export type LinkModel = { id: string; name: string };

export type LinkBudgetWindow = { window_minutes: number; max_tokens: number; used_tokens: number; resets_at: string | null };

export type LinkTokenSet = {
  accessToken: string;
  refreshToken: string;
  // Milliseconds since the epoch.
  expiresAt: number;
  grantId: string | null;
  scope: string;
  // The most tokens this app may use per window (300: five hours, 10080: a
  // week), across all its plans and API keys, and what it used in each
  // window; `resets_at` is set only at the cap. Empty for no limit.
  budget: LinkBudgetWindow[];
  // `budget_limit` while a budget window is at its cap, until `availableAt`.
  state: "ready" | "budget_limit";
  availableAt: string | null;
  plans: LinkPlan[];
  // The models a plain API client can name now.
  models: LinkModel[];
  // The connections page, where the user manages this connection.
  manageUrl: string;
  // Whether `dari/routing` serves a plain API client now.
  routes: boolean;
};

export type LinkChildToken = {
  accessToken: string;
  // Milliseconds since the epoch.
  expiresAt: number;
  // The catalog models it serves, by request name, with each pinned level.
  models: Array<{ model: string; thinking: string | null }>;
};

/**
 * A refused Dari Link call. `code` is the most specific error code: an OAuth
 * error such as `invalid_grant` (the grant is gone: the user must link
 * again), `refresh_race`, or a gateway code such as `grant_revoked`. `detail`
 * holds what came with it, such as `revoked_by` or `request_id`.
 */
// Plain fields, not parameter properties: this file uses only erasable
// TypeScript, so Node's type stripping can run it as is.
export class LinkError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: Record<string, unknown>;

  constructor(code: string, message: string, status: number, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "LinkError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

type Fetch = typeof fetch;
type Gateway = { gatewayUrl: string; fetch?: Fetch };
// A confidential client passes its secret; a public client has none.
type Client = Gateway & { clientId: string; clientSecret?: string };

// Access tokens are refreshed this long before they expire.
const REFRESH_EARLY_MS = 60_000;

/**
 * Register an app openly (RFC 7591). A public client gets a client id; with
 * `confidential`, a server also gets its client secret, returned this once:
 * keep it in your secret manager.
 */
export async function registerClient(
  args: Gateway & { clientName: string; redirectUris: string[]; confidential?: boolean },
): Promise<{ clientId: string; clientSecret?: string }> {
  const response = await (args.fetch ?? fetch)(endpoint(args.gatewayUrl, "/v1/link/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: args.clientName,
      redirect_uris: args.redirectUris,
      ...(args.confidential ? { token_endpoint_auth_method: "client_secret_basic" } : {}),
    }),
  });
  const body = await json(response);
  return {
    clientId: String(body.client_id),
    ...(typeof body.client_secret === "string" ? { clientSecret: body.client_secret } : {}),
  };
}

/**
 * The approval URL to send the user to, with a fresh PKCE verifier and state.
 * `clients` names the clients the app runs, such as `claude_code`, so the
 * user can grant plans that serve only those. `plans` limits the page to
 * those plan kinds, such as `openai_codex`. `purposes` says what the app does
 * with each audience's plans, shown beside them. `grantId` (update mode)
 * opens the page on that existing grant: the user changes its plans in place,
 * its id and tokens stay, and the new code redeems for more tokens of it.
 */
export async function authorizeUrl(args: AuthorizeOptions): Promise<{ url: string; codeVerifier: string; state: string }> {
  const { codeVerifier, codeChallenge, state } = await createAuthorization(args.state);
  return { url: authorizationUrl({ ...args, codeChallenge, state }), codeVerifier, state };
}

export type AuthorizeOptions = {
  gatewayUrl: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  clients?: string[];
  plans?: string[];
  // The providers and gateways whose API keys the app can use, such as
  // ["anthropic", "openrouter"]; omit to offer every one.
  keyProviders?: string[];
  purposes?: { any_app?: string; claude_code?: string; muse_code?: string };
  grantId?: string;
  // `web_message` posts the result to the window that opened the page.
  responseMode?: "query" | "web_message";
};

/**
 * A fresh PKCE pair and state, made on your server: keep `codeVerifier` (and
 * `state`) with the user's session, and hand the browser only `codeChallenge`
 * and `state` for `DariLink.open`. The verifier then never reaches the page,
 * and the page needs no Web Crypto.
 */
export async function createAuthorization(state?: string): Promise<{ codeVerifier: string; codeChallenge: string; state: string }> {
  const codeVerifier = randomToken(32);
  return { codeVerifier, codeChallenge: await pkceChallenge(codeVerifier), state: state ?? randomToken(16) };
}

// The approval URL for a PKCE challenge and state made elsewhere.
function authorizationUrl(args: AuthorizeOptions & { codeChallenge: string; state: string }): string {
  const url = new URL(endpoint(args.gatewayUrl, "/v1/link/authorize"));
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
    scope: "route",
    ...(args.responseMode === "web_message" ? { response_mode: "web_message" } : {}),
    ...(args.clients?.length ? { client: args.clients.join(" ") } : {}),
    ...(args.plans?.length ? { plans: args.plans.join(" ") } : {}),
    ...(args.keyProviders?.length ? { key_providers: args.keyProviders.join(" ") } : {}),
    ...(args.grantId ? { grant_id: args.grantId } : {}),
    ...Object.fromEntries(
      Object.entries(args.purposes ?? {}).flatMap(([audience, purpose]) => purpose ? [[`purpose_${audience}`, purpose]] : []),
    ),
  }).toString();
  return url.toString();
}

// The parts of a browser window `openLink` uses, so it needs no DOM types.
type LinkPopup = { closed: boolean; close(): void; location: { href: string } };
type LinkMessage = { source: unknown; origin: string; data: unknown };
type LinkChannel = { postMessage(data: unknown): void; close(): void; onmessage: ((event: { data: unknown }) => void) | null };
export type LinkBrowser = {
  open(url: string, target: string, features: string): LinkPopup | null;
  addEventListener(type: "message", listener: (event: LinkMessage) => void): void;
  removeEventListener(type: "message", listener: (event: LinkMessage) => void): void;
  // Same-origin windows only: how the redirect page reaches the opener.
  BroadcastChannel?: new (name: string) => LinkChannel;
  location?: { search: string };
  close?(): void;
  isSecureContext?: boolean;
  screenX?: number;
  screenY?: number;
  outerWidth?: number;
  outerHeight?: number;
};

const POPUP_WIDTH = 460;
const POPUP_HEIGHT = 720;
const POPUP_POLL_MS = 400;
// A closed popup may have just handed its result to `completeLink`.
const POPUP_CLOSED_GRACE_MS = 300;
const LINK_CHANNEL = "dari-link";
const STEPS: readonly LinkStep[] = ["connect_subscription", "choose_plans"];

/**
 * The approval step the user reached in the popup: `connect_subscription`
 * (no plan to share yet) or `choose_plans`. A user who denies leaves at
 * `denied`.
 */
export type LinkStep = "connect_subscription" | "choose_plans" | "denied";

/** Why the popup ended without a code, and the step the user left at (null before any). */
export type LinkExit = { error: string; step: LinkStep | null };

export type OpenLinkOptions = AuthorizeOptions & {
  // A PKCE challenge and state your server made with `createAuthorization`
  // (recommended for a server app): the verifier stays on the server, the page
  // needs no Web Crypto, and the result's `codeVerifier` is null.
  codeChallenge?: string;
  fetch?: Fetch;
  window?: LinkBrowser;
  // Each step the user reaches, as they reach it.
  onEvent?: (step: LinkStep) => void;
  // Called before the call rejects: where the user left and why.
  onExit?: (exit: LinkExit) => void;
};

/**
 * Open Dari's approval page in a popup and resolve with the code once the
 * user approves. Call it from a click handler, so the browser allows the
 * popup. Send `code` and `codeVerifier` to your server to `exchange`.
 *
 * The options may be a function returning them (a promise is fine): it is
 * awaited only after the popup opens, so fetching a client id or state from
 * your server first does not get the popup blocked.
 *
 * Rejects with a `LinkError`: `popup_blocked`, `popup_closed` when the user
 * closes it, or the OAuth error the page returned, such as `access_denied`.
 * The result is accepted only from the popup and from the gateway's approval
 * origin, and only with the state this call made.
 *
 * A popup that signed the user in along the way can lose its link to this
 * window; the approval then lands on your redirect URI inside the popup. Call
 * `DariLink.callback()` on that page (or load `/v1/link/callback.js` there)
 * and this call still resolves.
 */
export async function openLink(
  options: OpenLinkOptions | (() => OpenLinkOptions | Promise<OpenLinkOptions>),
  browserOverride?: LinkBrowser,
): Promise<{ code: string; state: string; codeVerifier: string | null }> {
  const browser = browserOverride
    ?? (typeof options === "function" ? undefined : options.window)
    ?? (globalThis as unknown as LinkBrowser);
  // Making PKCE in the page needs Web Crypto, which browsers give only to
  // https (or localhost) pages; a challenge from the server needs none.
  const insecure = (args: OpenLinkOptions) =>
    args.codeChallenge === undefined && (browser.isSecureContext === false || globalThis.crypto?.subtle === undefined);
  const insecureError = () => new LinkError(
    "insecure_context",
    "Connect with Dari needs a secure page (https, or localhost) to make its PKCE pair, or a codeChallenge and state from your server.",
    0,
  );
  if (typeof options !== "function" && insecure(options)) {
    options.onExit?.({ error: "insecure_context", step: null });
    throw insecureError();
  }
  const left = (browser.screenX ?? 0) + Math.max(0, ((browser.outerWidth ?? POPUP_WIDTH) - POPUP_WIDTH) / 2);
  const top = (browser.screenY ?? 0) + Math.max(0, ((browser.outerHeight ?? POPUP_HEIGHT) - POPUP_HEIGHT) / 2);
  // Opened before anything is awaited, while the click still allows it.
  const popup = browser.open(
    "about:blank",
    "dari-link",
    `popup=yes,width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${Math.round(left)},top=${Math.round(top)}`,
  );
  if (popup === null) {
    if (typeof options !== "function") options.onExit?.({ error: "popup_blocked", step: null });
    throw new LinkError("popup_blocked", "Allow pop-ups for this site, then connect again.", 0);
  }
  let args: OpenLinkOptions;
  let request: { url: string; codeVerifier: string | null; state: string };
  let origin: string;
  try {
    args = typeof options === "function" ? await options() : options;
    if (insecure(args)) {
      args.onExit?.({ error: "insecure_context", step: null });
      throw insecureError();
    }
    const supplied = args.codeChallenge;
    if (supplied !== undefined && args.state === undefined) {
      throw new LinkError("invalid_request", "Pass the state your server made with the codeChallenge.", 0);
    }
    [request, origin] = await Promise.all([
      supplied !== undefined
        ? { url: authorizationUrl({ ...args, codeChallenge: supplied, state: args.state!, responseMode: "web_message" }), codeVerifier: null, state: args.state! }
        : authorizeUrl({ ...args, responseMode: "web_message" }),
      approvalOrigin(args),
    ]);
  } catch (error) {
    popup.close();
    throw error;
  }
  return await new Promise((resolve, reject) => {
    const channel = browser.BroadcastChannel ? new browser.BroadcastChannel(LINK_CHANNEL) : null;
    let settled = false;
    let step: LinkStep | null = null;
    const fail = (error: LinkError, exitStep: LinkStep | null) => {
      args.onExit?.({ error: error.code, step: exitStep });
      reject(error);
    };
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      browser.removeEventListener("message", onMessage);
      channel?.close();
      clearInterval(poll);
      settle();
    };
    const onMessage = (event: LinkMessage) => {
      if (event.source === popup && event.origin === origin) accept(event.data);
    };
    const accept = (data: unknown) => {
      const message = data as Record<string, unknown> | null;
      if (typeof message !== "object" || message === null || message.state !== request.state) return;
      // A step the user reached, not a result.
      if (message.type === "dari-link-event") {
        if (STEPS.includes(message.event as LinkStep)) {
          step = message.event as LinkStep;
          args.onEvent?.(step);
        }
        return;
      }
      // Only a result ends the flow; anything else is ignored.
      if (message.type !== "dari-link" || (typeof message.code !== "string" && typeof message.error !== "string")) return;
      finish(() => {
        if (typeof message.code === "string") {
          resolve({ code: message.code, state: request.state, codeVerifier: request.codeVerifier });
        } else {
          const code = typeof message.error === "string" ? message.error : "invalid_request";
          fail(new LinkError(
            code,
            typeof message.error_description === "string" ? message.error_description : `Dari Link was not approved: ${code}.`,
            0,
          ), code === "access_denied" ? "denied" : step);
        }
      });
      if (!popup.closed) popup.close();
    };
    const poll = setInterval(() => {
      if (!popup.closed) return;
      clearInterval(poll);
      setTimeout(
        () => finish(() => fail(new LinkError("popup_closed", "The Dari window was closed before approving.", 0), step)),
        POPUP_CLOSED_GRACE_MS,
      );
    }, POPUP_POLL_MS);
    browser.addEventListener("message", onMessage);
    // Only this origin's windows share the channel.
    if (channel) channel.onmessage = (event) => accept(event.data);
    popup.location.href = request.url;
  });
}

/**
 * On your redirect URI's page: hand an approval that arrived there in the
 * popup to the window that called `DariLink.open`, and close the popup.
 * Returns false when the page holds no Dari Link result.
 */
export function completeLink(args: { window?: LinkBrowser } = {}): boolean {
  const browser = args.window ?? (globalThis as unknown as LinkBrowser);
  const params = new URLSearchParams(browser.location?.search ?? "");
  const state = params.get("state");
  const code = params.get("code");
  const error = params.get("error");
  if (state === null || (code === null && error === null) || !browser.BroadcastChannel) return false;
  const channel = new browser.BroadcastChannel(LINK_CHANNEL);
  channel.postMessage({
    type: "dari-link",
    state,
    ...(code !== null ? { code } : { error, error_description: params.get("error_description") ?? undefined }),
  });
  channel.close();
  browser.close?.();
  return true;
}

/** The Dari mark: a white turtle on a black disc, square, scalable. */
export const DARI_MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="20" height="20" aria-hidden="true">'
  + '<circle cx="512" cy="512" r="462" fill="#000"/><g fill="#fff">'
  + '<path d="M227.174 643.267C309.13 501.04 353.3 382.247 461.711 379.747c100.278 6.927 172.975 162.686 217.376 263.52h110.942c-81.304-117.797-196.325-301.555-326.906-303.36-166.044-4.954-236.495 312.426-235.949 303.36"/>'
  + '<path d="M657.933 552.765h177.78V487.33l-224.079 18.712 44.162 15.727zM327.444 446.849h14.02v89.346h-14.02zM368.884 403.285h13.92v129.377h-13.92zM413.178 382.234h13.886v144.712h-13.886zm48.935-4.033h13.886v144.712h-13.886zM512.336 410.531v118.442h13.887V423.498a300 300 0 0 0-13.887-12.967M593.563 507.768l-329.946 33.841-85.683 11.157h444.87c-9.563-15.205-19.29-30.327-29.241-44.998"/>'
  + "</g></svg>";

// What `renderButton` needs of an element, so this file needs no DOM types.
type ButtonHost = {
  innerHTML: string;
  querySelector(selector: string): { addEventListener(type: "click", listener: () => void): void } | null;
};

/**
 * Render the standard "Connect with Dari" button into `container` and call
 * `onClick` (which should call `DariLink.open`) when it is pressed. `dark`
 * (the default) is for light pages: black button, white text; `light` is for
 * dark pages. The button is 40px tall with the mark at 20px; see the README's
 * button guidelines.
 */
export function renderButton(
  container: ButtonHost,
  options: { onClick: () => void; theme?: "dark" | "light"; label?: string },
): void {
  const dark = (options.theme ?? "dark") === "dark";
  const label = (options.label ?? "Connect with Dari")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  container.innerHTML = `<button type="button" data-dari-link style="display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 16px 0 12px;`
    + `border-radius:8px;border:1px solid ${dark ? "#000" : "#d4d4d8"};background:${dark ? "#000" : "#fff"};color:${dark ? "#fff" : "#000"};`
    + `font:500 14px/1 system-ui,-apple-system,sans-serif;cursor:pointer">${DARI_MARK_SVG.replace('fill="#000"', `fill="${dark ? "#fff" : "#000"}"`).replace('<g fill="#fff">', `<g fill="${dark ? "#000" : "#fff"}">`)}${label}</button>`;
  container.querySelector("button[data-dari-link]")?.addEventListener("click", options.onClick);
}

/**
 * `DariLink.open(...)` is the one call a "Connect with Dari" button makes;
 * `DariLink.callback()` goes on the redirect URI's page; `DariLink.renderButton`
 * draws the button.
 */
export const DariLink = { open: openLink, callback: completeLink, renderButton };

// The origin the approval page posts its result from, as the gateway's
// metadata names it: the gateway's public origin.
async function approvalOrigin(args: Gateway): Promise<string> {
  const response = await (args.fetch ?? fetch)(endpoint(args.gatewayUrl, "/.well-known/oauth-authorization-server"));
  const origin = (await json(response)).web_message_origin;
  return typeof origin === "string" ? origin : new URL(args.gatewayUrl).origin;
}

/** Redeem the code from the approval redirect for the grant's first tokens. */
export async function exchange(
  args: Client & { redirectUri: string; code: string; codeVerifier: string },
): Promise<LinkTokenSet> {
  return tokenSet(await tokenCall(args, {
    grant_type: "authorization_code",
    redirect_uri: args.redirectUri,
    code: args.code,
    code_verifier: args.codeVerifier,
  }));
}

/**
 * A new access token. A public client's refresh token rotates: the one passed
 * in stops working. A confidential client's stays the same.
 */
export async function refresh(args: Client & { refreshToken: string }): Promise<LinkTokenSet> {
  return tokenSet(await tokenCall(args, { grant_type: "refresh_token", refresh_token: args.refreshToken }));
}

/**
 * Mint a child token for a sandbox or worker, from the grant's access token
 * or from your token storage (refreshed as `linkFetch` does): it serves only
 * its models (each at one thinking level when pinned) for up to twelve
 * hours, cannot refresh, mint, or read the grant, and dies with the grant.
 */
export async function childToken(args: Client & ({ accessToken: string } | TokenStorage) & {
  // Such as `[{ model: "dari/model/openai/gpt-5.5", thinking: "high" }]`.
  models: Array<{ model: string; thinking?: string }>;
  // Seconds, 60 to 43200; an hour when omitted.
  expiresIn?: number;
  // Labels for the child token's requests, like the X-Dari-Tags header.
  tags?: Record<string, string>;
  now?: () => number;
}): Promise<LinkChildToken> {
  const pinned = args.models.some((entry) => entry.thinking);
  const mint = async (accessToken: string) => await tokenCall(args, [
    ["grant_type", "urn:ietf:params:oauth:grant-type:token-exchange"],
    ["subject_token", accessToken],
    ["subject_token_type", "urn:ietf:params:oauth:token-type:access_token"],
    ...args.models.map((entry): [string, string] => ["model", entry.model]),
    // One level per model, in order, when any is pinned.
    ...(pinned ? args.models.map((entry): [string, string] => ["thinking", entry.thinking || "default"]) : []),
    ...(args.expiresIn === undefined ? [] : [["expires_in", String(args.expiresIn)] as [string, string]]),
    ...(args.tags && Object.keys(args.tags).length > 0
      ? [["tags", Object.entries(args.tags).map(([key, value]) => `${key}=${value}`).join(",")] as [string, string]]
      : []),
  ]);
  let payload: Record<string, unknown>;
  if ("accessToken" in args) {
    payload = await mint(args.accessToken);
  } else {
    // From storage, refreshing the grant's access token as linkFetch does.
    const source = tokenSource(args);
    const tokens = await source.fresh();
    try {
      payload = await mint(tokens.accessToken);
    } catch (error) {
      if (!(error instanceof LinkError && error.code === "invalid_grant")) throw error;
      payload = await mint((await source.rotate(tokens)).accessToken);
    }
  }
  return {
    accessToken: String(payload.access_token),
    expiresAt: Date.now() + Number(payload.expires_in) * 1000,
    models: payload.models as LinkChildToken["models"],
  };
}

/** End the grant a token belongs to, as when the user disconnects in the app. */
export async function revoke(args: Client & { token: string }): Promise<void> {
  const response = await (args.fetch ?? fetch)(endpoint(args.gatewayUrl, "/v1/link/revoke"), {
    method: "POST",
    headers: clientHeaders(args),
    body: new URLSearchParams({ client_id: args.clientId, token: args.token }),
  });
  if (!response.ok) await json(response);
}

/**
 * A fetch for the gateway on one grant: paths resolve against `gatewayUrl`
 * and the access token is attached. Your storage is the source of truth: the
 * tokens are read with `loadTokens` on every call, refreshed shortly before
 * they expire and once after a 401 for an expired token, and every new token
 * set reaches `saveTokens` before use. Concurrent calls in a process share
 * one refresh. A grant that is gone throws LinkError with code
 * `invalid_grant` from the refresh, and a revoked access token's 401
 * (`grant_revoked`) is returned as it is: either way the user is unlinked and
 * must link again. With no tokens stored it throws `not_linked`.
 */
export function linkFetch(args: Client & TokenStorage & {
  now?: () => number;
}): (input: string, init?: RequestInit) => Promise<Response> {
  const fetchImpl = args.fetch ?? fetch;
  const source = tokenSource(args);

  const call = (tokens: LinkTokenSet, input: string, init: RequestInit | undefined) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${tokens.accessToken}`);
    return fetchImpl(endpoint(args.gatewayUrl, input), { ...init, headers });
  };

  return async (input, init) => {
    const tokens = await source.fresh();
    const response = await call(tokens, input, init);
    if (response.status !== 401 || !replayable(init?.body)) return response;
    // A revoked grant cannot be refreshed back to life.
    if ((await errorCode(response.clone())) === "grant_revoked") return response;
    return await call(await source.rotate(tokens), input, init);
  };
}

export type LinkUsageTotals = {
  requests: number;
  // Requests the provider or Dari failed; they count in `requests` too.
  errors: number;
  // Excludes cache reads and writes, whatever protocol the requests spoke.
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

export type LinkUsage = LinkUsageTotals & {
  // Every request received before this time is counted; null when the
  // gateway cannot tell (hosted Dari, for now).
  complete_through: string | null;
  // Per model and thinking level served, most requests first.
  by_model: Array<LinkUsageTotals & { model: string; thinking: string | null }>;
  // With `groupByTag`: per value of that tag (null: requests without it).
  by_tag?: Array<LinkUsageTotals & { value: string | null }>;
};

/**
 * What the grant's requests used, child tokens' included: only requests
 * carrying every given tag (X-Dari-Tags or a child token's tags), received
 * in [since, until), and with `groupByTag` also totalled per value of that
 * tag. Pass the `linkFetch` your app already uses as `fetcher` so this shares
 * its refresh; otherwise pass the client and token storage.
 */
export async function usage(args: (
  | { fetcher: (input: string, init?: RequestInit) => Promise<Response> }
  | (Client & TokenStorage & { now?: () => number })
) & {
  tags?: Record<string, string>;
  since?: Date;
  until?: Date;
  groupByTag?: string;
}): Promise<LinkUsage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(args.tags ?? {})) params.append("tag", `${key}=${value}`);
  if (args.since) params.set("since", args.since.toISOString());
  if (args.until) params.set("until", args.until.toISOString());
  if (args.groupByTag) params.set("group_by", `tag:${args.groupByTag}`);
  const query = params.toString();
  const fetcher = "fetcher" in args ? args.fetcher : linkFetch(args);
  const response = await fetcher(`/v1/link/usage${query ? `?${query}` : ""}`);
  return await json(response) as LinkUsage;
}

/**
 * Where an app keeps one grant's tokens. `loadTokens` returns null when the
 * user has not linked (or unlinked): calls then throw LinkError `not_linked`
 * without reaching the gateway.
 */
export type TokenStorage = {
  loadTokens: () => LinkTokenSet | null | Promise<LinkTokenSet | null>;
  saveTokens: (tokens: LinkTokenSet) => void | Promise<void>;
};

// One grant's tokens from storage: fresh ones, refreshed shortly before they
// expire, and a rotation that concurrent callers share.
function tokenSource(args: Client & TokenStorage & { now?: () => number }) {
  const now = args.now ?? Date.now;
  const load = async (): Promise<LinkTokenSet> => {
    const stored = await args.loadTokens();
    if (stored === null) throw new LinkError("not_linked", "This user has not linked a Dari Link grant.", 0);
    return stored;
  };
  let refreshing: Promise<LinkTokenSet> | null = null;
  const rotate = (stale: LinkTokenSet): Promise<LinkTokenSet> => {
    refreshing ??= (async () => {
      try {
        // Another call or process may have refreshed since `stale` was read.
        const stored = await load();
        if (stored.accessToken !== stale.accessToken) return stored;
        try {
          const next = await refresh({ ...args, refreshToken: stored.refreshToken });
          await args.saveTokens(next);
          return next;
        } catch (error) {
          // Another process rotated this refresh token a moment ago and is
          // saving what it received.
          if (error instanceof LinkError && error.code === "refresh_race") return await load();
          throw error;
        }
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };
  return {
    rotate,
    async fresh(): Promise<LinkTokenSet> {
      const tokens = await load();
      return tokens.expiresAt - now() < REFRESH_EARLY_MS ? await rotate(tokens) : tokens;
    },
  };
}

// A form field may repeat when given as pairs.
async function tokenCall(
  args: Client,
  body: Record<string, string> | Array<[string, string]>,
): Promise<Record<string, unknown>> {
  const fields = Array.isArray(body) ? body : Object.entries(body);
  const response = await (args.fetch ?? fetch)(endpoint(args.gatewayUrl, "/v1/link/token"), {
    method: "POST",
    headers: clientHeaders(args),
    body: new URLSearchParams([["client_id", args.clientId], ...fields]),
  });
  return await json(response);
}

// A confidential client proves its secret with HTTP Basic.
function clientHeaders(args: Client): Record<string, string> {
  return {
    "content-type": "application/x-www-form-urlencoded",
    ...(args.clientSecret
      ? { authorization: `Basic ${btoa(`${encodeURIComponent(args.clientId)}:${encodeURIComponent(args.clientSecret)}`)}` }
      : {}),
  };
}

function tokenSet(payload: Record<string, unknown>): LinkTokenSet {
  return {
    accessToken: String(payload.access_token),
    refreshToken: String(payload.refresh_token),
    expiresAt: Date.now() + Number(payload.expires_in) * 1000,
    grantId: typeof payload.grant_id === "string" ? payload.grant_id : null,
    scope: typeof payload.scope === "string" ? payload.scope : "route",
    budget: Array.isArray(payload.budget) ? payload.budget as LinkBudgetWindow[] : [],
    state: payload.state === "budget_limit" ? "budget_limit" : "ready",
    availableAt: typeof payload.available_at === "string" ? payload.available_at : null,
    plans: Array.isArray(payload.plans) ? payload.plans as LinkPlan[] : [],
    models: Array.isArray(payload.models) ? payload.models as LinkModel[] : [],
    routes: payload.routes === true,
    manageUrl: String(payload.manage_url),
  };
}

// The JSON body of a successful response; otherwise a LinkError from either
// error shape (OAuth `error`, or the gateway's `error.code`).
async function json(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  if (response.ok) return record;
  const error = record.error;
  if (typeof error === "string") {
    const { error: _error, error_description: description, error_code: specific, ...detail } = record;
    throw new LinkError(typeof specific === "string" ? specific : error, String(description ?? error), response.status, detail);
  }
  if (typeof error === "object" && error !== null) {
    const { code, message, ...detail } = error as Record<string, unknown>;
    throw new LinkError(String(code ?? "error"), String(message ?? "Dari Link request failed."), response.status, detail);
  }
  throw new LinkError("error", `Dari Link request failed with status ${response.status}.`, response.status);
}

// The error code of a refused gateway response, or null.
async function errorCode(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => null);
  const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : null;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : null;
  return typeof code === "string" ? code : null;
}

// A path on the gateway, or a full URL on its origin: the token is never sent anywhere else.
function endpoint(gatewayUrl: string, path: string): string {
  if (!/^https?:\/\//.test(path)) return `${gatewayUrl.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
  if (new URL(path).origin !== new URL(gatewayUrl).origin) {
    throw new LinkError("invalid_request", `Dari Link sends its token only to ${new URL(gatewayUrl).origin}.`, 0);
  }
  return path;
}

// A body that can be sent twice: a stream is spent by the first attempt.
function replayable(body: RequestInit["body"]): boolean {
  return body === undefined || body === null || typeof body === "string"
    || body instanceof URLSearchParams || body instanceof ArrayBuffer || ArrayBuffer.isView(body)
    || (typeof Blob !== "undefined" && body instanceof Blob)
    || (typeof FormData !== "undefined" && body instanceof FormData);
}

function randomToken(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
