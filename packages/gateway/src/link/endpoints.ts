/* Dari Link: OAuth 2.0 authorization code grants with PKCE (S256) that let an
   app send one user's requests on the subscriptions the user chose. The
   gateway serves the protocol, the approval page, and the connections page
   on every platform; the platform (GatewayPlatform.link, made by
   link/service.ts) stores apps, grants, and tokens, and says who its users
   are.

   - GET  /.well-known/oauth-authorization-server   metadata (RFC 8414)
   - POST /v1/link/register      open client registration (RFC 7591)
   - GET  /v1/link/authorize     the approval page
   - POST /v1/link/authorize     each step of the page: connect a plan, then
                                 approve or deny; returns `code`
                                 or `error` to the app: on its redirect URI,
                                 or with `response_mode=web_message` posted
                                 to the window that opened the page
   - POST /v1/link/token         `authorization_code`, `refresh_token`, and
                                 token exchange for a child token (RFC 8693)
   - POST /v1/link/revoke        the app revokes its grant (RFC 7009)
   - GET  /v1/link/grant         the grant a link access token belongs to
   - GET  /v1/link/usage         what the grant's requests used, by tag and time
   - POST /v1/link/apps          register an app (bearer: the user's key)
   - GET  /v1/link/grants        the user's grants, each granted plan and
                                 key's spend this month with it
   - DELETE /v1/link/grants/{id} the user revokes a grant and its tokens
   - PUT  /v1/link/grants/{id}/budget  the user sets or removes the grant's
                                 budget: the most tokens the app may use per
                                 five hours and per week
   - PUT  /v1/link/grants/{id}/limits  the user sets the most the grant may
                                 spend on each of its plans and keys a month
   - GET  /v1/link/plans         the plans and keys the user can grant
   - POST /v1/link/endpoints     the user makes a personal endpoint: a grant
                                 for themselves, and its key, which an app
                                 that takes their own key calls with
   - PUT  /v1/link/grants/{id}   rename an endpoint or change its plans
   - POST /v1/link/grants/{id}/keys  another key for an endpoint

   The user's own routes take their personal key, or on hosted Dari their
   signed-in session, as the bearer.
   - GET  /v1/link/session       where a platform's sign-in returns the user
   - GET  /v1/link/connections   the page where the approval page's user sees
                                 the apps they connected, sets each one's
                                 budget, disconnects it, and removes plans
   - POST /v1/link/connections   each of those changes

   A confidential client authenticates at the token and revocation endpoints
   with HTTP Basic (`client_id:client_secret`); a public one sends `client_id`
   in the body.

   The user picks a plan, signs in to its provider, and allows the app. The
   gateway keeps who they are in a signed, HttpOnly, SameSite=Lax cookie
   scoped to /v1/link/, so the next app that asks finds their plans connected
   and the connections page knows them. On a platform with accounts (hosted:
   Dari's own sign-in) they sign in first and are that account, with the plans
   it already has; elsewhere their first plan makes them a user. Every change
   needs that cookie and a form token derived from it, so another site cannot
   make one. */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { isReasoningEffort, providerForModel } from "@mupt-ai/dari-router/policy-engine";

import { bearerToken } from "../http/auth.js";
import { errorResponse, HttpError } from "../http/errors.js";
import { SUBSCRIPTION_PLAN_LABELS } from "./errors.js";
import { modelSubscriptions, subscriptionClient } from "../models/subscriptions.js";
import type {
  GatewayPlatform,
  LinkApp,
  LinkApprovalPage,
  LinkLimit,
  LinkClient,
  LinkConnect,
  LinkConnection,
  LinkPlanAdded,
  LinkGrantDetail,
  LinkKeyProvider,
  LinkManagedGrant,
  LinkUsageTotals,
  LinkUsageWindow,
  LinkPlatform,
  LinkSignIn,
  LinkBudget,
  LinkBudgetStanding,
  LinkSubscription,
  LinkTokens,
} from "../platform/platform.js";
import { DEFAULT_ROUTER_ALIAS } from "../platform/routing_contract.js";
import { explicitModelId, explicitModelSlug } from "../protocol/input/router_model.js";
import { CANONICAL_MODELS, canonicalModelName } from "../models/canonical.js";
import { gatewayFor } from "../models/gateways.js";
import { budgetBody, limitsBody, spendBody, validBudget, validLimits } from "./budget.js";
import { catalogModelFor } from "./grant_access.js";
import { registeredRedirect } from "./grants.js";
import { requestTags } from "../runtime/request_tags.js";
import type { ClientHarness, ResolvedRouter, SubscriptionKind } from "../types.js";
import { parseJsonRequest } from "../ingress/json.js";
import { DARI_MARK, ICONS, linkLogo } from "./assets.js";
import { GEIST_WOFF2 } from "./font.js";

const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
// The base64url SHA-256 of a verifier.
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const MAX_APP_NAME_CHARS = 100;
const MAX_REDIRECT_URIS = 10;
const MAX_REGISTRATION_BYTES = 8_192;
// Open registration is unauthenticated, so each gateway process takes at most
// this many per minute.
const MAX_REGISTRATIONS_PER_MINUTE = 20;
const GRANT_ROUTE = /^\/v1\/link\/grants\/([^/]+)$/;
const GRANT_BUDGET_ROUTE = /^\/v1\/link\/grants\/([^/]+)\/budget$/;
const GRANT_LIMITS_ROUTE = /^\/v1\/link\/grants\/([^/]+)\/limits$/;
const GRANT_KEYS_ROUTE = /^\/v1\/link\/grants\/([^/]+)\/keys$/;
const MAX_ENDPOINT_CREDENTIALS = 50;
const MAX_TAG_KEY_CHARS = 64;
// Who the approval page's user is. Without accounts the cookie is who they
// are, so it lasts a year from their last plan; with accounts, a month from
// their sign-in, which is a click away again.
const USER_COOKIE = "dari_link_user";
const USER_SECONDS = 365 * 24 * 60 * 60;
const ACCOUNT_SECONDS = 30 * 24 * 60 * 60;
// A provider sign-in under way, for as long as providers keep one open.
const CONNECT_COOKIE = "dari_link_connect";
const CONNECT_SECONDS = 15 * 60;
// A sign-in at the platform under way: the state its ticket must carry.
const SIGN_IN_COOKIE = "dari_link_sign_in";
const SIGN_IN_SECONDS = 15 * 60;
// How long after the platform signed the user in its ticket is good.
const TICKET_MS = 2 * 60 * 1000;
const SESSION_PATH = "/v1/link/session";
// How often the page asks a provider whether the user approved its code.
const DEVICE_POLL_SECONDS = 5;
const AUTHORIZE_PATH = "/v1/link/authorize";
const CONNECTIONS_PATH = "/v1/link/connections";
// Where the pages' cookies are sent.
const COOKIE_PATH = "/v1/link/";
const CALLBACK_SCRIPT_PATH = "/v1/link/callback.js";
// The approval page's typeface.
const FONT_PATH = "/v1/link/geist.woff2";
const GRANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const USAGE_REQUEST_ROUTE = /^\/v1\/link\/usage\/requests\/([^/]{1,200})$/;
// `response_mode=web_message`: the result is posted to the window that opened
// the approval page, for an app that opens it as a popup.
const WEB_MESSAGE = "web_message";
/** The `type` of the message a `web_message` approval posts to its opener. */
export const LINK_MESSAGE_TYPE = "dari-link";
// A step the user reached in the popup; never a result.
export const LINK_EVENT_TYPE = "dari-link-event";
// The one scope: route model requests on the granted plans.
export const LINK_SCOPE = "route";
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const CHILD_TOKEN_DEFAULT_SECONDS = 60 * 60;
const CHILD_TOKEN_MAX_SECONDS = 12 * 60 * 60;
const MAX_MODEL_CHARS = 200;
const MAX_PURPOSE_CHARS = 200;
const MAX_CHILD_MODELS = 16;
// Clients an app can say it runs with `client` on the authorize request.
// Claude Code and Muse Code plans serve only an app that runs those.
const CLIENTS: readonly ClientHarness[] = ["claude_code", "codex", "muse_code", "opencode", "pi", "openclaw", "hermes"];
const PLAN_KINDS = Object.keys(SUBSCRIPTION_PLAN_LABELS) as SubscriptionKind[];
// An API key, as a kind an app asks for in `plans` and reads on a grant.
const API_KEY = "api_key";
type OfferKind = SubscriptionKind | typeof API_KEY;
const OFFER_KINDS: readonly OfferKind[] = [...PLAN_KINDS, API_KEY];
// Who a plan serves, as `serves` on a grant and as `purpose_<audience>` on
// the authorize request.
type PlanAudience = "any_app" | "claude_code" | "muse_code";
const PLAN_AUDIENCES: readonly PlanAudience[] = ["any_app", "claude_code", "muse_code"];

export const LINK_ROUTE_PREFIX = "/v1/link/";
const LINK_TOKEN_CREATE_PATH = "/v1/link/link_token/create";
const LINK_TOKEN_PREFIX = "link-";
// A link token is good this long, as long as Plaid's.
const LINK_TOKEN_SECONDS = 4 * 60 * 60;
export const LINK_METADATA_PATH = "/.well-known/oauth-authorization-server";

/** The PKCE S256 challenge for a code verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function handleLinkRequest(request: Request, platform: GatewayPlatform): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const link = platform.link;
  if (link === undefined) return errorResponse(new HttpError(404, "Not found", "not_found"));
  try {
    if (pathname === LINK_METADATA_PATH && request.method === "GET") {
      return withCors(Response.json(metadata(publicOrigin(request), link)));
    }
    if (pathname === CALLBACK_SCRIPT_PATH && request.method === "GET") {
      return new Response(CALLBACK_SCRIPT, {
        headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" },
      });
    }
    if (pathname === FONT_PATH && request.method === "GET") {
      return new Response(GEIST_WOFF2, {
        headers: { "Content-Type": "font/woff2", "Cache-Control": "public, max-age=31536000, immutable" },
      });
    }
    if (pathname === AUTHORIZE_PATH && request.method === "GET") {
      return await authorizePage(link, request, url.searchParams);
    }
    if (pathname === AUTHORIZE_PATH && request.method === "POST") {
      return await authorizeSubmit(link, request, new URLSearchParams(await request.text()));
    }
    if (pathname === SESSION_PATH && request.method === "GET") {
      return await signedIn(link.approval, request, url.searchParams);
    }
    if (pathname === CONNECTIONS_PATH && request.method === "GET") {
      return await connectionsPage(link.approval, request);
    }
    if (pathname === CONNECTIONS_PATH && request.method === "POST") {
      return await connectionsSubmit(link.approval, request, new URLSearchParams(await request.text()));
    }
    if (request.method === "OPTIONS" && (CORS_PATHS.has(pathname) || USAGE_REQUEST_ROUTE.test(pathname))) {
      return withCors(new Response(null, { status: 204 }));
    }
    if (pathname === "/v1/link/token" && request.method === "POST") {
      return withCors(await oauthEndpoint(() => token(platform, link, request)));
    }
    if (pathname === LINK_TOKEN_CREATE_PATH && request.method === "POST") {
      return await oauthEndpoint(() => createLinkToken(link, request));
    }
    if (pathname === "/v1/link/register" && request.method === "POST") {
      return withCors(await registerClient(link, request));
    }
    if (pathname === "/v1/link/revoke" && request.method === "POST") {
      return withCors(await oauthEndpoint(() => revoke(link, request)));
    }
    if (pathname === "/v1/link/grant" && request.method === "GET") {
      return withCors(await grant(platform, link, request));
    }
    if (pathname === "/v1/link/usage" && request.method === "GET") {
      return withCors(await usage(link, request, url.searchParams));
    }
    const requestUsage = USAGE_REQUEST_ROUTE.exec(pathname);
    if (requestUsage !== null && request.method === "GET") {
      return withCors(await usage(link, request, new URLSearchParams(), decodeURIComponent(requestUsage[1]!)));
    }
    if (pathname === "/v1/link/apps" && request.method === "POST") {
      return await registerApp(link, request);
    }
    if (isManagementPath(pathname)) {
      if (request.method === "OPTIONS") return withManagementCors(new Response(null, { status: 204 }));
      const response = await manage(link, request, pathname);
      if (response !== null) return withManagementCors(response);
    }
    return errorResponse(new HttpError(404, "Not found", "not_found"));
  } catch (error) {
    const response = linkErrorResponse(error);
    if (isManagementPath(pathname)) return withManagementCors(response);
    return CORS_PATHS.has(pathname) || USAGE_REQUEST_ROUTE.test(pathname) ? withCors(response) : response;
  }
}

function isManagementPath(pathname: string): boolean {
  return pathname === "/v1/link/grants" || pathname === "/v1/link/plans" || pathname === "/v1/link/endpoints"
    || pathname.startsWith("/v1/link/grants/");
}

// The user's own routes are called from Dari's web app too, with a bearer
// token and no cookie, so any origin may call.
function withManagementCors(response: Response): Response {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.headers.set("Access-Control-Max-Age", "600");
  return response;
}

function managedGrantBody(grant: LinkManagedGrant) {
  return {
    id: grant.id,
    client_id: grant.clientId,
    app_name: grant.appName,
    endpoint: grant.endpoint,
    credential_ids: grant.credentialIds,
    created_at: grant.createdAt,
    budget: budgetBody(grant.budget),
    limits: limitsBody(grant.limits),
    spend: spendBody(grant.spend),
  };
}

// A plan or key the user can grant, as the grant body names its plans.
function planBody(plan: LinkSubscription) {
  const keyFor = plan.apiKeyProvider;
  const kind = plan.provider as SubscriptionKind;
  const client = keyFor === undefined ? subscriptionClient(kind) : undefined;
  return {
    id: plan.id,
    kind: keyFor === undefined ? kind : API_KEY,
    title: keyFor === undefined ? KINDS[kind]?.name ?? kind : plan.name,
    ...(keyFor === undefined ? {} : { provider: keyFor }),
    plan: keyFor === undefined ? SUBSCRIPTION_PLAN_LABELS[kind] ?? kind : `${plan.name} API Key`,
    label: planLabel(plan),
    account_email: plan.accountEmail,
    serves: client === undefined ? "any_app" : `${client}_only`,
  };
}

// The credential ids a request names: distinct, and not too many.
function credentialIdsFrom(value: unknown): string[] {
  if (
    !Array.isArray(value) || value.length === 0 || value.length > MAX_ENDPOINT_CREDENTIALS
    || !value.every((id) => typeof id === "string" && id.length > 0)
  ) {
    throw new HttpError(400, "credential_ids must list one or more of your plans and keys.", "invalid_request_error", "credential_ids");
  }
  return [...new Set(value as string[])];
}

function limitsFrom(value: unknown) {
  const limits = validLimits(value ?? []);
  if (limits === null) {
    throw new HttpError(
      400,
      "limits must be a list of {credential_id, max_percent} for plans and {credential_id, monthly_usd} for API keys, with distinct credential_ids, max_percent above 0 and at most 100, and monthly_usd a dollar amount of 0 or more; [] removes them.",
      "invalid_request_error",
      "limits",
    );
  }
  return limits;
}

/** The user's own routes; null for a path and method none of them serve. */
async function manage(link: LinkPlatform, request: Request, pathname: string): Promise<Response | null> {
    const apiKey = bearerToken(request.headers);
    if (pathname === "/v1/link/grants" && request.method === "GET") {
      return Response.json({ grants: (await link.grants(apiKey)).map(managedGrantBody) });
    }
    if (pathname === "/v1/link/plans" && request.method === "GET") {
      return Response.json({ plans: (await link.plans(apiKey)).map(planBody) });
    }
    if (pathname === "/v1/link/endpoints" && request.method === "POST") {
      const body = (await parseJsonRequest(request)) as Record<string, unknown> | null;
      const { grant, key } = await link.createEndpoint({
        apiKey,
        name: typeof body?.name === "string" ? body.name : "",
        credentialIds: credentialIdsFrom(body?.credential_ids),
        limits: limitsFrom(body?.limits),
      });
      return Response.json({ grant: managedGrantBody(grant), key }, { status: 201 });
    }
    const keysRoute = GRANT_KEYS_ROUTE.exec(pathname);
    if (keysRoute !== null && request.method === "POST") {
      const grantId = decodeURIComponent(keysRoute[1]!);
      const key = await link.issueEndpointKey({ apiKey, grantId });
      if (key === null) throw new HttpError(404, `No endpoint ${grantId}.`, "not_found");
      return Response.json({ id: grantId, key }, { status: 201 });
    }
    const limitsRoute = GRANT_LIMITS_ROUTE.exec(pathname);
    if (limitsRoute !== null && request.method === "PUT") {
      const grantId = decodeURIComponent(limitsRoute[1]!);
      const limits = limitsFrom(((await parseJsonRequest(request)) as { limits?: unknown } | null)?.limits);
      if (!(await link.setLimits({ apiKey, grantId, limits }))) {
        throw new HttpError(404, `No grant ${grantId}.`, "not_found");
      }
      return Response.json({ id: grantId, limits: limitsBody(limits) });
    }
    const budgetRoute = GRANT_BUDGET_ROUTE.exec(pathname);
    if (budgetRoute !== null && request.method === "PUT") {
      const grantId = decodeURIComponent(budgetRoute[1]!);
      const body = await parseJsonRequest(request);
      const budget = validBudget((body as { budget?: unknown } | null)?.budget);
      if (budget === null) {
        throw new HttpError(
          400,
          "budget must be a list of {window_minutes, max_tokens} with distinct window_minutes of 300 or 10080 and max_tokens a positive whole number; [] removes it.",
          "invalid_request_error",
          "budget",
        );
      }
      if (!(await link.setBudget({ apiKey, grantId, budget }))) {
        throw new HttpError(404, `No grant ${grantId}.`, "not_found");
      }
      return Response.json({ id: grantId, budget: budgetBody(budget) });
    }
    const grantRoute = GRANT_ROUTE.exec(pathname);
    if (grantRoute !== null && request.method === "PUT") {
      const grantId = decodeURIComponent(grantRoute[1]!);
      const body = (await parseJsonRequest(request)) as Record<string, unknown> | null;
      const updated = await link.updateEndpoint({
        apiKey,
        grantId,
        ...(typeof body?.name === "string" ? { name: body.name } : {}),
        ...(body?.credential_ids === undefined ? {} : { credentialIds: credentialIdsFrom(body.credential_ids) }),
      });
      if (!updated) throw new HttpError(404, `No endpoint ${grantId}.`, "not_found");
      const grant = (await link.grants(apiKey)).find((candidate) => candidate.id === grantId);
      if (grant === undefined) throw new HttpError(404, `No endpoint ${grantId}.`, "not_found");
      return Response.json(managedGrantBody(grant));
    }
    if (grantRoute !== null && request.method === "DELETE") {
      const grantId = decodeURIComponent(grantRoute[1]!);
      if (!(await link.revokeGrant({ apiKey, grantId }))) {
        throw new HttpError(404, `No grant ${grantId}.`, "not_found");
      }
      return Response.json({ id: grantId, revoked: true });
    }
    return null;
}

// A refusal keeps its own message; a failure says nothing of its cause but a
// request id, which the log line carries with the detail.
function linkErrorResponse(error: unknown): Response {
  if (error instanceof HttpError && error.status < 500) return errorResponse(error);
  const requestId = randomUUID();
  console.error(`dari link request ${requestId} failed`, error);
  return errorResponse(new HttpError(
    error instanceof HttpError ? error.status : 500,
    `Dari Link request failed. Request id ${requestId}.`,
    error instanceof HttpError ? error.code : "link_request_failed",
    undefined,
    undefined,
    { request_id: requestId },
  ));
}

function metadata(origin: string, link: LinkPlatform) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    response_modes_supported: ["query", WEB_MESSAGE],
    // The origin a `web_message` result is posted from: the page that approves.
    web_message_origin: origin,
    token_endpoint: `${origin}/v1/link/token`,
    registration_endpoint: `${origin}/v1/link/register`,
    revocation_endpoint: `${origin}/v1/link/revoke`,
    // A script for the redirect URI's page that hands an approval back to the
    // window that opened the popup (see the README's callback contract).
    callback_script: `${origin}${CALLBACK_SCRIPT_PATH}`,
    // Where users manage the apps they connected.
    connected_apps_uri: `${origin}${CONNECTIONS_PATH}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", TOKEN_EXCHANGE_GRANT],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    scopes_supported: [LINK_SCOPE],
  };
}

// The origin apps reach the gateway at; a TLS-terminating proxy says https.
function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwarded = (name: string) => request.headers.get(name)?.split(",")[0]?.trim();
  return `${forwarded("x-forwarded-proto") === "https" ? "https:" : url.protocol}//${forwarded("x-forwarded-host") || url.host}`;
}

// A browser request sent by another site: Sec-Fetch-Site says so, and where a
// browser sends none, an Origin other than the gateway's.
function crossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site !== "same-origin" && site !== "none";
  const origin = request.headers.get("origin");
  return origin !== null && origin !== publicOrigin(request);
}

// A malformed authorize request, shown on the page: it is the app's bug, and
// sending it to the redirect URI would make the gateway an open redirector for
// anyone who registers one.
function badRequest(description: string): Response {
  return page("Invalid Request", `<div class="body"><h1>Invalid Request</h1><p>${escapeHtml(description)}</p></div>`, { status: 400 });
}

function isHttps(request: Request): boolean {
  return publicOrigin(request).startsWith("https:");
}

async function registerApp(link: LinkPlatform, request: Request): Promise<Response> {
  const apiKey = bearerToken(request.headers);
  const app = await link.registerApp({ apiKey, ...linkAppMetadata(link, await parseJsonRequest(request)) });
  return Response.json(
    // The secret is shown this once; only its hash is stored.
    { ...appBody(app), ...(app.clientSecret === undefined ? {} : { client_secret: app.clientSecret }) },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}

let registrationWindow = { startedAt: 0, count: 0 };

// RFC 7591: an app registers itself: a public client (PKCE, no secret), or with
// `client_secret_basic` a confidential one, whose secret is returned this once.
// Either way the user still approves every grant. Hosted Dari needs the
// organization's key as a Bearer token, so the app belongs to that organization.
async function registerClient(link: LinkPlatform, request: Request): Promise<Response> {
  const now = Date.now();
  if (now - registrationWindow.startedAt >= 60_000) registrationWindow = { startedAt: now, count: 0 };
  if (registrationWindow.count >= MAX_REGISTRATIONS_PER_MINUTE) {
    return Response.json(
      { error: "temporarily_unavailable", error_description: "Too many registrations. Retry in a minute." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }
  const text = await request.text();
  if (text.length > MAX_REGISTRATION_BYTES) {
    return registrationError("invalid_client_metadata", `The registration must be at most ${MAX_REGISTRATION_BYTES} bytes.`);
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return registrationError("invalid_client_metadata", "The registration must be a JSON object.");
  }
  const authMethod = body.token_endpoint_auth_method ?? "none";
  if (authMethod !== "none" && authMethod !== "client_secret_basic") {
    return registrationError(
      "invalid_client_metadata",
      "token_endpoint_auth_method must be none (a public client) or client_secret_basic (a confidential client).",
    );
  }
  let client;
  try {
    client = validClient(link, body.client_name, body.redirect_uris, (message, param) => {
      throw new HttpError(400, message, param === "redirect_uris" ? "invalid_redirect_uri" : "invalid_client_metadata");
    });
  } catch (error) {
    if (error instanceof HttpError) return registrationError(error.code, error.message);
    throw error;
  }
  let app;
  try {
    app = await link.registerApp({
      ...client,
      // No header is no key; a malformed one is refused.
      apiKey: request.headers.has("authorization") ? bearerToken(request.headers) : undefined,
      confidential: authMethod === "client_secret_basic",
    });
  } catch (error) {
    // A refused request is the caller's to fix; a server failure goes to the
    // same masked response as every other Link request.
    if (error instanceof HttpError && error.status < 500) {
      return Response.json(
        { error: error.code, error_description: error.message },
        { status: error.status, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw error;
  }
  // Only apps actually created count against the cap, so refused keys cannot
  // exhaust it for everyone else.
  registrationWindow.count += 1;
  return Response.json(
    {
      client_id: app.clientId,
      // The secret is shown this once; only its hash is stored.
      ...(app.clientSecret === undefined ? {} : { client_secret: app.clientSecret, client_secret_expires_at: 0 }),
      client_name: app.name,
      redirect_uris: app.redirectUris,
      client_id_issued_at: Math.floor(now / 1000),
      token_endpoint_auth_method: authMethod,
      grant_types: ["authorization_code", "refresh_token", TOKEN_EXCHANGE_GRANT],
      response_types: ["code"],
      scope: LINK_SCOPE,
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}

function registrationError(error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status: 400, headers: { "Cache-Control": "no-store" } });
}

/**
 * An app's name, redirect URIs, and whether it is confidential, as every
 * registration takes them; HttpError(400) for anything else.
 */
export function linkAppMetadata(
  link: Pick<LinkPlatform, "httpRedirectHosts">,
  body: { name?: unknown; redirect_uris?: unknown; confidential?: unknown },
): { name: string; redirectUris: string[]; confidential: boolean } {
  const { name, redirectUris } = validClient(link, body.name, body.redirect_uris, (message, param) => {
    throw new HttpError(400, message, "invalid_request_error", param);
  });
  if (body.confidential !== undefined && typeof body.confidential !== "boolean") {
    throw new HttpError(400, "confidential must be a boolean.", "invalid_request_error", "confidential");
  }
  return { name, redirectUris, confidential: body.confidential === true };
}

function validClient(
  link: Pick<LinkPlatform, "httpRedirectHosts">,
  rawName: unknown,
  rawRedirectUris: unknown,
  refuse: (message: string, param: string) => never,
): { name: string; redirectUris: string[] } {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name || name.length > MAX_APP_NAME_CHARS) refuse(`The name must be 1 to ${MAX_APP_NAME_CHARS} characters.`, "name");
  if (
    !Array.isArray(rawRedirectUris)
    || rawRedirectUris.length === 0
    || rawRedirectUris.length > MAX_REDIRECT_URIS
    || !rawRedirectUris.every((uri) => typeof uri === "string" && validRedirectUri(uri, link.httpRedirectHosts ?? []))
  ) {
    refuse(
      `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs, each https or http on localhost${(link.httpRedirectHosts ?? []).length > 0 ? " or an allowed dev host" : ""}, without a fragment.`,
      "redirect_uris",
    );
  }
  return { name, redirectUris: [...new Set(rawRedirectUris as string[])] };
}

function appBody(app: LinkApp) {
  return {
    client_id: app.clientId,
    name: app.name,
    redirect_uris: app.redirectUris,
    token_endpoint_auth_method: app.confidential ? "client_secret_basic" : "none",
  };
}

// Public clients redirect to their own HTTPS origin or to a loopback port;
// a self-hosted gateway may also allow http on hosts it lists (`*.suffix`
// matches any subdomain).
function validRedirectUri(value: string, httpHosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash !== "" || value.includes("#")) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || httpHosts.some((host) => host.startsWith("*.") ? url.hostname.endsWith(host.slice(1)) : url.hostname === host);
}

// A form or JSON body as form fields.
async function formBody(request: Request): Promise<URLSearchParams | null> {
  const contentType = request.headers.get("content-type") ?? "";
  try {
    return contentType.includes("application/json")
      ? new URLSearchParams(stringFields(await parseJsonRequest(request)))
      : new URLSearchParams(await request.text());
  } catch {
    return null;
  }
}

// The client a token or revocation request is from: HTTP Basic for a
// confidential client (RFC 6749 section 2.3.1), else `client_id` in the body.
function clientFrom(request: Request, body: URLSearchParams): LinkClient | null {
  const named = body.get("client_id") ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^basic /i.test(authorization)) return named ? { clientId: named } : null;
  let clientId: string;
  let clientSecret: string;
  try {
    const decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) throw new Error();
    clientId = decodeURIComponent(decoded.slice(0, separator));
    clientSecret = decodeURIComponent(decoded.slice(separator + 1));
  } catch {
    throw invalidClient();
  }
  if (!clientId || (named && named !== clientId)) throw invalidClient();
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

function invalidClient(): HttpError {
  return new HttpError(401, "Unknown client, or a missing or wrong client secret.", "invalid_client");
}

// Token endpoint (RFC 6749 section 5): form or JSON body, OAuth error shape.
async function token(platform: GatewayPlatform, link: LinkPlatform, request: Request): Promise<Response> {
  const body = await formBody(request);
  if (body === null) return oauthError("invalid_request", "The request body must be a form or a JSON object.");
  const client = clientFrom(request, body);
  if (client === null) return oauthError("invalid_request", "client_id is required.");
  const grantType = body.get("grant_type");
  if (grantType === "authorization_code") {
    const code = body.get("code") ?? "";
    const verifier = body.get("code_verifier");
    if (!code) return oauthError("invalid_request", "code is required.");
    if (verifier === null && client.clientSecret !== undefined) {
      // A code from a link token: the client's secret proves it, as Plaid's
      // public token exchange does. It was approved on one of the app's
      // redirect URIs, which the link token named.
      const app = await link.authenticateClient(client);
      const codeChallenge = linkTokenChallenge(link, app.clientId);
      let failure: unknown = new HttpError(400, "The authorization code is invalid, expired, or already used.", "invalid_grant");
      for (const redirectUri of app.redirectUris) {
        let tokens: LinkTokens;
        try {
          tokens = await link.exchangeCode({ ...client, code, redirectUri, codeChallenge });
        } catch (error) {
          failure = error;
          continue;
        }
        return await tokenResponse(platform, link, request, tokens);
      }
      throw failure;
    }
    const redirectUri = body.get("redirect_uri") ?? "";
    if (!redirectUri) return oauthError("invalid_request", "redirect_uri is required with code_verifier.");
    if (!VERIFIER.test(verifier ?? "")) {
      return oauthError("invalid_request", "code_verifier must be 43 to 128 unreserved characters.");
    }
    return await tokenResponse(platform, link, request, await link.exchangeCode({
      ...client,
      code,
      redirectUri,
      codeChallenge: pkceChallenge(verifier!),
    }));
  }
  if (grantType === "refresh_token") {
    const refreshToken = body.get("refresh_token") ?? "";
    if (!refreshToken) return oauthError("invalid_request", "refresh_token is required.");
    return await tokenResponse(platform, link, request, await link.refresh({ ...client, refreshToken }));
  }
  if (grantType === TOKEN_EXCHANGE_GRANT) return await childToken(platform, link, client, body);
  return oauthError(
    "unsupported_grant_type",
    `grant_type must be authorization_code, refresh_token, or ${TOKEN_EXCHANGE_GRANT}.`,
  );
}

/**
 * RFC 8693: trade the grant's access token for a child token that serves only
 * the models it names, for a sandbox or worker that must hold nothing more.
 * `model` is required and repeats (up to 16); `thinking` pins the level each
 * is served at (see below); `expires_in` is 60 seconds to 12 hours (default
 * 1 hour); `tags` labels its requests like the X-Dari-Tags header. Every
 * model is checked at mint: one the grant cannot serve refuses the whole
 * mint with `invalid_target`.
 */
async function childToken(
  platform: GatewayPlatform,
  link: LinkPlatform,
  client: LinkClient,
  body: URLSearchParams,
): Promise<Response> {
  const subjectToken = body.get("subject_token") ?? "";
  if (!subjectToken || body.get("subject_token_type") !== ACCESS_TOKEN_TYPE) {
    return oauthError("invalid_request", `subject_token is required, with subject_token_type ${ACCESS_TOKEN_TYPE}.`);
  }
  // `model` repeats for each model; `thinking` is absent (none pinned), given
  // once (pinned for every model), or given once per model in order, with
  // `default` leaving that model unpinned.
  const names = body.getAll("model").map((named) => explicitModelId(named) ?? named);
  if (names.length === 0 || names.length > MAX_CHILD_MODELS || names.some((name) => !name || name.length > MAX_MODEL_CHARS)) {
    return oauthError(
      "invalid_request",
      `model is required, 1 to ${MAX_CHILD_MODELS} times: catalog models such as dari/model/openai/gpt-5.5.`,
    );
  }
  const levels = body.getAll("thinking");
  if (levels.length > 1 && levels.length !== names.length) {
    return oauthError("invalid_request", "Give thinking once for every model, or once per model in the same order.");
  }
  const thinkingFor = (index: number): string | undefined => {
    const level = levels.length === 0 ? undefined : levels.length === 1 ? levels[0] : levels[index];
    return level === "default" ? undefined : level;
  };
  if (names.some((_, index) => {
    const level = thinkingFor(index);
    return level !== undefined && !isReasoningEffort(level);
  })) {
    return oauthError("invalid_request", "thinking must be a thinking level, such as low or high, or default.");
  }
  const expiresIn = body.has("expires_in") ? Number(body.get("expires_in")) : CHILD_TOKEN_DEFAULT_SECONDS;
  if (!Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > CHILD_TOKEN_MAX_SECONDS) {
    return oauthError("invalid_request", `expires_in must be 60 to ${CHILD_TOKEN_MAX_SECONDS} seconds.`);
  }
  let tags: Record<string, string>;
  try {
    tags = requestTags(body.get("tags"));
  } catch {
    return oauthError("invalid_request", "tags must be comma-separated key=value pairs.");
  }
  // The grant must hold a plan for the model's provider; whether that plan
  // can serve is decided on each request.
  const detail = await grantOf(link, subjectToken);
  if (detail === null) {
    return oauthError("invalid_grant", "subject_token must be a live access token of this client's grant.");
  }
  // The model must be one the grant serves some client now, by the names a
  // request may use (a catalog id, its bare form, or a dated snapshot), at a
  // level it offers.
  const served = await Promise.all(
    [undefined, ...detail.subscriptions.map((plan) => subscriptionClient(plan.provider as SubscriptionKind))]
      .map(async (harness) => await servedRouter(platform, subjectToken, harness)),
  );
  const servable = [...new Set(served.flatMap((router) => router?.link_models ?? []))];
  // A gateway the grant holds a key for serves any model of its own, by full id.
  const gateways = new Set(served.flatMap((router) => Object.keys(router?.link_key_gateways ?? {})));
  const gatewayModel = (name: string) => {
    const id = name.toLowerCase();
    const gateway = id.split("/")[0]!;
    return gateways.has(gateway) && id.length > gateway.length + 1 ? id : null;
  };
  const models: Array<{ model: string; thinking?: string }> = [];
  for (const [index, name] of names.entries()) {
    const model = catalogModelFor(name, servable) ?? gatewayModel(name);
    if (model === null) {
      return oauthError("invalid_target", `This grant serves no model '${name}' now. GET /v1/link/grant lists its models.`);
    }
    if (models.some((entry) => entry.model === model)) {
      return oauthError("invalid_target", `'${model}' is named twice.`);
    }
    const thinking = thinkingFor(index);
    const offered = CANONICAL_MODELS.find((entry) => entry.id === model)?.thinking_levels;
    if (thinking !== undefined && offered !== undefined && !offered.includes(thinking)) {
      return oauthError("invalid_target", `'${model}' has no thinking level '${thinking}'; it offers ${offered.join(", ")}.`);
    }
    models.push({ model, ...(thinking === undefined ? {} : { thinking }) });
  }
  const child = await link.exchangeToken({ ...client, subjectToken, models, expiresIn, tags });
  return Response.json(
    {
      access_token: child.accessToken,
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: "Bearer",
      expires_in: child.expiresIn,
      grant_id: child.grantId,
      models: models.map((entry) => ({ model: explicitModelSlug(entry.model), thinking: entry.thinking ?? null })),
      ...(Object.keys(tags).length === 0 ? {} : { tags }),
    },
    { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}

// The grant a subject token belongs to, or null when the token is dead or is
// not a grant's access token.
async function grantOf(link: LinkPlatform, accessToken: string): Promise<LinkGrantDetail | null> {
  try {
    return await link.grant(accessToken);
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) return null;
    throw error;
  }
}

// RFC 7009: the app ends its own grant, as when its user disconnects there.
// The response is 200 whether or not the token was live.
async function revoke(link: LinkPlatform, request: Request): Promise<Response> {
  const body = await formBody(request);
  if (body === null) return oauthError("invalid_request", "The request body must be a form or a JSON object.");
  const client = clientFrom(request, body);
  const presented = body.get("token") ?? "";
  if (client === null || !presented) return oauthError("invalid_request", "client_id and token are required.");
  await link.revokeToken({ ...client, token: presented });
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}

async function grant(platform: GatewayPlatform, link: LinkPlatform, request: Request): Promise<Response> {
  const accessToken = bearerToken(request.headers);
  const detail = await link.grant(accessToken);
  return Response.json(await grantBody(platform, request, accessToken, detail), { headers: { "Cache-Control": "no-store" } });
}

/**
 * What the grant's requests used, child tokens' included: `tag=k=v`
 * (repeatable; every one must match) and `since`/`until` (ISO 8601) filter.
 * Input tokens exclude cache reads and writes whatever the protocol.
 */
async function usage(link: LinkPlatform, request: Request, params: URLSearchParams, requestId?: string): Promise<Response> {
  const accessToken = bearerToken(request.headers);
  const tags: Record<string, string> = {};
  for (const pair of params.getAll("tag")) {
    const at = pair.indexOf("=");
    const key = pair.slice(0, at).trim();
    if (at <= 0 || !key) throw new HttpError(400, "Each tag filter must be key=value.", "invalid_request_error", "tag");
    tags[key] = pair.slice(at + 1).trim();
  }
  const time = (name: "since" | "until"): Date | undefined => {
    const value = params.get(name);
    if (value === null) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new HttpError(400, `${name} must be an ISO 8601 time.`, "invalid_request_error", name);
    }
    return date;
  };
  const since = time("since");
  const until = time("until");
  // `group_by=tag:<key>` also totals the requests by that tag's values.
  const groupBy = params.get("group_by");
  const groupByTag = groupBy === null ? undefined : groupBy.startsWith("tag:") ? groupBy.slice(4).trim() : "";
  if (groupByTag !== undefined && (groupByTag === "" || groupByTag.length > MAX_TAG_KEY_CHARS)) {
    throw new HttpError(400, "group_by must be tag:<key>.", "invalid_request_error", "group_by");
  }
  const result = await link.usage({
    accessToken,
    tags,
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    ...(groupByTag === undefined ? {} : { groupByTag }),
    ...(requestId === undefined ? {} : { requestId }),
  });
  // One request's usage (its `X-Request-Id`) is a 404 until it is recorded,
  // a moment after its response ends.
  if (requestId !== undefined && result.requests === 0) {
    throw new HttpError(404, `No recorded request ${requestId} of this grant yet.`, "not_found");
  }
  const totals = (value: LinkUsageTotals) => ({
    requests: value.requests,
    errors: value.errors,
    input_tokens: value.inputTokens,
    output_tokens: value.outputTokens,
    cache_read_tokens: value.cacheReadTokens,
    cache_write_tokens: value.cacheWriteTokens,
  });
  return Response.json(
    {
      ...totals(result),
      complete_through: result.completeThrough,
      by_model: result.byModel.map((entry) => ({ model: entry.model, thinking: entry.thinking, ...totals(entry) })),
      ...(result.byTag === undefined
        ? {}
        : { by_tag: result.byTag.map((entry) => ({ value: entry.value, ...totals(entry) })) }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function stringFields(body: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(body).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : typeof value === "number" ? [[key, String(value)]] : []
    ),
  );
}

async function tokenResponse(platform: GatewayPlatform, link: LinkPlatform, request: Request, tokens: LinkTokens): Promise<Response> {
  return Response.json(
    {
      access_token: tokens.accessToken,
      token_type: "Bearer",
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      ...(await grantBody(platform, request, tokens.accessToken, await link.grant(tokens.accessToken))),
    },
    { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}

/**
 * What a grant lets its app do: each granted plan, which clients it serves,
 * its quota, and the models it serves now, by the names a request uses.
 * `models` is what a plain API client (anything but Claude Code or Muse Code)
 * can name, and `routes` whether `dari/routing` serves it.
 */
async function grantBody(platform: GatewayPlatform, request: Request, accessToken: string, detail: LinkGrantDetail) {
  const now = Date.now();
  const kinds = detail.subscriptions
    .filter((subscription) => subscription.apiKeyProvider === undefined)
    .map((subscription) => subscription.provider as SubscriptionKind);
  const clients = new Set<ClientHarness | undefined>([undefined, ...kinds.map(subscriptionClient)]);
  const served = new Map<ClientHarness | undefined, ResolvedRouter | null>();
  for (const client of clients) served.set(client, await servedRouter(platform, accessToken, client));
  const models = (router: ResolvedRouter | null | undefined) => router?.link_models ?? router?.enabled_models ?? [];
  const plain = served.get(undefined);
  return {
    grant_id: detail.id,
    client_id: detail.clientId,
    app_name: detail.appName,
    created_at: detail.createdAt,
    scope: LINK_SCOPE,
    // Each budget window: the tokens the grant used in it and its cap.
    budget: detail.budget.map((standing) => ({
      window_minutes: standing.windowMinutes,
      max_tokens: standing.maxTokens,
      used_tokens: standing.usedTokens,
      resets_at: standing.resetsAt,
    })),
    // `budget_limit` while a window is at its cap, until `available_at`.
    ...grantState(detail.budget),
    // Where the user manages this grant: the connections page, in the browser they approved it in.
    manage_url: `${publicOrigin(request)}${CONNECTIONS_PATH}#${encodeURIComponent(detail.id)}`,
    plans: detail.subscriptions.map((subscription) => {
      // An API key serves its provider's models to any app.
      const keyFor = subscription.apiKeyProvider;
      const kind = subscription.provider as SubscriptionKind;
      const client = keyFor === undefined ? subscriptionClient(kind) : undefined;
      return {
        ...planState(subscription, now),
        id: subscription.id,
        kind: keyFor === undefined ? kind : API_KEY,
        // What to call it on screen: "Claude", "ChatGPT", "OpenRouter".
        title: keyFor === undefined ? KINDS[kind]?.name ?? kind : subscription.name,
        ...(keyFor === undefined ? {} : { provider: keyFor }),
        // A gateway key serves any model named with this prefix; `models` lists none.
        ...(keyFor !== undefined && gatewayFor(keyFor) !== undefined ? { model_prefix: `${keyFor}/` } : {}),
        plan: keyFor === undefined ? SUBSCRIPTION_PLAN_LABELS[kind] ?? kind : `${subscription.name} API Key`,
        label: planLabel(subscription),
        account_email: subscription.accountEmail,
        serves: client === undefined ? "any_app" : `${client}_only`,
        unavailable_until: subscription.unavailableUntil,
        usage: subscription.usage.map((window) => ({
          ...(window.modelFamily === undefined ? {} : { model_family: window.modelFamily }),
          window_minutes: window.minutes,
          utilization: window.utilization,
          resets_at: window.resetsAt,
        })),
        // A key's provider's models; a plan's are the ones it has an offering
        // of, whoever makes them (every OpenCode Go model is another maker's).
        models: models(served.get(client))
          .filter((model) => keyFor === undefined ? modelSubscriptions(model).includes(kind) : providerForModel(model) === keyFor)
          .map(namedModel),
      };
    }),
    models: models(plain).map(namedModel),
    routes: (plain?.enabled_models.length ?? 0) > 0,
  };
}

/** The latest of some times, or null for none. */
function latest(times: readonly string[]): string | null {
  return times.reduce<string | null>((last, time) => last === null || Date.parse(time) > Date.parse(last) ? time : last, null);
}

/**
 * Whether a granted plan serves the app now. `plan_limit`: the plan is at its
 * own usage limit, available again at `available_at` (null when ready or not
 * known).
 */
function planState(subscription: LinkSubscription, now: number): {
  state: "ready" | "plan_limit";
  available_at: string | null;
} {
  const planTimes = [
    ...(subscription.unavailableUntil !== null && Date.parse(subscription.unavailableUntil) > now ? [subscription.unavailableUntil] : []),
    ...subscription.usage.filter((window) => window.modelFamily === undefined && window.utilization >= 1 && Date.parse(window.resetsAt) > now).map((window) => window.resetsAt),
  ];
  return planTimes.length > 0 ? { state: "plan_limit", available_at: latest(planTimes) } : { state: "ready", available_at: null };
}

/** Whether the grant is within its budget: `budget_limit` until every window at its cap rolls on. */
function grantState(budget: readonly LinkBudgetStanding[]): {
  state: "ready" | "budget_limit";
  available_at: string | null;
} {
  const times = budget.flatMap((standing) => standing.resetsAt === null ? [] : [standing.resetsAt]);
  return times.length > 0 ? { state: "budget_limit", available_at: latest(times) } : { state: "ready", available_at: null };
}

// A model as a request names it, with its catalog display name.
function namedModel(model: string): { id: string; name: string } {
  return { id: explicitModelSlug(model), name: canonicalModelName(model) };
}

// A person's name for a plan: their label, else the account, else the plan.
function planLabel(subscription: LinkSubscription): string {
  if (subscription.apiKeyProvider !== undefined) return subscription.label ?? subscription.name;
  const kind = subscription.provider as SubscriptionKind;
  return subscription.label ?? subscription.accountEmail ?? SUBSCRIPTION_PLAN_LABELS[kind] ?? kind;
}

// What the default router serves this token for a client right now.
async function servedRouter(
  platform: GatewayPlatform,
  accessToken: string,
  clientHarness: ClientHarness | undefined,
): Promise<ResolvedRouter | null> {
  try {
    return await platform.resolveRouter({
      routerId: DEFAULT_ROUTER_ALIAS,
      apiKey: accessToken,
      provisional: true,
      ...(clientHarness ? { clientHarness } : {}),
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 424) return null;
    throw error;
  }
}

/**
 * An OAuth endpoint's refusals in the OAuth error shape. `invalid_client` is
 * a 401 (RFC 6749 section 5.2), and `refresh_race` is an `invalid_grant` whose
 * `error_code` tells a lost rotation race from a dead refresh token.
 */
async function oauthEndpoint(respond: () => Promise<Response>): Promise<Response> {
  try {
    return await respond();
  } catch (error) {
    if (!(error instanceof HttpError) || (error.status !== 400 && error.code !== "invalid_client")) throw error;
    if (error.code === "invalid_client") {
      return oauthError("invalid_client", error.message, 401, { "WWW-Authenticate": 'Basic realm="dari-link"' });
    }
    if (error.code === "refresh_race") return oauthError("invalid_grant", error.message, 400, {}, "refresh_race");
    return oauthError(error.code, error.message);
  }
}

function oauthError(
  error: string,
  description: string,
  status = 400,
  headers: Record<string, string> = {},
  errorCode?: string,
): Response {
  return Response.json(
    { error, ...(errorCode === undefined ? {} : { error_code: errorCode }), error_description: description },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
  );
}

/**
 * Plaid's `/link/token/create`: the app's server, with its client id and
 * secret, makes a short-lived token that carries what Link offers. The page
 * opens Link with it and gets back a code, which the server redeems with its
 * secret alone: no state or PKCE for the app to keep. JSON body:
 * `client_id`, `secret` (or HTTP Basic), and optionally `redirect_uri` (one
 * the app registered; default its first), `plans`, `client`, `key_providers`
 * (arrays), `purposes` ({ any_app, claude_code, muse_code }), and `grant_id`
 * for update mode.
 */
async function createLinkToken(link: LinkPlatform, request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await parseJsonRequest(request);
  } catch {
    return oauthError("invalid_request", "The request body must be a JSON object.");
  }
  const named = clientFrom(request, new URLSearchParams(stringFields(body)));
  const clientSecret = named?.clientSecret ?? (typeof body.secret === "string" ? body.secret : undefined);
  if (named === null || !clientSecret) return oauthError("invalid_request", "client_id and secret are required.");
  const app = await link.authenticateClient({ clientId: named.clientId, clientSecret });
  const list = (name: string) => {
    const value = body[name];
    return Array.isArray(value) ? value.filter((item) => typeof item === "string").join(" ") : typeof value === "string" ? value : "";
  };
  const purposes = typeof body.purposes === "object" && body.purposes !== null ? body.purposes as Record<string, unknown> : {};
  const fields: Record<string, string> = {
    client_id: app.clientId,
    redirect_uri: typeof body.redirect_uri === "string" ? body.redirect_uri : app.redirectUris[0] ?? "",
    ...(list("plans") ? { plans: list("plans") } : {}),
    ...(list("client") ? { client: list("client") } : {}),
    ...(list("key_providers") ? { key_providers: list("key_providers") } : {}),
    ...(typeof body.grant_id === "string" ? { grant_id: body.grant_id } : {}),
    ...Object.fromEntries(PLAN_AUDIENCES.flatMap((audience) =>
      typeof purposes[audience] === "string" ? [[`purpose_${audience}`, purposes[audience] as string]] : []
    )),
  };
  // Exactly a registered URI, which the code exchange tries; then the same
  // checks the approval page makes, so a bad request fails here.
  if (!app.redirectUris.includes(fields.redirect_uri!)) {
    return oauthError("invalid_request", "redirect_uri must be exactly one the app registered.");
  }
  const checked = await authorizeRequest(link, new URLSearchParams({
    ...fields,
    response_type: "code",
    code_challenge: linkTokenChallenge(link, app.clientId),
    code_challenge_method: "S256",
  }));
  if (checked instanceof Response) return oauthError("invalid_request", await errorText(checked));
  const expiration = new Date(Date.now() + LINK_TOKEN_SECONDS * 1000);
  return Response.json(
    {
      link_token: `${LINK_TOKEN_PREFIX}${signedValue(link.approval.sessionSecret(), "link_token", fields, LINK_TOKEN_SECONDS)}`,
      expiration: expiration.toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// The authorize fields a link token carries, or null for a bad or expired one.
function readLinkToken(link: LinkPlatform, token: string): Record<string, string> | null {
  if (!token.startsWith(LINK_TOKEN_PREFIX)) return null;
  const value = readSignedValue(token.slice(LINK_TOKEN_PREFIX.length), link.approval.sessionSecret(), "link_token");
  if (value === null) return null;
  const { exp: _, ...fields } = value;
  return stringFields(fields);
}

// The PKCE challenge every link-token code for a client carries: the client's
// secret, not a verifier, proves the code at the exchange.
function linkTokenChallenge(link: LinkPlatform, clientId: string): string {
  return pkceChallenge(sign(link.approval.sessionSecret(), `link_token_pkce\0${clientId}`));
}

// What a refused approval request says: the text of its page.
async function errorText(response: Response): Promise<string> {
  const message = /<p>([^<]*)<\/p>/.exec(await response.text())?.[1];
  return message === undefined ? "The link token request is invalid." : unescapeHtml(message);
}

function unescapeHtml(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&");
}

type AuthorizeRequest = {
  app: LinkApp;
  redirectUri: string;
  state: string | null;
  // Post the result to the opener instead of redirecting.
  webMessage: boolean;
  codeChallenge: string;
  // The clients the app runs: a plan limited to one serves the app only then.
  clients: ClientHarness[];
  // The plan kinds, and `api_key` for API keys, the app asks to connect; null offers every kind.
  plans: OfferKind[] | null;
  // The providers and gateways whose API keys the app can use; null is every one.
  keyProviders: string[] | null;
  // What the app says it does with each audience's plans, shown beside them.
  purposes: Partial<Record<PlanAudience, string>>;
  // Update mode: the user's grant for this app whose plans to change in place.
  grantId: string | null;
};

// A space- or comma-separated list parameter.
function listParam(value: string | null): string[] {
  return [...new Set((value ?? "").split(/[\s,]+/).filter(Boolean))];
}

/**
 * The validated authorization request, or the response that ends it. Until
 * the client and redirect URI check out, errors are shown on the page, never
 * redirected (RFC 6749 section 4.1.2.1).
 */
async function authorizeRequest(link: LinkPlatform, params: URLSearchParams): Promise<AuthorizeRequest | Response> {
  const linkToken = params.get("link_token");
  if (linkToken !== null) {
    const fields = readLinkToken(link, linkToken);
    if (fields === null) {
      return page("Link Expired", `<div class="body"><h1>Link Expired</h1><p>Go back to the app and connect again.</p></div>`, { status: 400 });
    }
    // The token's request, with the challenge its code redeems by and the
    // token itself as the state the app's window matches the result to.
    params = new URLSearchParams({
      ...fields,
      response_type: "code",
      code_challenge: linkTokenChallenge(link, fields.client_id ?? ""),
      code_challenge_method: "S256",
      state: linkToken,
      ...(params.get("response_mode") !== null ? { response_mode: params.get("response_mode")! } : {}),
    });
  }
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const app = clientId ? await link.app(clientId) : null;
  if (app === null || !registeredRedirect(app.redirectUris, redirectUri)) {
    return page("Unknown App", `<div class="body"><h1>Unknown App</h1><p>This link request names an app or redirect URI Dari does not know.</p></div>`, { status: 400 });
  }
  const state = params.get("state");
  const responseMode = params.get("response_mode");
  const webMessage = responseMode === WEB_MESSAGE;
  if (responseMode !== null && responseMode !== "query" && !webMessage) {
    return badRequest(`response_mode is query or ${WEB_MESSAGE}.`);
  }
  if (params.get("response_type") !== "code") {
    return badRequest("response_type must be code.");
  }
  const codeChallenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !CHALLENGE.test(codeChallenge)) {
    return badRequest("PKCE with code_challenge_method=S256 is required.");
  }
  const scope = params.get("scope");
  if (scope !== null && scope.trim() !== "" && scope.trim() !== LINK_SCOPE) {
    return badRequest(`The only scope is ${LINK_SCOPE}.`);
  }
  const clients = listParam(params.get("client"));
  if (!clients.every((client) => (CLIENTS as readonly string[]).includes(client))) {
    return badRequest(`client lists the clients the app runs: ${CLIENTS.join(", ")}.`);
  }
  const plans = listParam(params.get("plans"));
  if (!plans.every((plan) => (OFFER_KINDS as readonly string[]).includes(plan))) {
    return badRequest(`plans lists the kinds to offer: ${OFFER_KINDS.join(", ")}.`);
  }
  const keyProviders = listParam(params.get("key_providers"));
  if (!keyProviders.every((provider) => /^[a-z0-9-]{1,64}$/.test(provider))) {
    return badRequest("key_providers lists the providers whose API keys the app can use, such as anthropic openrouter.");
  }
  const purposes: AuthorizeRequest["purposes"] = {};
  for (const audience of PLAN_AUDIENCES) {
    const purpose = params.get(`purpose_${audience}`)?.trim();
    if (purpose) purposes[audience] = purpose.slice(0, MAX_PURPOSE_CHARS);
  }
  const grantId = params.get("grant_id");
  if (grantId !== null && !GRANT_ID.test(grantId)) {
    return badRequest("grant_id names one of the user's grants for this app.");
  }
  return {
    app,
    redirectUri,
    state,
    webMessage,
    codeChallenge,
    clients: clients as ClientHarness[],
    plans: plans.length === 0 ? null : plans as OfferKind[],
    keyProviders: keyProviders.length === 0 ? null : keyProviders,
    purposes,
    grantId,
  };
}

async function authorizePage(link: LinkPlatform, request: Request, params: URLSearchParams): Promise<Response> {
  const authorize = await authorizeRequest(link, params);
  if (authorize instanceof Response) return authorize;
  const approval = link.approval;
  const secret = approval.sessionSecret();
  const session = sessionFrom(request, approval);
  // On a platform with accounts, only a signed-in user has a provider sign-in under way.
  const connect = session === null && approval.signIn !== undefined ? null : connectFrom(request, secret);
  if (connect !== null) {
    // A provider that gave the user a code to enter is asked whether they approved.
    return connect.userCode === null
      ? providerPage(authorize, connect)
      : await finishConnect(approval, request, authorize, session, connect, "");
  }
  return await homePage(approval, authorize, session);
}

// Where the user stands without a sign-in under way: choosing among the plans
// they connected, or at the start.
async function homePage(approval: LinkApprovalPage, authorize: AuthorizeRequest, session: Session | null): Promise<Response> {
  const current = await grantToUpdate(approval, authorize, session);
  if (current instanceof Response) return current;
  if (session === null) return introPage(approval, authorize);
  const subscriptions = await approval.subscriptions(session.subject);
  return shareable(authorize, subscriptions).length > 0
    ? choosePage(authorize, session, subscriptions, current)
    : introPage(approval, authorize);
}

// In update mode, the grant being changed. A grant this browser's user does
// not hold (another browser, cleared cookies) starts a new connection instead,
// as Plaid Link does.
async function grantToUpdate(
  approval: LinkApprovalPage,
  authorize: AuthorizeRequest,
  session: Session | null,
): Promise<GrantToUpdate | null | Response> {
  if (authorize.grantId === null) return null;
  const grant = session === null ? null : await approval.grant(session.subject, authorize.grantId, authorize.app.clientId);
  if (grant === null) authorize.grantId = null;
  return grant;
}

type GrantToUpdate = { credentialIds: string[]; budget: LinkBudget[]; limits: LinkLimit[] };

async function authorizeSubmit(link: LinkPlatform, request: Request, form: URLSearchParams): Promise<Response> {
  const approval = link.approval;
  // Only the page itself submits here: another site's form would otherwise
  // arrive without the user's cookie and replace it with a new identity.
  if (crossSite(request)) {
    return page("Request Refused", `<div class="body"><h1>Request Refused</h1><p>Open Dari Link from the app again.</p></div>`, { status: 403 });
  }
  const authorize = await authorizeRequest(link, form);
  if (authorize instanceof Response) return authorize;
  const back = { redirectUri: authorize.redirectUri, state: authorize.state, webMessage: authorize.webMessage };
  const secret = approval.sessionSecret();
  const session = sessionFrom(request, approval);
  if (session === null && approval.signIn !== undefined && !["deny", "sign_out"].includes(form.get("decision") ?? "")) {
    return signIn(request, approval.signIn, secret, `${AUTHORIZE_PATH}?${authorizeQuery(authorize)}`);
  }
  const endConnect = clearCookie(request, CONNECT_COOKIE);
  // A plan's or a key provider's row on the select page is its own submit button.
  const kind = form.get("connect");
  const keyProvider = keyProviders(approval, authorize).find((provider) => provider.id === (form.get("key") ?? form.get("key_provider")));
  if (form.get("key") !== null && form.get("decision") === null) {
    return keyProvider === undefined
      ? selectPage(approval, authorize, "Choose a provider to add a key for.", [endConnect])
      : keyPage(authorize, keyProvider, undefined, [endConnect]);
  }
  const decision = kind !== null ? "connect" : form.get("decision");
  if (decision === "deny") return redirect(back, { error: "access_denied" }, [endConnect]);
  if (decision === "sign_out") return signOut(request, approval, `${AUTHORIZE_PATH}?${authorizeQuery(authorize)}`);
  if (decision === "select") return selectPage(approval, authorize, undefined, [endConnect]);
  if (decision === "connect") {
    if (!connectKinds(approval, authorize).includes(kind as SubscriptionKind)) {
      return selectPage(approval, authorize, "Choose a subscription to connect.", [endConnect]);
    }
    let started: LinkConnect;
    try {
      started = await approval.startConnect(kind as SubscriptionKind);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      // A gateway that cannot take subscriptions says why; anything else is the provider.
      const reason = error.code === "link_not_configured" ? error.message : `Could not reach ${KINDS[kind as SubscriptionKind].at}. Try again.`;
      return selectPage(approval, authorize, reason, [endConnect]);
    }
    return seeAuthorize(authorize, [
      signedCookie(
        request,
        secret,
        CONNECT_COOKIE,
        { session: started.session, kind, url: started.authorizationUrl, code: started.userCode },
        CONNECT_SECONDS,
      ),
    ]);
  }
  if (decision === "add_key") {
    if (keyProvider === undefined) return selectPage(approval, authorize, "Choose a provider to add a key for.", [endConnect]);
    const apiKey = form.get("api_key")?.trim() ?? "";
    if (!apiKey) return keyPage(authorize, keyProvider, `Paste your ${keyProvider.name} API key.`);
    // A first plan makes the user, whom the cookie remembers.
    let added;
    try {
      added = await approval.addKey(session?.subject ?? null, keyProvider.id, apiKey);
    } catch (error) {
      if (!(error instanceof HttpError) || (error.status !== 400 && error.code !== "link_not_configured")) throw error;
      return keyPage(authorize, keyProvider, error.message);
    }
    return seeAuthorize(authorize, [userCookie(request, approval, added.subject), endConnect]);
  }
  const connect = connectFrom(request, secret);
  if (decision === "complete" && connect !== null) {
    return await finishConnect(approval, request, authorize, session, connect, form.get("authorization_response")?.trim() ?? "");
  }
  // Anything else goes back to where the user stands.
  if (decision !== "approve" || session === null) return seeAuthorize(authorize, [endConnect]);
  if (!sameText(form.get("csrf") ?? "", session.csrf)) {
    return page("Approval Expired", `<div class="body"><h1>Approval Expired</h1><p>This approval is no longer valid. Go back to the app and start again.</p></div>`, { status: 403 });
  }
  const current = await grantToUpdate(approval, authorize, session);
  if (current instanceof Response) return current;
  const subscriptions = await approval.subscriptions(session.subject);
  const credentialIds = [...new Set(form.getAll("credential_id"))];
  if (credentialIds.length === 0) return choosePage(authorize, session, subscriptions, current, "Choose at least one subscription.");
  const usable = new Set(shareable(authorize, subscriptions).map((subscription) => subscription.id));
  if (!credentialIds.every((id) => usable.has(id))) {
    return choosePage(authorize, session, subscriptions, current, `${authorize.app.name} cannot use one of the plans you chose.`);
  }
  const limits = limitsFromForm(form, credentialIds);
  if (limits === null) return choosePage(authorize, session, subscriptions, current, LIMITS_ERROR);
  try {
    const { code } = await approval.approve({
      subject: session.subject,
      ...(authorize.grantId !== null ? { grantId: authorize.grantId } : {}),
      clientId: authorize.app.clientId,
      redirectUri: authorize.redirectUri,
      codeChallenge: authorize.codeChallenge,
      credentialIds,
      budget: current?.budget ?? [],
      limits,
    });
    return redirect(back, { code }, [endConnect]);
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) {
      return choosePage(authorize, session, subscriptions, current, error.message);
    }
    throw error;
  }
}

// Finish a provider sign-in: with the code the user pasted, or by asking the
// provider whether the user approved the code it gave them.
async function finishConnect(
  approval: LinkApprovalPage,
  request: Request,
  authorize: AuthorizeRequest,
  session: Session | null,
  connect: Connect,
  authorizationResponse: string,
): Promise<Response> {
  const endConnect = clearCookie(request, CONNECT_COOKIE);
  let connected: LinkPlanAdded | null;
  try {
    // A first plan makes the user, whom the cookie remembers.
    connected = await approval.completeConnect(session?.subject ?? null, connect.session, authorizationResponse);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 400) throw error;
    // A pasted code can be pasted again; a sign-in the provider ended starts over.
    return connect.userCode === null
      ? providerPage(authorize, connect, error.message)
      : selectPage(approval, authorize, error.message, [endConnect]);
  }
  return connected === null
    ? providerPage(authorize, connect)
    : seeAuthorize(authorize, [userCookie(request, approval, connected.subject), endConnect]);
}

/**
 * The connections page: the apps the browser's user connected, with what each
 * shares and used so far, its budget, and Disconnect; then the user's plans
 * and keys, each of which they can remove.
 */
async function connectionsPage(approval: LinkApprovalPage, request: Request, error?: string): Promise<Response> {
  const session = sessionFrom(request, approval);
  const title = "Connected Apps";
  if (session === null) {
    return approval.signIn === undefined
      ? page(title, `<div class="body"><h1>${title}</h1><p>No apps are connected in this browser. Apps that use Dari Link connect from their own Connect button.</p></div>`)
      : page(title, `<form method="post" action="${CONNECTIONS_PATH}"><div class="body"><h1>${title}</h1><p>Sign in to see the apps you connected.</p></div>
<div class="foot"><button class="btn primary" type="submit" name="decision" value="sign_in">Sign In</button></div></form>`);
  }
  const [connections, plans] = await Promise.all([
    approval.connections(session.subject),
    approval.subscriptions(session.subject),
  ]);
  const csrf = `<input type="hidden" name="csrf" value="${session.csrf}">`;
  const cards = connections.map((connection) => connectionCard(connection, csrf));
  const planRows = plans.map((plan) => `<form class="option pick" method="post" action="${CONNECTIONS_PATH}">${csrf}
<input type="hidden" name="remove_id" value="${escapeHtml(plan.id)}">${logo(plan.apiKeyProvider ?? plan.provider, planName(plan))}<span class="grow"><strong>${escapeHtml(planName(plan))}</strong><small>${escapeHtml(planLabel(plan))}</small></span><button class="nav drop" type="submit" name="decision" value="remove" aria-label="Remove">${ICONS.trash}</button></form>`);
  return page(
    title,
    `<div class="body">
<h1>${title}</h1>
${error === undefined ? "" : `<p role="alert">${escapeHtml(error)}</p>`}
${cards.length === 0 ? "<p>No apps are connected.</p>" : cards.join("\n")}
${planRows.length === 0 ? "" : `<p class="label">Your Plans And Keys</p>\n${planRows.join("\n")}`}
${session.account ? `<form method="post" action="${CONNECTIONS_PATH}">${csrf}${SIGN_OUT}</form>` : ""}
</div>`,
  );
}

const LIMITS_ERROR = "Each plan limit is a percent above 0 and at most 100, and each key limit a dollar amount; leave it empty for none.";

// The limits typed into a form: `pct_<id>` a percent of a plan, `usd_<id>`
// dollars a month; empty means none. Only for `only`'s plans when given; null
// when one is not a valid limit.
function limitsFromForm(form: URLSearchParams, only?: readonly string[]): LinkLimit[] | null {
  return validLimits([...form.entries()].flatMap(([field, raw]) => {
    const value = raw.replace(/[\s,$%]/g, "");
    const kind = field.slice(0, 4);
    const id = field.slice(4);
    if ((kind !== "usd_" && kind !== "pct_") || value === "" || (only !== undefined && !only.includes(id))) return [];
    const amount = /^\d+(\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
    return [{ credential_id: id, [kind === "usd_" ? "monthly_usd" : "max_percent"]: amount }];
  }));
}

// A limit field for one plan or key, as the connections page and consent share.
function limitInput(plan: LinkSubscription, id: string, label: string, value: number | undefined): string {
  const key = plan.apiKeyProvider !== undefined;
  return `<input id="${id}" type="text" inputmode="decimal" name="${key ? "usd" : "pct"}_${escapeHtml(plan.id)}" value="${value ?? ""}" placeholder="${key ? "$ / Month" : "% Of Plan"}" aria-label="${escapeHtml(label)} ${key ? "Monthly Limit ($)" : "Most Of Plan (%)"}" autocomplete="off">`;
}

function connectionCard(connection: LinkConnection, csrf: string): string {
  const names = connection.subscriptions.map(planName);
  // A plan's account tells it apart only when the app shares two of the same name.
  const shown = (plan: LinkSubscription) =>
    names.filter((name) => name === planName(plan)).length > 1 ? `${planName(plan)} (${planLabel(plan)})` : planName(plan);
  // One row per shared plan or key: a plan's use of its quota and the most of
  // it the app may use; a key's spend this month and the most it may spend.
  const row = (plan: LinkSubscription) => {
    const spend = connection.spend.find((entry) => entry.credentialId === plan.id);
    // A plan still limited in dollars, as before shares, keeps its dollars.
    const key = plan.apiKeyProvider !== undefined || (spend?.monthlyUsd ?? null) !== null;
    const field = `${key ? "usd" : "pct"}_${escapeHtml(plan.id)}`;
    const id = `${field}_${escapeHtml(connection.id)}`;
    const used = key
      ? `${dollars(spend?.spentUsd ?? 0)} this month`
      : spend?.usedPercent == null ? "Usage not reported yet" : `Plan ${Math.round(spend.usedPercent)}% used`;
    const value = key ? spend?.monthlyUsd : spend?.maxPercent;
    return `<div class="limit">${logo(plan.apiKeyProvider ?? plan.provider, planName(plan))}<label class="grow" for="${id}"><strong>${escapeHtml(shown(plan))}</strong><small>${used}${spend?.reached ? ", at the limit" : ""}</small></label>
<input id="${id}" type="text" inputmode="decimal" name="${field}" value="${value ?? ""}" placeholder="${key ? "$ / Month" : "% Of Plan"}" aria-label="${escapeHtml(shown(plan))} ${key ? "Monthly Limit ($)" : "Most Of Plan (%)"}" autocomplete="off"></div>`;
  };
  const limited = connection.spend.some((entry) => entry.monthlyUsd !== null || entry.maxPercent !== null);
  return `<form class="card" id="${escapeHtml(connection.id)}" method="post" action="${CONNECTIONS_PATH}">${csrf}
<input type="hidden" name="grant_id" value="${escapeHtml(connection.id)}">
<strong>${escapeHtml(connection.appName)}${connection.endpoint ? " (Endpoint)" : ""}</strong>
${connection.subscriptions.length === 0 ? "<small>Shares nothing</small>" : `<span class="logos" role="img" aria-label="Shares ${escapeHtml(connection.subscriptions.map(shown).join(", "))}">${[...new Map(connection.subscriptions.map((plan) => [plan.apiKeyProvider ?? plan.provider, plan])).values()].map((plan) => logo(plan.apiKeyProvider ?? plan.provider, planName(plan))).join("")}</span>`}
${connection.subscriptions.length === 0 ? "" : `<details${limited ? " open" : ""}><summary>Set Limit</summary>
${connection.subscriptions.map(row).join("\n")}
<button class="btn outline" type="submit" name="decision" value="limits">Save</button></details>`}
<div class="row"><button class="btn outline" type="submit" name="decision" value="disconnect">Disconnect</button></div>
</form>`;
}

async function connectionsSubmit(approval: LinkApprovalPage, request: Request, form: URLSearchParams): Promise<Response> {
  if (crossSite(request)) {
    return page("Request Refused", `<div class="body"><h1>Request Refused</h1><p>Open the connections page again.</p></div>`, { status: 403 });
  }
  const secret = approval.sessionSecret();
  const session = sessionFrom(request, approval);
  if (session === null && approval.signIn !== undefined && form.get("decision") === "sign_in") {
    return signIn(request, approval.signIn, secret, CONNECTIONS_PATH);
  }
  const back = new Response(null, { status: 303, headers: { Location: CONNECTIONS_PATH, "Cache-Control": "no-store" } });
  if (session === null || !sameText(form.get("csrf") ?? "", session.csrf)) return back;
  const decision = form.get("decision");
  if (decision === "sign_out") return signOut(request, approval, CONNECTIONS_PATH);
  const grantId = form.get("grant_id") ?? "";
  if (decision === "disconnect") {
    await approval.disconnect(session.subject, grantId);
    return back;
  }
  if (decision === "limits") {
    const limits = limitsFromForm(form);
    if (limits === null) return await connectionsPage(approval, request, LIMITS_ERROR);
    await approval.setLimits(session.subject, grantId, limits);
    return back;
  }
  const removing = form.get("remove_id");
  const plan = removing === null ? undefined : (await approval.subscriptions(session.subject)).find((candidate) => candidate.id === removing);
  if (plan !== undefined && decision === "remove") {
    const name = planName(plan);
    return page(`Remove ${name}`, `<form method="post" action="${CONNECTIONS_PATH}"><div class="body">
<span class="who">${logo(plan.apiKeyProvider ?? plan.provider, name)}</span>
<h1>Remove ${escapeHtml(name)}</h1>
<p>${escapeHtml(planLabel(plan))}</p>
<p>Dari deletes ${plan.apiKeyProvider === undefined ? "the sign-in it holds for this plan" : "this key"}. Every app you shared it with stops using it.</p>
<input type="hidden" name="csrf" value="${session.csrf}">
<input type="hidden" name="remove_id" value="${escapeHtml(plan.id)}">
</div><div class="foot"><button class="btn danger" type="submit" name="decision" value="remove_confirmed">Remove</button></div></form>`);
  }
  if (plan !== undefined && decision === "remove_confirmed") await approval.remove(session.subject, plan.id);
  return back;
}

function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

// What a plan or key is called: "Claude", or "OpenRouter API Key".
function planName(subscription: LinkSubscription): string {
  return subscription.apiKeyProvider !== undefined
    ? `${subscription.name} API Key`
    : KINDS[subscription.provider as SubscriptionKind]?.name ?? subscription.name;
}

// Back to the approval page by GET, so no form is left to resubmit.
function seeAuthorize(authorize: AuthorizeRequest, cookies: string[]): Response {
  const headers = new Headers({ Location: `${AUTHORIZE_PATH}?${authorizeQuery(authorize)}`, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

// A plan limited to one client serves the app only when the app runs it.
function usableBy(kind: SubscriptionKind, clients: readonly ClientHarness[]): boolean {
  const only = subscriptionClient(kind);
  return only === undefined || clients.includes(only);
}

// The kinds of plan the user can connect for this app: those it asked for and can use.
function connectKinds(approval: LinkApprovalPage, authorize: AuthorizeRequest): SubscriptionKind[] {
  return approval.connectable.filter((kind) =>
    (authorize.plans === null || authorize.plans.includes(kind)) && usableBy(kind, authorize.clients));
}

// Whose API key the user can add for this app: none when it asked only for
// plans, and only the providers it named when it named some.
function keyProviders(approval: LinkApprovalPage, authorize: AuthorizeRequest): readonly LinkKeyProvider[] {
  if (authorize.plans !== null && !authorize.plans.includes(API_KEY)) return [];
  return approval.keyProviders.filter((provider) => authorize.keyProviders === null || authorize.keyProviders.includes(provider.id));
}

// The user's plans and API keys the app asked for and can use. A key serves any app.
function shareable(authorize: AuthorizeRequest, subscriptions: LinkSubscription[]): LinkSubscription[] {
  return subscriptions.filter((subscription) => {
    if (subscription.apiKeyProvider !== undefined) {
      return (authorize.plans === null || authorize.plans.includes(API_KEY))
        && (authorize.keyProviders === null || authorize.keyProviders.includes(subscription.apiKeyProvider));
    }
    const kind = subscription.provider as SubscriptionKind;
    return (authorize.plans === null || authorize.plans.includes(kind)) && usableBy(kind, authorize.clients);
  });
}

// The user the cookie remembers, and the form token that ties an approval to
// them; another site has neither. `account`: they signed in to the platform's
// account, so they can sign out (as on a shared computer).
type Session = { subject: string; csrf: string; account: boolean };

const SIGN_OUT = `<button class="btn ghost" type="submit" name="decision" value="sign_out" formnovalidate>Sign Out</button>`;

function sessionFrom(request: Request, approval: LinkApprovalPage): Session | null {
  const secret = approval.sessionSecret();
  const user = readSigned(request, secret, USER_COOKIE);
  // A platform with accounts knows only users its sign-in made.
  if (typeof user?.sub !== "string" || (approval.signIn !== undefined && user.account !== true)) return null;
  return { subject: user.sub, csrf: sign(secret, `csrf\0${user.sub}`), account: approval.signIn !== undefined };
}

// A provider sign-in under way.
type Connect = { session: string; kind: SubscriptionKind; url: string; userCode: string | null };

function connectFrom(request: Request, secret: string): Connect | null {
  const value = readSigned(request, secret, CONNECT_COOKIE);
  if (
    value === null || typeof value.session !== "string" || typeof value.url !== "string"
    || !(PLAN_KINDS as readonly unknown[]).includes(value.kind)
  ) {
    return null;
  }
  return {
    session: value.session,
    kind: value.kind as SubscriptionKind,
    url: value.url,
    userCode: typeof value.code === "string" ? value.code : null,
  };
}

// Send the user to the platform's sign-in, which returns them to `next` (a
// page of this gateway's) by way of /v1/link/session. The state, kept in a
// cookie here, binds the ticket that comes back to this browser, so no one
// can sign a user in as someone else.
function signIn(request: Request, platform: LinkSignIn, secret: string, next: string): Response {
  const state = randomBytes(24).toString("base64url");
  const url = new URL(platform.url());
  url.searchParams.set("state", state);
  url.searchParams.set("next", next);
  const headers = new Headers({ Location: url.toString(), "Cache-Control": "no-store" });
  headers.append("Set-Cookie", signedCookie(request, secret, SIGN_IN_COOKIE, { state }, SIGN_IN_SECONDS));
  return new Response(null, { status: 303, headers });
}

// The platform's sign-in returns here: a fresh ticket for this browser's state
// makes the browser that user's, and the user goes on to `next`.
async function signedIn(approval: LinkApprovalPage, request: Request, params: URLSearchParams): Promise<Response> {
  const secret = approval.sessionSecret();
  const state = readSigned(request, secret, SIGN_IN_COOKIE)?.state;
  const next = params.get("next") ?? "";
  const ticket = params.get("ticket") ?? "";
  const signed = approval.signIn === undefined || typeof state !== "string" || !ticket || !next.startsWith(LINK_ROUTE_PREFIX)
    ? null
    : await approval.signIn.redeem(ticket);
  if (signed === null || signed.state !== state || Date.now() - signed.issuedAt > TICKET_MS) {
    return page("Sign-In Expired", `<div class="body"><h1>Sign-In Expired</h1><p>Open Dari Link from the app again.</p></div>`, { status: 400 });
  }
  const headers = new Headers({ Location: next, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", userCookie(request, approval, signed.subject));
  headers.append("Set-Cookie", clearCookie(request, SIGN_IN_COOKIE));
  return new Response(null, { status: 303, headers });
}

// A signed cookie's payload: `<payload>.<HMAC-SHA256>`, where the payload
// holds the value and when it ends.
function readSigned(request: Request, secret: string, cookie: string): Record<string, unknown> | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === cookie) return readSignedValue(rest.join("="), secret, cookie);
  }
  return null;
}

function readSignedValue(signed: string, secret: string, name: string): Record<string, unknown> | null {
  const [payload, signature] = signed.split(".");
  if (!payload || !signature || !sameText(signature, sign(secret, `${name}\0${payload}`))) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null) return null;
    const exp = (value as { exp?: unknown }).exp;
    return typeof exp === "number" && exp > Date.now() ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function signedValue(secret: string, cookie: string, value: Record<string, unknown>, seconds: number): string {
  const payload = Buffer.from(JSON.stringify({ ...value, exp: Date.now() + seconds * 1000 })).toString("base64url");
  return `${payload}.${sign(secret, `${cookie}\0${payload}`)}`;
}

function signedCookie(request: Request, secret: string, cookie: string, value: Record<string, unknown>, seconds: number): string {
  return `${cookie}=${signedValue(secret, cookie, value, seconds)}; Path=${COOKIE_PATH}; Max-Age=${seconds}; HttpOnly; SameSite=Lax${isHttps(request) ? "; Secure" : ""}`;
}

// Who the user is, from when the page last said so (see USER_COOKIE).
function userCookie(request: Request, approval: LinkApprovalPage, subject: string): string {
  return approval.signIn === undefined
    ? signedCookie(request, approval.sessionSecret(), USER_COOKIE, { sub: subject }, USER_SECONDS)
    : signedCookie(request, approval.sessionSecret(), USER_COOKIE, { sub: subject, account: true }, ACCOUNT_SECONDS);
}

// Signing out leaves nothing of the user's: not who they are, nor a provider
// sign-in under way. A platform with accounts ends its own sign-in too, then
// returns the user to `next`, so the next sign-in can be another account.
function signOut(request: Request, approval: LinkApprovalPage, next: string): Response {
  let location = next;
  if (approval.signIn !== undefined) {
    const url = new URL(approval.signIn.signOutUrl());
    url.searchParams.set("next", next);
    location = url.toString();
  }
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", clearCookie(request, USER_COOKIE));
  headers.append("Set-Cookie", clearCookie(request, CONNECT_COOKIE));
  return new Response(null, { status: 303, headers });
}

function clearCookie(request: Request, cookie: string): string {
  return `${cookie}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${isHttps(request) ? "; Secure" : ""}`;
}

/**
 * The `Cookie` header value that makes a request this user's on the approval
 * page, for a platform's own tooling (the stub gateway approves with it).
 */
export function linkUserCookie(secret: string, subject: string): string {
  return `${USER_COOKIE}=${signedValue(secret, USER_COOKIE, { sub: subject }, USER_SECONDS)}`;
}

function sign(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function sameText(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Return the result to the app: on its redirect URI, or posted to the window
// that opened this page, which only the redirect URI's origin can read.
function redirect(
  back: { redirectUri: string; state: string | null; webMessage: boolean },
  params: Record<string, string>,
  cookies: string[] = [],
): Response {
  if (back.webMessage) {
    const message = { type: LINK_MESSAGE_TYPE, ...params, ...(back.state !== null ? { state: back.state } : {}) };
    const nonce = randomUUID();
    // `<` is escaped so the JSON cannot close the script element.
    // Without an opener (a sign-in can sever it), the result goes to the
    // redirect URI, whose page hands it on with `DariLink.callback()`.
    const json = JSON.stringify([message, new URL(back.redirectUri).origin, queryRedirect(back, params)])
      .replaceAll("<", "\\u003c");
    const connected = "code" in params;
    return page(
      connected ? "Success" : "Returning To The App",
      `<div class="body center">${connected ? `<span class="done">${ICONS.check}</span><h1>Success</h1><p>You are connected.` : `<h1>Returning To The App</h1><p>`} You can close this window.</p></div>
<script nonce="${nonce}">const [message, origin, fallback] = ${json};
if (window.opener) { window.opener.postMessage(message, origin); window.close(); } else { window.location.replace(fallback); }</script>`,
      { cookies, scriptNonce: nonce },
    );
  }
  const headers = new Headers({ Location: queryRedirect(back, params), "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

// The redirect URI with the result in its query.
function queryRedirect(back: { redirectUri: string; state: string | null }, params: Record<string, string>): string {
  const url = new URL(back.redirectUri);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  if (back.state !== null) url.searchParams.set("state", back.state);
  return url.toString();
}

/**
 * The step of approval the user reached, which a popup posts to the window
 * that opened it (`{type: "dari-link-event", version: 1, event, state}`; the
 * result alone is `type: "dari-link"`), so the app can tell where the user
 * left: `connect_subscription` (connecting a plan) or `choose_plans`. A user
 * who denies leaves at `denied`, which the `access_denied` result says.
 */
export type LinkStep = "connect_subscription" | "choose_plans";
type PageEvent = { message: Record<string, string>; origin: string };

function eventFor(authorize: AuthorizeRequest, step: LinkStep): PageEvent | undefined {
  if (!authorize.webMessage) return undefined;
  return {
    message: { type: LINK_EVENT_TYPE, version: "1", event: step, ...(authorize.state !== null ? { state: authorize.state } : {}) },
    origin: new URL(authorize.redirectUri).origin,
  };
}

// How a kind of plan reads on the page, and whose sign-in connects it. A
// `pastedKey` plan connects with a key the user creates there instead.
const KINDS: Record<SubscriptionKind, { name: string; plan: string; at: string; pastedKey?: true }> = {
  anthropic_claude_code: { name: "Claude", plan: "Pro, Max or Ultra plan", at: "Claude" },
  openai_codex: { name: "ChatGPT", plan: "Plus or Pro plan", at: "OpenAI" },
  meta_muse: { name: "Meta Muse", plan: "Muse Code plan", at: "Meta" },
  opencode_go: { name: "OpenCode Go", plan: "Go plan", at: "OpenCode" },
  github_copilot: { name: "GitHub Copilot", plan: "Copilot plan", at: "GitHub" },
  xai_grok: { name: "Grok", plan: "SuperGrok plan", at: "xAI" },
  vercel_token_pass: { name: "Vercel Token Pass", plan: "Token Pass", at: "Vercel", pastedKey: true },
};

// The first page a new user sees: what connecting means, and one button.
function introPage(approval: LinkApprovalPage, authorize: AuthorizeRequest): Response {
  const app = escapeHtml(authorize.app.name);
  const kinds = connectKinds(approval, authorize);
  const keys = keyProviders(approval, authorize);
  if (kinds.length === 0 && keys.length === 0) {
    return page(
      `Connect ${authorize.app.name}`,
      `<div class="body"><h1>Nothing To Connect</h1><p><strong>${app}</strong> asks for a kind of subscription Dari cannot connect here.</p></div>`,
      { event: eventFor(authorize, "connect_subscription") },
    );
  }
  const names = [...kinds.map((kind) => KINDS[kind].name), ...(keys.length > 0 ? ["an API key"] : [])];
  const ways = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0]!;
  return pane(authorize, {
    title: `Connect ${authorize.app.name}`,
    step: "connect_subscription",
    body: `<div class="pair"><span class="tile">${escapeHtml(authorize.app.name.trim().charAt(0).toUpperCase())}</span><span class="join"></span>${DARI_MARK}</div>
<h1 class="lead">${app} Uses Dari To Connect Your AI ${kinds.length > 0 ? "Subscriptions" : "API Keys"}</h1>
<p class="returns">Returns to ${escapeHtml(new URL(authorize.redirectUri).host)}</p>
<ul class="points">
<li>${ICONS.zap}<div><strong>Connect In Seconds</strong><p>${kinds.length > 0 ? `Use what you already pay for: ${escapeHtml(ways)}.` : "Add the API key you already have."}</p></div></li>
<li>${ICONS.shield}<div><strong>You Stay In Control</strong><p>${app} can only send model requests on what you share. It sees each shared plan's account email, never a key or your other plans, and you can disconnect it any time.</p></div></li>
</ul>`,
    footer: `<button class="btn primary" type="submit" name="decision" value="select">Continue</button>`,
  });
}

// What to connect, as a grid of tiles: each kind of plan starts its
// provider's sign-in, and each provider below takes an API key.
function selectPage(approval: LinkApprovalPage, authorize: AuthorizeRequest, error?: string, cookies: string[] = []): Response {
  const plans = connectKinds(approval, authorize).map((kind) =>
    `<button class="option" type="submit" name="connect" value="${kind}" formnovalidate>${logo(kind, KINDS[kind].name)}<span><strong>${KINDS[kind].name}</strong><small>${KINDS[kind].plan}</small></span></button>`);
  const keys = keyProviders(approval, authorize).map((provider) =>
    `<button class="option slim" type="submit" name="key" value="${escapeHtml(provider.id)}" formnovalidate>${logo(provider.id, provider.name)}<strong>${escapeHtml(provider.name)}</strong></button>`);
  return pane(authorize, {
    title: `Connect ${authorize.app.name}`,
    step: "connect_subscription",
    back: "home",
    error,
    cookies,
    body: `<h1>${plans.length === 0 ? "Add An API Key" : keys.length === 0 ? "Select Your Subscription" : "Choose What To Connect"}</h1>
${plans.length > 0 ? `${keys.length > 0 ? `<p class="label">Subscriptions</p>\n` : ""}<div class="grid">\n${plans.join("\n")}\n</div>` : ""}
${keys.length > 0 ? `${plans.length > 0 ? `<p class="label">API Keys</p>\n` : ""}<div class="grid">\n${keys.join("\n")}\n</div>` : ""}`,
  });
}

// One provider's API key, pasted once.
function keyPage(authorize: AuthorizeRequest, provider: LinkKeyProvider, error?: string, cookies: string[] = []): Response {
  const name = escapeHtml(provider.name);
  return pane(authorize, {
    title: `Add Your ${provider.name} API Key`,
    step: "connect_subscription",
    back: "select",
    error,
    cookies,
    body: `<span class="who">${logo(provider.id, provider.name)}</span>
<h1>Add Your ${name} API Key</h1>
<input type="hidden" name="key_provider" value="${escapeHtml(provider.id)}">
<label class="field" for="api_key">API Key</label>
<input id="api_key" type="password" name="api_key" autocomplete="off" spellcheck="false" placeholder="Paste Key" required>
<p class="hint">Dari keeps the key and uses it only for the apps you allow. ${escapeHtml(authorize.app.name)} never sees it.</p>`,
    footer: `<button class="btn primary" type="submit" name="decision" value="add_key">Continue</button>`,
  });
}

// The provider's sign-in: a link to it, and the code to bring back or take
// there; or, for a plan that is a key, where to create the key to paste back.
function providerPage(authorize: AuthorizeRequest, connect: Connect, error?: string): Response {
  const { name, at, pastedKey } = KINDS[connect.kind];
  const open = (style: string) =>
    `<a class="btn ${style}" href="${escapeHtml(connect.url)}" target="_blank" rel="noopener noreferrer">Open ${pastedKey ? at : name}${ICONS.external}</a>`;
  if (pastedKey) {
    return pane(authorize, {
      title: `Add Your ${name} Key`,
      step: "connect_subscription",
      back: "select",
      error,
      body: `<span class="who">${logo(connect.kind, name)}</span>
<h1>Add Your ${name} Key</h1>
<div class="step"><span class="n">1</span><div><p>Create a ${name} key at ${at}.</p>${open("outline")}</div></div>
<div class="step"><span class="n">2</span><div><label for="authorization_response">Paste the key.</label><input id="authorization_response" type="password" name="authorization_response" autocomplete="off" spellcheck="false" placeholder="Paste Key" required></div></div>`,
      footer: `<button class="btn primary" type="submit" name="decision" value="complete">Continue</button>`,
    });
  }
  const head = `<span class="who">${logo(connect.kind, name)}</span>
<h1>Sign In To ${name}</h1>`;
  if (connect.userCode === null) {
    return pane(authorize, {
      title: `Sign In To ${name}`,
      step: "connect_subscription",
      back: "select",
      error,
      body: `${head}
<div class="step"><span class="n">1</span><div><p>Sign in at ${at} and approve.</p>${open("outline")}</div></div>
<div class="step"><span class="n">2</span><div><label for="authorization_response">Paste the code ${at} shows you.</label><input id="authorization_response" type="text" name="authorization_response" autocomplete="off" spellcheck="false" placeholder="Paste Code" required></div></div>`,
      footer: `<button class="btn primary" type="submit" name="decision" value="complete">Continue</button>`,
    });
  }
  return pane(authorize, {
    title: `Sign In To ${name}`,
    step: "connect_subscription",
    back: "select",
    error,
    refresh: DEVICE_POLL_SECONDS,
    body: `${head}
<p>Enter this code at ${at} to approve.</p>
<p class="code">${escapeHtml(connect.userCode)}</p>
<p class="wait"><span class="spin"></span>Waiting for your approval. This window continues on its own.</p>`,
    footer: open("primary"),
  });
}

// The user's plans and keys, ticked: one button shares them with the app.
function choosePage(
  authorize: AuthorizeRequest,
  session: Session,
  subscriptions: LinkSubscription[],
  current: GrantToUpdate | null,
  error?: string,
): Response {
  const app = escapeHtml(authorize.app.name);
  const plans = shareable(authorize, subscriptions);
  // A new connection starts with every plan ticked; an update, with the plans it shares now.
  const ticked = new Set(current?.credentialIds ?? plans.map((plan) => plan.id));
  return pane(authorize, {
    title: current === null ? `Connect ${authorize.app.name}` : `Update Plans For ${authorize.app.name}`,
    step: "choose_plans",
    error,
    body: `<h1>${current === null ? `Share With ${app}` : `Update Plans For ${app}`}</h1>
<input type="hidden" name="csrf" value="${session.csrf}">
<!-- First in the form, so Enter in a limit field allows rather than pressing Connect Another. -->
<button type="submit" name="decision" value="approve" tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px"></button>
${plans.map((plan) => planOption(authorize, plan, ticked.has(plan.id))).join("\n")}
<details${current?.limits.length ? " open" : ""}><summary>Set Limits</summary>
${plans.map((plan) => {
  const set = current?.limits.find((limit) => limit.credentialId === plan.id);
  const label = plan.apiKeyProvider === undefined ? KINDS[plan.provider as SubscriptionKind].name : plan.name;
  return `<div class="limit">${logo(plan.apiKeyProvider ?? plan.provider, label)}<label class="grow" for="limit_${escapeHtml(plan.id)}"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(planLabel(plan))}</small></label>${limitInput(plan, `limit_${escapeHtml(plan.id)}`, label, set?.maxPercent ?? set?.monthlyUsd)}</div>`;
}).join("\n")}
</details>
<div class="actions"><button class="btn ghost" type="submit" name="decision" value="select" formnovalidate>${ICONS.plus}Connect Another</button><span><a class="btn ghost" href="${CONNECTIONS_PATH}" target="_blank" rel="noopener">Manage</a>${session.account ? SIGN_OUT : ""}</span></div>`,
    footer: `<button class="btn primary" type="submit" name="decision" value="approve">${current === null ? "Allow" : "Save"}</button>
<p class="fine">${app} keeps access until you or it disconnect. Its requests fail while a plan is at its usage limit or yours.</p>`,
  });
}

function planOption(authorize: AuthorizeRequest, subscription: LinkSubscription, ticked: boolean): string {
  const box = `<input type="checkbox" name="credential_id" value="${escapeHtml(subscription.id)}"${ticked ? " checked" : ""}>`;
  if (subscription.apiKeyProvider !== undefined) {
    return `<label class="option pick">${logo(subscription.apiKeyProvider, subscription.name)}<span class="grow"><strong>${escapeHtml(subscription.name)}</strong><small>API key &middot; ${escapeHtml(planLabel(subscription))}</small></span>${box}</label>`;
  }
  const kind = subscription.provider as SubscriptionKind;
  const only = subscriptionClient(kind);
  // What the app says it does with the plan, on hover.
  const purpose = authorize.purposes[only === "claude_code" || only === "muse_code" ? only : "any_app"];
  return `<label class="option pick"${purpose === undefined ? "" : ` title="${escapeHtml(purpose)}"`}>${logo(kind, KINDS[kind].name)}<span class="grow"><strong>${KINDS[kind].name}</strong>${meter(subscription, planLabel(subscription))}</span>${box}</label>`;
}

// The plan's account, and how much of its quota it used as the dashboard
// shows it: a bar for its fullest shared window that has not reset, red at
// the limit.
function meter(subscription: LinkSubscription, account: string): string {
  const now = Date.now();
  const held = subscription.unavailableUntil !== null && Date.parse(subscription.unavailableUntil) > now ? subscription.unavailableUntil : null;
  const fullest = subscription.usage
    .filter((window) => window.modelFamily === undefined && Date.parse(window.resetsAt) > now)
    .reduce<LinkUsageWindow | null>((most, window) => most === null || window.utilization > most.utilization ? window : most, null);
  const shown = held !== null
    ? { percent: 100, until: held }
    : fullest === null ? null : { percent: Math.min(100, Math.round(fullest.utilization * 100)), until: fullest.resetsAt };
  if (shown === null) return `<small>${escapeHtml(account)}</small>`;
  const full = shown.percent >= 100;
  return `<span class="meter${full ? " full" : ""}" title="${full ? "Until" : "Resets"} ${escapeHtml(new Date(shown.until).toUTCString())}"><small>${escapeHtml(account)}</small><span class="pct">${full ? "Limit Reached" : `${shown.percent}%`}</span><span class="bar" role="meter" aria-label="Quota Used" aria-valuenow="${shown.percent}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.max(shown.percent, 1)}%"></span></span></span>`;
}

// A provider's mark, or without one the first letter of its name.
function logo(id: string, name: string): string {
  return linkLogo(id) ?? `<span class="logo letter">${escapeHtml(name.trim().charAt(0).toUpperCase())}</span>`;
}

function authorizeFields(authorize: AuthorizeRequest): Record<string, string> {
  return {
    response_type: "code",
    client_id: authorize.app.clientId,
    redirect_uri: authorize.redirectUri,
    code_challenge: authorize.codeChallenge,
    code_challenge_method: "S256",
    ...(authorize.state !== null ? { state: authorize.state } : {}),
    ...(authorize.webMessage ? { response_mode: WEB_MESSAGE } : {}),
    ...(authorize.clients.length > 0 ? { client: authorize.clients.join(" ") } : {}),
    ...(authorize.plans !== null ? { plans: authorize.plans.join(" ") } : {}),
    ...(authorize.keyProviders !== null ? { key_providers: authorize.keyProviders.join(" ") } : {}),
    ...Object.fromEntries(Object.entries(authorize.purposes).map(([audience, purpose]) => [`purpose_${audience}`, purpose])),
    ...(authorize.grantId !== null ? { grant_id: authorize.grantId } : {}),
  };
}

function authorizeQuery(authorize: AuthorizeRequest): string {
  return new URLSearchParams(authorizeFields(authorize)).toString();
}

function hiddenFields(authorize: AuthorizeRequest): string {
  return Object.entries(authorizeFields(authorize))
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join("\n");
}

/**
 * One step of the approval, as a form: its content, the button that moves on,
 * and Back and Close in the header. Back and Close come last in the form, so
 * Enter in a field presses the step's own button.
 */
function pane(
  authorize: AuthorizeRequest,
  options: {
    title: string;
    step: LinkStep;
    body: string;
    footer?: string;
    back?: "home" | "select";
    error?: string;
    cookies?: string[];
    refresh?: number;
  },
): Response {
  return page(
    options.title,
    `<form method="post" action="${AUTHORIZE_PATH}">
${hiddenFields(authorize)}
<div class="body">
${options.body}
${options.error === undefined ? "" : `<p role="alert">${escapeHtml(options.error)}</p>`}
</div>
${options.footer === undefined ? "" : `<div class="foot">${options.footer}</div>`}
${options.back === undefined ? "" : `<button class="nav back" type="submit" name="decision" value="${options.back}" formnovalidate aria-label="Back">${ICONS.back}</button>`}
<button class="nav close" type="submit" name="decision" value="deny" formnovalidate aria-label="Close">${ICONS.close}</button>
</form>`,
    { cookies: options.cookies, event: eventFor(authorize, options.step), refresh: options.refresh },
  );
}

function page(
  title: string,
  body: string,
  options: { status?: number; cookies?: string[]; scriptNonce?: string; event?: PageEvent; refresh?: number } = {},
): Response {
  // Every page: a pressed button shows it is working until the next page loads.
  const busyNonce = options.scriptNonce ?? randomUUID();
  body += `\n<script nonce="${busyNonce}">document.addEventListener("submit", (event) => {
  const button = event.submitter;
  if (!(button instanceof HTMLButtonElement) || button.form?.target) return;
  setTimeout(() => { button.disabled = true; button.setAttribute("aria-busy", "true"); button.prepend(Object.assign(document.createElement("span"), { className: "spin" })); });
});</script>`;
  options = { ...options, scriptNonce: busyNonce };
  if (options.event !== undefined) {
    const nonce = options.scriptNonce ?? randomUUID();
    // `<` is escaped so the JSON cannot close the script element.
    const json = JSON.stringify([options.event.message, options.event.origin]).replaceAll("<", "\\u003c");
    body += `\n<script nonce="${nonce}">const [event, eventOrigin] = ${json};
if (window.opener) window.opener.postMessage(event, eventOrigin);</script>`;
    options = { ...options, scriptNonce: nonce };
  }
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${options.refresh === undefined ? "" : `<meta http-equiv="refresh" content="${options.refresh}">\n`}<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head><body><main><section><header>${DARI_MARK}</header>
${body}
</section></main></body></html>`;
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; ${options.scriptNonce ? `script-src 'nonce-${options.scriptNonce}'; ` : ""}frame-ancestors 'none'`,
    "X-Frame-Options": "DENY",
    // No other site sees these pages' URLs. Not no-referrer: under it a form
    // posts Origin: null, which an http gateway (sent no Sec-Fetch-Site) refuses.
    "Referrer-Policy": "same-origin",
  });
  for (const cookie of options.cookies ?? []) headers.append("Set-Cookie", cookie);
  return new Response(html, { status: options.status ?? 200, headers });
}

// Dari's look, by its own tokens: a charcoal sheet set in Geist, ink for the
// one main button, hairline rules, rounded controls, and mint only for focus
// and success. In a popup the sheet is the window; in a wider tab it is a
// dialog on the page. One step shows at a time, its button at the bottom.
const PAGE_STYLE = `@font-face{font-family:Geist;src:url(${FONT_PATH}) format("woff2");font-weight:100 900;font-display:swap}
:root{color-scheme:dark;--page:#141415;--card:#19191a;--ink:#ededed;--muted:#b9b9bd;--faint:#808087;--rule:#303031;--edge:#404041;--mint:#8ee6bd;--hover:rgba(237,237,237,.05)}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--card);color:var(--ink);font:450 14px/1.5 Geist,ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
main{min-height:100%;display:flex}
section{position:relative;flex:1;display:flex;flex-direction:column;background:var(--card);min-width:0}
@media (min-width:560px){body{background:var(--page)}main{align-items:center;justify-content:center;padding:24px}
section{flex:none;width:400px;min-height:620px;border:1px solid var(--rule);border-radius:8px;box-shadow:0 25px 50px -12px rgba(0,0,0,.5);overflow:hidden}}
header{flex:none;height:52px;display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--rule)}
.mark{width:24px;height:24px}
form{flex:1;display:flex;flex-direction:column;min-height:0}
.body{flex:1;padding:28px 24px 16px}
.foot{flex:none;padding:8px 24px 24px}
.center{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding-bottom:64px}
h1{font-size:20px;font-weight:550;letter-spacing:-.02em;line-height:1.3;margin:0 0 20px}
p{color:var(--muted);margin:0 0 16px}strong{color:var(--ink);font-weight:550}
small{display:block;color:var(--faint);font-size:12px;line-height:1.4;overflow-wrap:anywhere}
.icon{flex:none;width:16px;height:16px}.logo{flex:none;width:20px;height:20px;color:var(--ink)}
.letter{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--edge);border-radius:4px;font-size:12px;font-weight:550}
.pair{display:flex;align-items:center;justify-content:center;gap:12px;margin:20px 0 28px}
.pair .mark{width:48px;height:48px}
.tile{display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border:1px solid var(--edge);border-radius:6px;background:var(--page);font-size:20px;font-weight:550}
.join{width:28px;border-top:1px dashed var(--edge)}
.lead{text-align:center;margin-bottom:28px}
.returns{text-align:center;color:var(--faint);font-size:12px;margin:-20px 0 24px}
.points{list-style:none;margin:0;padding:0;border-top:1px solid var(--rule)}
.points li{display:flex;gap:12px;padding:16px 0;border-bottom:1px solid var(--rule)}
.points .icon{margin-top:3px;color:var(--faint)}.points p{margin:2px 0 0;font-size:13px}
.label{color:var(--faint);font-size:12px;margin:20px 0 8px}h1+.label{margin-top:0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.option{display:flex;flex-direction:column;align-items:flex-start;gap:12px;min-width:0;padding:14px 12px 12px;border:1px solid var(--rule);border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:border-color .15s,background-color .15s}
.option:hover,.option:has(input:checked){border-color:rgba(237,237,237,.4);background:var(--hover)}
.option strong{display:block;font-size:14px;line-height:1.35}
.option.slim{flex-direction:row;align-items:center;gap:10px;padding:10px 12px}.slim .logo{width:16px;height:16px}.slim strong{font-size:13px}
.option.pick{flex-direction:row;align-items:center;margin:0 0 8px;padding:12px}.grow{flex:1;min-width:0}
input[type=checkbox]{appearance:none;-webkit-appearance:none;flex:none;display:grid;place-content:center;width:20px;height:20px;margin:0 0 0 4px;border:1.5px solid rgba(237,237,237,.25);border-radius:50%;background:transparent;cursor:pointer;transition:background-color .15s,border-color .15s}
input[type=checkbox]:checked{border-color:var(--ink);background:var(--ink)}
input[type=checkbox]:checked::after{content:"";width:9px;height:5px;margin-top:-2px;border:solid var(--card);border-width:0 0 2px 2px;transform:rotate(-45deg)}
.who{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;margin:0 0 16px;border:1px solid var(--rule);border-radius:6px;background:var(--page)}
.step{display:flex;gap:12px;margin:0 0 20px}.step>div{flex:1;min-width:0}.step p,.step label{display:block;color:var(--muted);margin:0 0 10px}
.n{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:4px;background:rgba(237,237,237,.07);color:var(--muted);font-size:12px}
.field{display:block;font-size:13px;font-weight:550;margin:0 0 8px}
input[type=text],input[type=password]{display:block;width:100%;height:36px;padding:0 12px;border:1px solid var(--edge);border-radius:6px;background:var(--page);color:var(--ink);font:13px "Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
input::placeholder{color:var(--faint);font-family:Geist,ui-sans-serif,system-ui,sans-serif}
input[type=text]:focus-visible,input[type=password]:focus-visible{outline:1px solid var(--mint);border-color:var(--mint)}
.hint{color:var(--faint);font-size:12px;margin:10px 0 0}
.code{margin:0 0 16px;padding:18px 12px;border:1px solid var(--rule);border-radius:8px;background:rgba(237,237,237,.03);color:var(--ink);font:550 20px "Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;text-align:center;user-select:all}
.wait{display:flex;align-items:center;gap:10px;font-size:13px}
.spin{flex:none;width:14px;height:14px;border:2px solid var(--edge);border-top-color:var(--ink);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:36px;padding:0 16px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--ink);font:550 14px Geist,ui-sans-serif,system-ui,sans-serif;text-decoration:none;white-space:nowrap;cursor:pointer;transition:background-color .15s,border-color .15s}
.btn.primary{width:100%;height:44px;font-size:15px;border-color:var(--ink);background:var(--ink);color:var(--page)}.btn.primary:hover{background:rgba(237,237,237,.9)}
.btn.danger{width:100%;height:44px;font-size:15px;border-color:#d64548;background:#d64548;color:#fafafa}.btn.danger:hover{background:rgba(214,69,72,.9)}
.nav.drop{position:static;flex:none;width:28px;height:28px;margin:0 -4px 0 0;color:var(--faint)}
.btn.outline{border-color:var(--edge)}.btn.outline:hover{border-color:rgba(237,237,237,.4);background:var(--hover)}
.btn.ghost{height:32px;margin:4px 0 0 -8px;padding:0 10px 0 8px;font-size:13px;color:var(--muted)}.btn.ghost:hover{background:rgba(237,237,237,.06);color:var(--ink)}
.meter{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 8px}.meter small{flex:1;min-width:0}
.pct{flex:none;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}.full .pct{color:#e5484d}
.bar{flex:0 0 100%;height:4px;margin:8px 0 2px;border-radius:999px;background:rgba(237,237,237,.08);overflow:hidden}.bar>span{display:block;height:100%;border-radius:999px;background:var(--mint)}.full .bar>span{background:#d64548}
.actions{display:flex;justify-content:space-between;margin:4px -8px 0}.actions .btn.ghost{margin:0}.actions span{display:flex}
.fine{color:var(--faint);font-size:12px;margin:12px 0 0;text-align:center}
.card:has(details[open]) .logos{display:none}
.logos{display:flex;gap:8px;margin:8px 0 0}.logos .logo,.limit .logo{width:16px;height:16px}
.limit{display:flex;align-items:center;gap:10px;margin:10px 0 0}.limit small{display:block}.limit input{width:110px;margin:0}
details{margin:12px 0 0}summary{cursor:pointer;list-style:none;display:inline-block;font-size:13px;color:var(--faint);text-decoration:underline;text-underline-offset:3px}summary::-webkit-details-marker{display:none}summary:hover{color:inherit}details[open] summary{display:none}details .btn{margin:12px 0 0}
.card{display:block;margin:0 0 12px;padding:14px 12px;border:1px solid var(--rule);border-radius:6px}.card>small{margin:2px 0 0}.card .field{margin:16px 0 8px}
.row{display:flex;gap:8px;margin:16px 0 0}.row .btn{flex:1}
.nav{position:absolute;top:10px;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--muted);cursor:pointer}
.nav:hover{background:rgba(237,237,237,.06);color:var(--ink)}.back{left:12px}.close{right:12px}
.done{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;margin:0 0 20px;border:1px solid rgba(142,230,189,.4);border-radius:6px;background:rgba(142,230,189,.1);color:var(--mint)}.done .icon{width:22px;height:22px}
a:focus-visible,button:focus-visible,input[type=checkbox]:focus-visible{outline:1px solid var(--mint);outline-offset:1px}
[role=alert]{margin:16px 0 24px;padding:10px 12px;border:1px solid rgba(214,69,72,.5);border-radius:6px;background:rgba(214,69,72,.1);color:var(--ink);font-size:13px}
::selection{background:var(--mint);color:var(--page)}`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Endpoints browser apps call from their own origin. None reads cookies or
 * other ambient credentials (the verifier, refresh token, or bearer token is
 * the credential), so any origin may call them.
 */
const CORS_PATHS = new Set([
  "/v1/link/token",
  "/v1/link/register",
  "/v1/link/revoke",
  "/v1/link/grant",
  "/v1/link/usage",
  LINK_METADATA_PATH,
]);

function withCors(response: Response): Response {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.headers.set("Access-Control-Max-Age", "600");
  return response;
}

/**
 * Served at /v1/link/callback.js for the redirect URI's page, which a strict
 * CSP may keep from bundling `DariLink.callback()`: when the page's query holds
 * a Dari Link result (`state` with `code`, or `error`), it posts
 * `{type: "dari-link", state, code}` or `{type: "dari-link", state, error,
 * error_description}` on the `dari-link` BroadcastChannel, where the window
 * that called `DariLink.open` listens, and closes the popup. Both the channel
 * name and the message shape are stable.
 */
const CALLBACK_SCRIPT = `(function () {
  var params = new URLSearchParams(window.location.search);
  var state = params.get("state");
  var code = params.get("code");
  var error = params.get("error");
  if (state === null || (code === null && error === null) || typeof BroadcastChannel === "undefined") return;
  var message = code !== null
    ? { type: "dari-link", state: state, code: code }
    : { type: "dari-link", state: state, error: error, error_description: params.get("error_description") || undefined };
  var channel = new BroadcastChannel("dari-link");
  channel.postMessage(message);
  channel.close();
  window.close();
})();
`;
