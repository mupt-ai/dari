import { randomBytes } from "node:crypto";

import { errorCode, HttpError } from "../http/errors.js";
import { linkGrantRevoked, linkTokenExpired } from "../models/link_errors.js";
import { subscriptionOAuthProviderFor } from "../providers/subscription_limits.js";
import { getBuiltinProviders } from "@mupt-ai/pi-ai/providers/all";
import { providerForModel } from "@mupt-ai/dari-router/policy-engine";

import { CANONICAL_MODELS } from "../models/canonical.js";
import { LINK_KEY_GATEWAYS, gatewayFor } from "../models/gateways.js";
import type { GatewayPlatform, LinkBudget, LinkKeyProvider, LinkPlatform, LinkSubscription } from "../platform/platform.js";
import { checkProviderKey } from "../providers/key_check.js";
import { budgetStandings } from "../runtime/link_budget.js";
import { linkCompleteThrough } from "../runtime/link_in_flight.js";
import type { LinkApiKey } from "./link_store.js";
import type { PrefixStore } from "./prefix_store.js";
import type { SessionPinStore } from "./session_pin_store.js";
import { gatewayKeyIndex, grantServableIds, resolveSelfHostedRouter, type SelfHostedResolverDeps } from "./resolve.js";
import {
  CODEX_APPROVAL_PENDING,
  META_APPROVAL_PENDING,
  OPENCODE_APPROVAL_PENDING,
  SUBSCRIPTION_PROVIDERS,
  SubscriptionOAuthInputError,
  SubscriptionOAuthProviderError,
  completeOAuth,
  currentUsage,
  freshAccessToken,
  startOAuth,
  type SubscriptionCredential,
  type SubscriptionStore,
} from "./subscriptions/index.js";

/**
 * The self-hosted platform: routers from the config file, subscriptions,
 * Dari Link grants, prefix-cache state, and session pins in the gateway's
 * SQLite database, and one content-free log line per request.
 */
export function createSelfHostedPlatform(deps: Omit<SelfHostedResolverDeps, "prefixHits"> & {
  prefixes: PrefixStore;
  sessionPins: SessionPinStore;
  subscriptions: SubscriptionStore;
}): GatewayPlatform {
  const resolver: SelfHostedResolverDeps = {
    ...deps,
    prefixHits: (args) => deps.prefixes.hits(args),
  };
  return {
    resolveRouter: (request) => resolveSelfHostedRouter(resolver, request),
    writePrefixState: async (write) => {
      deps.prefixes.write(write);
    },
    writePendingLease: async (write) => {
      deps.prefixes.writePendingLease(write, deps.config.routers[write.router_id]?.zdr ?? false);
    },
    readSessionPin: async (key) => deps.sessionPins.read(key),
    writeSessionPin: async (write) => {
      deps.sessionPins.write(write);
    },
    recordSubscriptionUsage: async (report) => {
      // A grant is charged the rise since the plan's previous report.
      const previous = report.linkGrantId === undefined
        ? []
        : deps.subscriptions.get(report.credentialId)?.usage?.windows ?? [];
      deps.subscriptions.recordUsage(report.credentialId, report.usage);
      if (report.linkGrantId !== undefined) {
        deps.links.chargeBudget(report.linkGrantId, report.credentialId, previous, report.usage.windows);
      }
    },
    async nextSubscription(request) {
      const plan = subscriptionOAuthProviderFor(request.provider, "subscription");
      const only = request.linkGrantId === undefined
        ? undefined
        : grantServableIds(deps.links, deps.subscriptions, request.linkGrantId);
      const next = plan === null
        ? null
        : deps.subscriptions.selectCredential(plan, request.conversationId, new Date(), only);
      if (next === null) return undefined;
      return {
        credentialId: next.id,
        apiKey: await freshAccessToken(deps.subscriptions, next, { fetch: deps.fetch }),
      };
    },
    async markSubscriptionUnavailable({ credentialId, limit, linkGrantId }) {
      if (credentialId === undefined) return false;
      if (limit.model !== undefined) {
        return deps.subscriptions.holdModel(credentialId, limit.model, limit.resetsAt, limit.reason);
      }
      const another = deps.subscriptions.markUnavailable(credentialId, limit.resetsAt, limit.reason);
      if (linkGrantId === undefined) return another;
      // A grant's retry may use only its own subscriptions within its budget.
      const provider = deps.subscriptions.get(credentialId)?.provider;
      return provider !== undefined && deps.subscriptions.activeCredential(
        provider,
        new Date(),
        grantServableIds(deps.links, deps.subscriptions, linkGrantId),
      ) !== null;
    },
    async recordUsage() {
      // Resolution never reports a "managed" key source here.
      throw new Error("The self-hosted gateway has no managed provider keys to account.");
    },
    recordRequest(record) {
      console.info("routing request", JSON.stringify(record.summary));
      if (record.link !== undefined) {
        const { summary } = record;
        deps.links.recordUsage({
          requestId: summary.request_id,
          grantId: record.link.grantId,
          receivedAt: typeof record.row.received_at === "string" ? new Date(record.row.received_at) : new Date(),
          model: summary.selected_model,
          thinking: record.link.thinking,
          tags: record.tags,
          inputTokens: summary.input_tokens ?? 0,
          outputTokens: summary.output_tokens ?? 0,
          cacheReadTokens: summary.cache_read_tokens ?? 0,
          cacheWriteTokens: summary.cache_write_tokens ?? 0,
          status: summary.status,
        });
      }
    },
    captureRequestError(error, context) {
      if (context.status < 500) return;
      console.error(
        "routing request error",
        JSON.stringify({
          router_id: context.routerId,
          request_id: context.requestId ?? null,
          source_protocol: context.sourceProtocol,
          status: context.status,
          error_code: errorCode(error, "internal_error"),
        }),
      );
    },
    captureOperationalError(error, context) {
      console.error(
        "gateway operational error",
        JSON.stringify({
          code: context.code,
          request_id: context.requestId ?? null,
          router_id: context.routerId ?? null,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
    link: selfHostedLink(deps),
  };
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  meta: "Meta",
  moonshotai: "Moonshot AI",
  xai: "xAI",
};

// Whose API key a user can add on the approval page: each provider with
// catalog models this gateway can call with a key, then the gateways.
const LINK_KEY_PROVIDERS: readonly LinkKeyProvider[] = [
  ...[...new Set(CANONICAL_MODELS.map((model) => providerForModel(model.id)))]
    .filter((provider) => (getBuiltinProviders() as readonly string[]).includes(provider))
    .map((provider) => ({ id: provider, name: PROVIDER_NAMES[provider] ?? provider })),
  ...LINK_KEY_GATEWAYS.map((gateway) => ({ id: gateway, name: gatewayFor(gateway)!.label })),
];

// A user of the approval page connects their own plans there, which serve
// only the grants they approve; a gateway key manages every grant, and apps
// register with one or openly.
function selfHostedLink(
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
  const granted = (grantId: string, credentialIds: ReadonlySet<string>, budget: LinkBudget[]) => {
    const now = new Date();
    return [
      ...deps.subscriptions.withIds(credentialIds).map((credential) => ({
        ...linkSubscription(credential),
        budget: budgetStandings(budget, deps.links.budgetCharges(grantId, credential.id, now), now).map((standing) => ({
          ...standing,
          resetsAt: standing.resetsAt?.toISOString() ?? null,
        })),
      })),
      ...deps.links.keysWithIds(credentialIds).map(linkKey),
    ];
  };
  // The live grant a grant's own access token names; a child token cannot
  // read its grant or its usage.
  const parentGrantId = (accessToken: string): string => {
    const auth = deps.links.authenticate(accessToken);
    if (auth === null) throw new HttpError(401, "Missing or invalid Dari Link access token.", "authentication_error");
    if (auth.status === "expired") throw linkTokenExpired();
    if (auth.status === "revoked") throw linkGrantRevoked(auth.revokedBy, auth.revokedAt);
    if (auth.grant.pins !== undefined) {
      throw new HttpError(403, "A child token cannot read its grant or its usage.", "permission_denied");
    }
    return auth.grant.id;
  };
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
  return {
    httpRedirectHosts: deps.config.link?.allowHttpRedirectHosts ?? [],
    approval: {
      sessionSecret: () => sessionSecret,
      connectable: SUBSCRIPTION_PROVIDERS,
      keyProviders,
      async subscriptions(subject) {
        return [...deps.subscriptions.owned(subject).map(linkSubscription), ...deps.links.keys(subject).map(linkKey)];
      },
      async addKey(subject, provider, apiKey) {
        requireEncryption();
        const known = keyProviders.find((candidate) => candidate.id === provider);
        if (known === undefined) throw new HttpError(400, "Choose a provider to add a key for.", "invalid_request");
        const check = await checkProviderKey({
          provider,
          key: apiKey,
          ...(deps.config.providers[provider] ? { endpoint: deps.config.providers[provider] } : {}),
          fetch: deps.fetch as typeof fetch,
        });
        if (check.result === "rejected") {
          throw new HttpError(400, `${known.name} did not accept that key. Check it and try again.`, "invalid_request");
        }
        return { credentialId: deps.links.addKey(subject, provider, apiKey).id };
      },
      async startConnect(subject, kind) {
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
        const session = deps.subscriptions.createSession({
          provider: kind,
          flow: authorization.flow,
          credentialName: null,
          owner: subject,
          expiresAt: authorization.expiresAt,
        });
        return { session: session.token, authorizationUrl: authorization.authorizationUrl, userCode: authorization.userCode };
      },
      async completeConnect(subject, token, authorizationResponse) {
        const session = deps.subscriptions.getSession(token);
        if (session === null || session.owner !== subject || session.expiresAt <= new Date()) {
          throw new HttpError(400, "That sign-in ended. Start again.", "invalid_request");
        }
        let tokens;
        try {
          tokens = await completeOAuth(session.provider, session.flow, authorizationResponse, { fetch: deps.fetch });
        } catch (error) {
          if (error instanceof SubscriptionOAuthInputError) {
            if ([CODEX_APPROVAL_PENDING, META_APPROVAL_PENDING, OPENCODE_APPROVAL_PENDING].includes(error.message)) return null;
            throw new HttpError(400, error.message, "invalid_request");
          }
          if (error instanceof SubscriptionOAuthProviderError) {
            throw new HttpError(400, "The provider did not accept that sign-in. Try again.", "invalid_request");
          }
          throw error;
        }
        deps.subscriptions.deleteSession(token);
        return { credentialId: deps.subscriptions.connect(tokens, null, new Date(), subject)!.id };
      },
      async remove(subject, credentialId) {
        const plan = deps.subscriptions.owned(subject).find((credential) => credential.id === credentialId);
        const removed = plan !== undefined
          ? deps.subscriptions.disconnect(plan.name, subject) !== null
          : deps.links.removeKey(subject, credentialId);
        if (removed) deps.links.dropCredential(credentialId);
        return removed;
      },
      async grant(subject, grantId, clientId) {
        const grant = deps.links.grants().find((candidate) => candidate.id === grantId && candidate.clientId === clientId);
        if (grant === undefined || deps.links.subject(grantId) !== subject) return null;
        return { credentialIds: grant.credentialIds, budget: grant.budget };
      },
      async approve(request) {
        const connected = new Set([
          ...deps.subscriptions.owned(request.subject).map((credential) => credential.id),
          ...deps.links.keys(request.subject).map((key) => key.id),
        ]);
        if (request.credentialIds.length === 0 || !request.credentialIds.every((id) => connected.has(id))) {
          throw new HttpError(400, "Choose one or more connected subscriptions.", "invalid_request");
        }
        return { code: deps.links.approve(request) };
      },
    },
    async registerApp({ apiKey, name, redirectUris, confidential }) {
      if (apiKey !== undefined) requireGatewayKey(apiKey);
      return deps.links.registerApp(name, redirectUris, confidential === true);
    },
    async app(clientId) {
      return deps.links.app(clientId);
    },
    async exchangeCode(request) {
      return deps.links.exchangeCode(request);
    },
    async refresh(request) {
      return deps.links.refresh(request);
    },
    async exchangeToken(request) {
      return deps.links.exchangeToken(request);
    },
    async grant(accessToken) {
      const grantId = parentGrantId(accessToken);
      const grant = deps.links.grants().find((candidate) => candidate.id === grantId)!;
      const { credentialIds, ...rest } = grant;
      // The approval page knows its users only as opaque subjects.
      return { ...rest, subscriptions: granted(grant.id, new Set(credentialIds), grant.budget), user: null };
    },
    async usage({ accessToken, ...query }) {
      const grantId = parentGrantId(accessToken);
      // Read before the rows, so a request recorded in between is counted.
      const completeThrough = linkCompleteThrough(grantId).toISOString();
      return { ...deps.links.usage(grantId, query), completeThrough };
    },
    async revokeToken(request) {
      deps.links.revokeToken(request);
    },
    async grants(apiKey) {
      requireGatewayKey(apiKey);
      return deps.links.grants();
    },
    async setBudget({ apiKey, grantId, budget }) {
      requireGatewayKey(apiKey);
      return deps.links.setBudget(grantId, budget);
    },
    async revokeGrant({ apiKey, grantId }) {
      requireGatewayKey(apiKey);
      return deps.links.revoke(grantId, "user");
    },
  };
}

// An API key as the approval page and the app see it: never the key itself.
function linkKey(key: LinkApiKey): LinkSubscription {
  return {
    id: key.id,
    provider: "api_key",
    apiKeyProvider: key.provider,
    name: LINK_KEY_PROVIDERS.find((provider) => provider.id === key.provider)?.name ?? key.provider,
    label: `Key ending ${key.apiKey.slice(-4)}`,
    accountEmail: null,
    unavailableUntil: null,
    usage: [],
  };
}

function linkSubscription(credential: SubscriptionCredential): LinkSubscription {
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
    usage: (currentUsage(credential, now)?.windows ?? []).map((window) => ({
      minutes: window.minutes,
      utilization: window.utilization,
      resetsAt: window.resetsAt.toISOString(),
    })),
  };
}
