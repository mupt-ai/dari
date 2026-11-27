/* Dari Link on the self-hosted gateway: users are subjects the approval page
   remembers in a signed cookie, their plans are the gateway's own subscription
   store and the API keys they add, and a gateway key manages every grant. */

import { randomBytes, randomUUID } from "node:crypto";

import { HttpError } from "../http/errors.js";
import type { LinkPlatform, LinkSubscription } from "../platform/platform.js";
import { checkProviderKey } from "../providers/key_check.js";
import { gatewayKeyIndex, type SelfHostedResolverDeps } from "../self_host/resolve.js";
import {
  CODEX_APPROVAL_PENDING,
  META_APPROVAL_PENDING,
  OPENCODE_APPROVAL_PENDING,
  XAI_APPROVAL_PENDING,
  SUBSCRIPTION_PROVIDERS,
  SubscriptionAccountConnectedError,
  SubscriptionOAuthInputError,
  SubscriptionOAuthProviderError,
  completeOAuth,
  currentUsage,
  startOAuth,
  type SubscriptionCredential,
} from "../self_host/subscriptions/index.js";
import { linkCompleteThrough } from "./in_flight.js";
import { LINK_KEY_PROVIDERS, linkKeyProviderName } from "./key_providers.js";
import { linkPlatform } from "./service.js";
import type { LinkApiKey } from "./sqlite_store.js";

// A user of the approval page connects their own plans there, which serve
// only the grants they approve; a gateway key manages every grant, and apps
// register with one or openly.
export function selfHostedLink(
  deps: Pick<SelfHostedResolverDeps, "gatewayKeys" | "subscriptions" | "links" | "env" | "config" | "fetch">,
): LinkPlatform {
  // A provider the operator points at its own endpoint takes users' keys only
  // when that endpoint takes a key too: one without (a proxy that adds its own
  // credential) would serve anyone's "key" on the operator's account.
  const keyProviders = LINK_KEY_PROVIDERS.filter((provider) => {
    const endpoint = deps.config.providers[provider.id];
    return endpoint === undefined || endpoint.apiKeyEnv !== undefined;
  });
  const requireGatewayKey = (apiKey: string) => {
    if (gatewayKeyIndex(deps.gatewayKeys, apiKey) === null) {
      throw new HttpError(401, "Missing or invalid gateway key.", "authentication_error");
    }
  };
  // The cookie that remembers an approval page's user is signed with
  // DARI_LINK_SESSION_SECRET; without it a process signs with a secret of its
  // own, and a restart forgets who connected which plans.
  const sessionSecret = deps.env.DARI_LINK_SESSION_SECRET?.trim() || randomBytes(32).toString("base64url");
  // Other people's subscriptions and keys are taken only by a gateway that
  // encrypts what it stores.
  const requireEncryption = () => {
    if (!deps.subscriptions.encrypted) {
      throw new HttpError(
        503,
        "This gateway cannot keep subscriptions safely yet. Its operator must set DARI_GATEWAY_ENCRYPTION_KEY.",
        "link_not_configured",
      );
    }
  };
  const newSubject = () => `lu_${randomUUID().replaceAll("-", "")}`;
  return linkPlatform(deps.links, {
    httpRedirectHosts: deps.config.link?.allowHttpRedirectHosts ?? [],
    // A self-hosted gateway's operator owns its apps; registration stays open.
    openRegistration: true,
    sessionSecret: () => sessionSecret,
    connectable: SUBSCRIPTION_PROVIDERS,
    keyProviders,
    async registerApp(app, apiKey) {
      if (apiKey !== undefined) requireGatewayKey(apiKey);
      deps.links.addApp(app);
    },
    async manager(apiKey) {
      requireGatewayKey(apiKey);
      return null;
    },
    completeThrough: (grantId) => linkCompleteThrough(grantId).toISOString(),
    async plans(subject) {
      return [...deps.subscriptions.owned(subject).map(linkSubscription), ...deps.links.keys(subject).map(linkKey)];
    },
    async plansWithIds(ids) {
      const wanted = new Set(ids);
      return [
        ...deps.subscriptions.withIds(wanted).map(linkSubscription),
        ...deps.links.keysWithIds(wanted).map(linkKey),
      ];
    },
    async addKey(subject, provider, apiKey) {
      requireEncryption();
      const name = keyProviders.find((candidate) => candidate.id === provider)!.name;
      const check = await checkProviderKey({
        provider,
        key: apiKey,
        ...(deps.config.providers[provider] ? { endpoint: deps.config.providers[provider] } : {}),
        fetch: deps.fetch as typeof fetch,
      });
      if (check.result === "rejected") {
        throw new HttpError(400, `${name} did not accept that key. Check it and try again.`, "invalid_request");
      }
      const owner = subject ?? newSubject();
      return { subject: owner, credentialId: deps.links.addKey(owner, provider, apiKey).id };
    },
    async startConnect(kind) {
      requireEncryption();
      let authorization;
      try {
        authorization = await startOAuth(kind, { fetch: deps.fetch });
      } catch (error) {
        if (error instanceof SubscriptionOAuthProviderError) {
          throw new HttpError(502, "The provider did not start a sign-in.", "provider_error");
        }
        throw error;
      }
      // A Link sign-in's owner is set; one with none is the gateway owner's.
      // A user without one yet becomes this subject when it completes.
      const session = deps.subscriptions.createSession({
        provider: kind,
        flow: authorization.flow,
        credentialName: null,
        owner: newSubject(),
        movingFrom: null,
        expiresAt: authorization.expiresAt,
      });
      return { session: session.token, authorizationUrl: authorization.authorizationUrl, userCode: authorization.userCode };
    },
    async completeConnect(subject, token, authorizationResponse) {
      const session = deps.subscriptions.getSession(token);
      if (session === null || session.owner === null || session.expiresAt <= new Date()) {
        throw new HttpError(400, "That sign-in ended. Start again.", "invalid_request");
      }
      let tokens;
      try {
        tokens = await completeOAuth(session.provider, session.flow, authorizationResponse, { fetch: deps.fetch });
      } catch (error) {
        if (error instanceof SubscriptionOAuthInputError) {
          if ([
            CODEX_APPROVAL_PENDING,
            META_APPROVAL_PENDING,
            OPENCODE_APPROVAL_PENDING,
            XAI_APPROVAL_PENDING,
          ].includes(error.message)) return null;
          throw new HttpError(400, error.message, "invalid_request");
        }
        if (error instanceof SubscriptionOAuthProviderError) {
          throw new HttpError(400, "The provider did not accept that sign-in. Try again.", "invalid_request");
        }
        throw error;
      }
      const owner = subject ?? session.owner;
      let credentialId: string;
      try {
        credentialId = deps.subscriptions.connect(tokens, null, new Date(), owner)!.id;
      } catch (error) {
        if (error instanceof SubscriptionAccountConnectedError) throw new HttpError(409, error.message, "conflict_error");
        throw error;
      }
      deps.subscriptions.deleteSession(token);
      return { subject: owner, credentialId };
    },
    async removePlan(subject, credentialId) {
      const plan = deps.subscriptions.owned(subject).find((credential) => credential.id === credentialId);
      return plan !== undefined
        ? deps.subscriptions.disconnect(plan.name, subject) !== null
        : deps.links.removeKey(subject, credentialId);
    },
  });
}

// An API key as the approval page and the app see it: never the key itself.
function linkKey(key: LinkApiKey): LinkSubscription {
  return {
    id: key.id,
    provider: "api_key",
    apiKeyProvider: key.provider,
    name: linkKeyProviderName(key.provider),
    label: `Key ending ${key.apiKey.slice(-4)}`,
    accountEmail: null,
    unavailableUntil: null,
    usage: [],
  };
}

export function linkSubscription(credential: SubscriptionCredential): LinkSubscription {
  const now = new Date();
  return {
    id: credential.id,
    provider: credential.provider,
    name: credential.name,
    label: credential.label,
    accountEmail: credential.accountEmail,
    unavailableUntil: credential.unavailableUntil !== null && credential.unavailableUntil > now
      ? credential.unavailableUntil.toISOString()
      : null,
    usage: linkUsageWindows(currentUsage(credential, now), now),
  };
}

// Usage reported without per-window detail has only its binding window; it
// still counts against a plan's share limit, so it is one window here.
function linkUsageWindows(usage: ReturnType<typeof currentUsage>, now: Date): LinkSubscription["usage"] {
  if (usage === null || usage === undefined) return [];
  const windows = usage.windows.length > 0
    ? usage.windows
    : [{ minutes: Math.max(1, Math.ceil((usage.resetsAt.getTime() - now.getTime()) / 60_000)), utilization: usage.utilization, resetsAt: usage.resetsAt }];
  return windows.map((window) => ({
    ...("modelFamily" in window && window.modelFamily !== undefined ? { modelFamily: window.modelFamily } : {}),
    minutes: window.minutes,
    utilization: window.utilization,
    resetsAt: window.resetsAt.toISOString(),
  }));
}
