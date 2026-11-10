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
import { isHeld, type SubscriptionCredential, type SubscriptionStore } from "./store.js";

export type SubscriptionHttpDeps = {
  store: SubscriptionStore;
  fetch: OAuthFetch;
  now?: () => Date;
};

const BASE = "/v1/organizations/current/credentials";
// Subscription names are env-var-style, which keeps other credential routes
// such as `provider-credentials/...` out of these matches.
const NAMED = /^\/([A-Za-z_][A-Za-z0-9_]*)(\/label|\/mark-available|\/auto-reset)?$/;

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
    if (path === "" && request.method === "GET") return json(200, listBody(deps.store, now));
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
    if (action === "/mark-available" && request.method === "POST") {
      return json(200, summary(deps.store, found(deps.store.markAvailable(name, now), name), now));
    }
    if (action === "/auto-reset" && request.method === "POST") {
      throw new HttpError(400, "Spending banked Codex resets is not supported by this gateway.");
    }
    return null;
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { detail: error.message });
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
  if (credentialName !== null && deps.store.getByName(credentialName)?.provider !== provider) {
    throw new HttpError(404, `Unknown subscription credential ${JSON.stringify(credentialName)}.`);
  }
  const authorization = await startOAuth(provider as SubscriptionProvider, { fetch: deps.fetch, now });
  const session = deps.store.createSession(
    {
      provider: provider as SubscriptionProvider,
      flow: authorization.flow,
      credentialName,
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
  const stored = deps.store.connect(tokens, session.credentialName, now);
  if (stored === null) {
    throw new HttpError(404, `Unknown subscription credential ${JSON.stringify(session.credentialName)}.`);
  }
  return summary(deps.store, stored, now);
}

function summary(store: SubscriptionStore, credential: SubscriptionCredential, now: Date) {
  return credentialBody(credential, store.activeCredential(credential.provider, now)?.id === credential.id, now);
}

/** The fields the CLI reads from a credential, never its tokens. */
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
    created_at: credential.createdAt.toISOString(),
    last_used_at: credential.lastUsedAt?.toISOString() ?? null,
    unavailable_until: held ? credential.unavailableUntil!.toISOString() : null,
    unavailable_reason: held ? credential.unavailableReason : null,
    subscription_active: active,
    // Spending banked Codex resets is hosted-only.
    auto_redeem_resets: false,
  };
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
