/**
 * The subscription endpoints the Dari CLI calls, with the same paths and JSON
 * shapes as the hosted API. The gateway is single-tenant: `current` is the
 * only organization, and every caller that passes the gateway's own auth owns
 * every subscription. Errors are `{"detail": "..."}`, which the CLI prints.
 */
import {
  SUBSCRIPTION_PROVIDERS,
  SubscriptionOAuthInputError,
  SubscriptionOAuthProviderError,
  completeOAuth,
  startOAuth,
  type OAuthFetch,
  type SubscriptionProvider,
} from "./oauth.js";
import { canonicalModelName } from "../../models/canonical.js";
import type { SubscriptionUsageWindow } from "../../providers/subscription_limits.js";
import {
  activeModelHolds,
  currentUsage,
  isHeld,
  sameConnectedAccount,
  SubscriptionAccountConnectedError,
  type ConnectedAccount,
  type SubscriptionCredential,
  type SubscriptionStore,
} from "./store.js";
import { hasBankedResets, listResets, useReset, type ProviderBaseUrls } from "./resets.js";
import { refreshStaleUsage } from "./usage.js";

export type SubscriptionHttpDeps = {
  store: SubscriptionStore;
  fetch: OAuthFetch;
  // Where Claude and ChatGPT are reached for usage and banked resets.
  baseUrls?: ProviderBaseUrls;
  now?: () => Date;
  // The user's plans hosted Dari holds (on Dari and on other computers), read
  // before a sign-in connects a new account. Set when this gateway is
  // connected to hosted Dari.
  hostedAccounts?: () => Promise<ConnectedAccount[]>;
};

const BASE = "/v1/organizations/current/credentials";
// Subscription names are env-var-style, which keeps other credential routes
// such as `provider-credentials/...` out of these matches.
const NAMED = /^\/([A-Za-z_][A-Za-z0-9_]*)(\/label|\/mark-available|\/private|\/resets|\/resets\/[^/]+\/use)?$/;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Handle a subscription route, or return null when the request is not one. */
export async function handleSubscriptionRequest(
  request: Request,
  deps: SubscriptionHttpDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return null;
  const path = url.pathname.slice(BASE.length);
  const now = deps.now?.() ?? new Date();
  try {
    if (path === "" && request.method === "GET") {
      // Plans whose usage is read only when asked, or idle since their last response.
      if (url.searchParams.get("refresh_usage") === "true") {
        await refreshStaleUsage(deps.store, { fetch: deps.fetch, now, ...(deps.baseUrls ? { baseUrls: deps.baseUrls } : {}) });
      }
      return json(200, listBody(deps.store, now));
    }
    if (path === "/oauth/sessions" && request.method === "POST") {
      return json(201, await startSession(deps, await readBody(request), now));
    }
    if (path === "/oauth/sessions/complete" && request.method === "POST") {
      return json(200, await completeSession(deps, await readBody(request), now));
    }
    const named = NAMED.exec(path);
    if (named === null) return null;
    const name = named[1]!;
    const action = named[2];
    if (action === undefined && request.method === "DELETE") {
      // The hosted API requires `scope=user` so an old client deleting an
      // organization secret by name never disconnects a subscription.
      if (url.searchParams.get("scope") !== "user") throw new HttpError(400, "scope=user is required.");
      const removed = deps.store.disconnect(name);
      return json(200, credentialBody(found(removed, name), false, now));
    }
    if (action === "/label" && request.method === "PUT") {
      const body = await readBody(request);
      const label = body.label ?? null;
      if (label !== null && typeof label !== "string") throw new HttpError(400, "label must be a string.");
      let renamed: SubscriptionCredential | null;
      try {
        renamed = deps.store.rename(name, label, now);
      } catch (error) {
        if (error instanceof RangeError) throw new HttpError(400, error.message);
        throw error;
      }
      return json(200, summary(deps.store, found(renamed, name), now));
    }
    if (action === "/private" && request.method === "PUT") {
      // Private plans stay off hosted Dari: a connected gateway neither
      // serves nor reports them.
      const body = await readBody(request);
      if (typeof body.private !== "boolean") throw new HttpError(400, "private must be true or false.");
      return json(200, summary(deps.store, found(deps.store.setPrivate(name, body.private, now), name), now));
    }
    if (action === "/mark-available" && request.method === "POST") {
      return json(200, summary(deps.store, found(deps.store.markAvailable(name, now), name), now));
    }
    if (action === "/resets" && request.method === "GET") {
      const credential = resettable(found(deps.store.getByName(name), name));
      const resets = await fromProvider(() => listResets({ ...deps, now }, credential));
      return json(200, {
        resets: resets.map((reset) => ({
          id: reset.id,
          label: reset.label,
          expires_at: reset.expiresAt?.toISOString() ?? null,
          usable: reset.usable,
        })),
        // Always read live here; hosted Dari may show an earlier list.
        read_at: null,
      });
    }
    if (action?.startsWith("/resets/") && request.method === "POST") {
      const credential = resettable(found(deps.store.getByName(name), name));
      const resetId = decodeURIComponent(action.slice("/resets/".length, -"/use".length));
      return json(200, { result: await fromProvider(() => useReset({ ...deps, now }, credential, resetId)) });
    }
    return null;
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { detail: error.message });
    if (error instanceof SubscriptionAccountConnectedError) return json(409, { detail: error.message });
    if (error instanceof SubscriptionOAuthInputError) return json(400, { detail: error.message });
    if (error instanceof SubscriptionOAuthProviderError) return json(502, { detail: error.message });
    throw error;
  }
}

function listBody(store: SubscriptionStore, now: Date) {
  const active = new Set(
    SUBSCRIPTION_PROVIDERS.map((provider) => store.activeCredential(provider, now)?.id),
  );
  return {
    credentials: store.list().map((credential) => credentialBody(credential, active.has(credential.id), now)),
    // Plan gating is hosted-only; a self-hosted gateway always allows routing.
    autorouting_allowed: true,
  };
}

async function startSession(deps: SubscriptionHttpDeps, body: Record<string, unknown>, now: Date) {
  const provider = body.provider;
  if (typeof provider !== "string" || !SUBSCRIPTION_PROVIDERS.includes(provider as SubscriptionProvider)) {
    throw new HttpError(400, `provider must be one of: ${SUBSCRIPTION_PROVIDERS.join(", ")}.`);
  }
  const credentialName = body.credential_name ?? null;
  if (credentialName !== null && (typeof credentialName !== "string" || !credentialName.trim())) {
    throw new HttpError(400, "credential_name must be a non-empty string.");
  }
  const reconnecting = credentialName === null ? null : deps.store.getByName(credentialName);
  if (credentialName !== null && reconnecting?.provider !== provider) {
    throw new HttpError(404, `Unknown subscription credential ${JSON.stringify(credentialName)}.`);
  }
  // A reconnected plan stays where it was unless the caller says otherwise.
  const isPrivate = body.private ?? reconnecting?.private ?? false;
  if (typeof isPrivate !== "boolean") throw new HttpError(400, "private must be true or false.");
  // `dari accounts subscription move` names the hosted plan it moves here.
  const movingFrom = body.moving_from ?? null;
  if (movingFrom !== null && (typeof movingFrom !== "string" || !movingFrom.trim())) {
    throw new HttpError(400, "moving_from must be a non-empty string.");
  }
  const authorization = await startOAuth(provider as SubscriptionProvider, { fetch: deps.fetch, now });
  const session = deps.store.createSession(
    {
      provider: provider as SubscriptionProvider,
      flow: authorization.flow,
      credentialName,
      owner: null,
      private: isPrivate,
      movingFrom,
      expiresAt: authorization.expiresAt,
    },
    now,
  );
  return {
    provider,
    session_token: session.token,
    authorization_url: authorization.authorizationUrl,
    expires_at: authorization.expiresAt.toISOString(),
    user_code: authorization.userCode,
  };
}

async function completeSession(deps: SubscriptionHttpDeps, body: Record<string, unknown>, now: Date) {
  const token = body.session_token;
  const authorizationResponse = body.authorization_response ?? "";
  if (typeof token !== "string" || !token || typeof authorizationResponse !== "string") {
    throw new HttpError(400, "session_token and authorization_response must be strings.");
  }
  const session = deps.store.getSession(token);
  if (session === null) throw new HttpError(400, "Invalid subscription authorization session.");
  if (session.expiresAt <= now) {
    deps.store.deleteSession(token);
    throw new HttpError(400, "Subscription authorization session has expired. Start again.");
  }
  // A pending device approval keeps the session so the CLI can retry.
  const tokens = await completeOAuth(session.provider, session.flow, authorizationResponse, {
    fetch: deps.fetch,
    now,
  });
  deps.store.deleteSession(token);
  // Reconnecting a plan to the account it already holds needs no check, so it
  // works even when hosted Dari cannot be read.
  const target = session.credentialName === null ? null : deps.store.getByName(session.credentialName);
  const reconnectsSameAccount = target !== null && sameConnectedAccount(target, tokens);
  let elsewhere: ConnectedAccount[] = [];
  if (deps.hostedAccounts !== undefined && !reconnectsSameAccount) {
    try {
      elsewhere = (await deps.hostedAccounts()).filter((account) =>
        !(account.place === "dari" && account.name === session.movingFrom));
    } catch (error) {
      // The provider code is spent: keep the sign-in, checked against this
      // gateway's own plans only, rather than make the user start over.
      console.error("hosted account check failed", error instanceof Error ? error.message : String(error));
    }
  }
  const stored = deps.store.connect(tokens, session.credentialName, now, null, session.private, elsewhere);
  if (stored === null) {
    throw new HttpError(404, `Unknown subscription credential ${JSON.stringify(session.credentialName)}.`);
  }
  return summary(deps.store, stored, now);
}

function summary(store: SubscriptionStore, credential: SubscriptionCredential, now: Date) {
  return credentialBody(credential, store.activeCredential(credential.provider, now)?.id === credential.id, now);
}

const FIVE_HOURS = 5 * 60;
const ONE_WEEK = 7 * 24 * 60;
const ONE_MONTH = 30 * 24 * 60;

// A model family's own window is named for the family's catalog models.
const MODEL_FAMILY_NAMES = { fable: "Claude Fable" } as const;

/** What to call a window: 5 Hour, Weekly, Monthly, Claude Fable Weekly. */
function usageWindowLabel(window: SubscriptionUsageWindow): string {
  const minutes = window.minutes;
  const length = minutes === ONE_WEEK ? "Weekly"
    : minutes === ONE_MONTH ? "Monthly"
    : minutes % (24 * 60) === 0 ? `${minutes / (24 * 60)} Day`
    : minutes % 60 === 0 ? `${minutes / 60} Hour`
    : `${minutes} Minute`;
  return window.modelFamily === undefined ? length : `${MODEL_FAMILY_NAMES[window.modelFamily]} ${length}`;
}

/**
 * The usage to show, as the hosted API shows it: every running window, a
 * held plan's window full. A hold ends when the window that ran out resets,
 * so the shared window resetting with it shows full. Usage reported without
 * per-window detail, and holds without a matching window, are named by how
 * far off their reset is: only a weekly or monthly window resets more than
 * five hours out, and only OpenCode Go's monthly one more than a week.
 */
function usageBody(credential: SubscriptionCredential, now: Date) {
  const inferred = (resetsAt: Date) => {
    const left = resetsAt.getTime() - now.getTime();
    if (left > ONE_WEEK * 60_000) return ONE_MONTH;
    return left > FIVE_HOURS * 60_000 ? ONE_WEEK : FIVE_HOURS;
  };
  const usage = currentUsage(credential, now);
  let windows: SubscriptionUsageWindow[] = usage === null ? []
    : usage.windows.length > 0 ? usage.windows
    : [{ minutes: inferred(usage.resetsAt), utilization: usage.utilization, resetsAt: usage.resetsAt }];
  if (isHeld(credential, now)) {
    const held = credential.unavailableUntil!;
    const gap = (window: SubscriptionUsageWindow) => Math.abs(window.resetsAt.getTime() - held.getTime());
    // The hold is the plan's; it never fills a model family's window.
    const closest = windows.filter((window) => window.modelFamily === undefined)
      .reduce<SubscriptionUsageWindow | null>((best, window) => best === null || gap(window) < gap(best) ? window : best, null);
    const minutes = closest !== null && gap(closest) < 15 * 60_000 ? closest.minutes : inferred(held);
    windows = [
      ...windows.filter((window) => window.modelFamily !== undefined || window.minutes !== minutes),
      { minutes, utilization: 1, resetsAt: held },
    ].sort((a, b) => a.minutes - b.minutes || (a.modelFamily ?? "").localeCompare(b.modelFamily ?? ""));
  }
  if (windows.length === 0) return null;
  return {
    utilization: usage?.utilization ?? 1,
    resets_at: (usage?.resetsAt ?? windows[0]!.resetsAt).toISOString(),
    windows: windows.map((window) => ({
      label: usageWindowLabel(window),
      ...(window.modelFamily === undefined ? {} : { model_family: window.modelFamily }),
      minutes: window.minutes,
      utilization: window.utilization,
      resets_at: window.resetsAt.toISOString(),
    })),
  };
}

function credentialBody(credential: SubscriptionCredential, active: boolean, now: Date) {
  const held = isHeld(credential, now);
  return {
    id: credential.id,
    name: credential.name,
    label: credential.label,
    safe_metadata: credential.accountEmail === null ? {} : { account_email: credential.accountEmail },
    // Hosted organizations also hold organization-scoped secrets; every
    // subscription here belongs to the gateway's one user.
    credential_scope: "user",
    oauth_provider: credential.provider,
    // Kept off hosted Dari (`dari accounts subscription connect --on private`).
    private: credential.private,
    created_at: credential.createdAt.toISOString(),
    last_used_at: credential.lastUsedAt?.toISOString() ?? null,
    unavailable_until: held ? credential.unavailableUntil!.toISOString() : null,
    unavailable_reason: held ? credential.unavailableReason : null,
    // Models at their own usage limit; the plan still serves the others.
    model_holds: activeModelHolds(credential, now).map((hold) => ({
      model: hold.model,
      display_name: canonicalModelName(hold.model),
      unavailable_until: hold.until.toISOString(),
      reason: hold.reason,
    })),
    subscription_active: active,
    // The share of its tightest window the plan last reported used, and
    // every window as shown; null when it reports none and is not held.
    usage: usageBody(credential, now),
  };
}

function resettable(credential: SubscriptionCredential): SubscriptionCredential {
  if (!hasBankedResets(credential)) throw new HttpError(400, "Only ChatGPT and Claude Code plans have banked resets.");
  return credential;
}

// A provider that fails to answer is a bad gateway, as on hosted Dari.
async function fromProvider<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, error instanceof Error ? error.message : String(error));
  }
}

function found(credential: SubscriptionCredential | null, name: string): SubscriptionCredential {
  if (credential === null) throw new HttpError(404, `Unknown subscription credential ${JSON.stringify(name)}.`);
  return credential;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}
