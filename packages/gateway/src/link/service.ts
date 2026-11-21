/* Dari Link's rules, once, for every platform. A platform supplies its
   storage (`LinkStore`: the self-hosted gateway's SQLite database, hosted
   Dari's control plane) and its users (`LinkUsers`: who a key or a page
   visitor is, and where their plans and API keys live); `linkPlatform` makes
   the rest: approving grants, managing them, budgets and spend limits,
   personal endpoints, and the token protocol (grants.ts).

   A personal endpoint is a grant the user makes for themselves, on the plans
   and keys they choose, called with a key that does not expire from any app
   that takes the user's own key. Its grants belong to one built-in app,
   `LINK_PERSONAL_CLIENT_ID`, which nothing can sign in to. */

import { randomUUID } from "node:crypto";

import { HttpError } from "../http/errors.js";
import type {
  LinkBudget,
  LinkBudgetStanding,
  LinkConnect,
  LinkGrant,
  LinkKeyProvider,
  LinkLimit,
  LinkManagedGrant,
  LinkPlanAdded,
  LinkPlatform,
  LinkSignIn,
  LinkSpend,
  LinkSubscription,
} from "../platform/platform.js";
import type { SubscriptionKind } from "../types.js";
import {
  type BudgetUse,
  budgetStandings,
  grantSpend,
  nextMonthStart,
  overBudgetUntil,
  usesSince,
} from "./budget.js";
import { budgetExhausted, limitsReached, linkGrantRevoked, linkTokenExpired, linkUnavailableError } from "./errors.js";
import {
  type ActiveLinkGrant,
  LINK_CLIENT_SECRET_PREFIX,
  LINK_CODE_PREFIX,
  LINK_CODE_TTL_MS,
  type LinkAppRecord,
  type LinkRepo,
  type LinkTokenIssue,
  linkGrants,
  linkHash,
  linkSecret,
  LINK_TOKEN_RETENTION_MS,
  TOKEN_PREFIX,
} from "./grants.js";

/** The built-in app every personal endpoint's grant belongs to. */
export const LINK_PERSONAL_CLIENT_ID = "lnk_personal";

type MaybePromise<T> = T | Promise<T>;

/** A live grant as stored. */
export type LinkGrantRecord = {
  id: string;
  clientId: string;
  // The app's name, or a personal endpoint's own.
  appName: string;
  // The user who approved it; null for a grant from before users had one.
  subject: string | null;
  credentialIds: string[];
  createdAt: string;
  budget: LinkBudget[];
  limits: LinkLimit[];
};

/** Storage for Dari Link: the token protocol's steps, and grants. */
export type LinkStore = LinkRepo & {
  /** Live grants of one user, or of everyone (null), oldest first. */
  grants(subject: string | null): MaybePromise<LinkGrantRecord[]>;
  /** A live grant; null when none is live by that id. */
  grant(grantId: string): MaybePromise<LinkGrantRecord | null>;
  /**
   * Store a grant awaiting its code exchange, and return its id. With
   * `grantId`, give that live grant of this user and app new plans, budget,
   * and code instead; null when there is none.
   */
  saveGrant(request: {
    grantId?: string;
    subject: string;
    clientId: string;
    redirectUri: string;
    codeHash: string;
    codeChallenge: string;
    codeExpiresAt: number;
    credentialIds: string[];
    budget: LinkBudget[];
    now: number;
  }): MaybePromise<string | null>;
  /**
   * Store a personal endpoint: a grant of `LINK_PERSONAL_CLIENT_ID` named
   * `name`, live at once, with its key token, in one step. Its id.
   */
  createEndpoint(request: {
    subject: string;
    name: string;
    credentialIds: string[];
    limits: LinkLimit[];
    key: LinkTokenIssue;
    now: number;
  }): MaybePromise<string>;
  /**
   * Change a live grant's plans, budget, or limits, or an endpoint's name;
   * false when none is live by that id.
   */
  updateGrant(
    grantId: string,
    change: { credentialIds?: string[]; budget?: LinkBudget[]; limits?: LinkLimit[]; name?: string },
  ): MaybePromise<boolean>;
  /** What each of a grant's requests received after `since` used and cost. */
  budgetUses(grantId: string, since: number): MaybePromise<BudgetUse[]>;
};

/** A platform's users: who a key is, and where their plans and keys live. */
export type LinkUsers = {
  /** Signs the pages' cookies; throws HttpError(503, `link_not_configured`) without one. */
  sessionSecret(): string;
  /** See `LinkApprovalPage.signIn`. */
  signIn?: LinkSignIn;
  connectable: readonly SubscriptionKind[];
  keyProviders: readonly LinkKeyProvider[];
  /** See `LinkPlatform.httpRedirectHosts`. */
  httpRedirectHosts?: readonly string[];
  /**
   * Whether an app may register with no API key (RFC 7591). Hosted Dari says no,
   * so every app belongs to an organization; a self-hosted gateway's operator
   * decides.
   */
  openRegistration: boolean;
  /**
   * Store a registered app; with `apiKey`, owned by whoever that key is.
   * Throws HttpError(401 or 403) for a key that may not register apps.
   */
  registerApp(app: LinkAppRecord, apiKey: string | undefined): Promise<void>;
  /**
   * Whose grants a management key manages: one user, or everyone (null).
   * Throws HttpError(401 or 403) for a key that manages none.
   */
  manager(apiKey: string): Promise<string | null>;
  /** When a grant's usage is complete through; null when the platform cannot tell. */
  completeThrough(grantId: string): string | null;
  /** A user's plans and API keys, oldest first. */
  plans(subject: string): Promise<LinkSubscription[]>;
  /** The plans and API keys with these ids, whoever added them. */
  plansWithIds(ids: readonly string[]): Promise<LinkSubscription[]>;
  /** See `LinkApprovalPage.addKey`; the provider is one of `keyProviders`. */
  addKey(subject: string | null, provider: string, apiKey: string): Promise<LinkPlanAdded>;
  startConnect(kind: SubscriptionKind): Promise<LinkConnect>;
  completeConnect(subject: string | null, session: string, authorizationResponse: string): Promise<LinkPlanAdded | null>;
  /** Delete one of the user's plans or keys; false when they have none by that id. */
  removePlan(subject: string, credentialId: string): Promise<boolean>;
};

export function linkPlatform(store: LinkStore, users: LinkUsers): LinkPlatform {
  const protocol = linkGrants(store);

  // A live grant of this user's; null for anyone else's.
  const ownGrant = async (subject: string | null, grantId: string) => {
    const grant = await store.grant(grantId);
    return grant !== null && (subject === null || grant.subject === subject) ? grant : null;
  };

  // A grant's budget windows and each granted plan or key's spend this month.
  const standings = async (grant: LinkGrantRecord, now = new Date()): Promise<{
    budget: LinkBudgetStanding[];
    spend: LinkSpend[];
  }> => {
    const uses = await store.budgetUses(grant.id, usesSince(grant.budget, now));
    return {
      budget: budgetStandings(grant.budget, uses, now).map((standing) => ({
        ...standing,
        resetsAt: standing.resetsAt?.toISOString() ?? null,
      })),
      spend: grantSpend(grant.credentialIds, grant.limits, uses, now),
    };
  };

  const publicGrant = ({ subject: _, ...grant }: LinkGrantRecord): LinkGrant => ({
    ...grant,
    endpoint: grant.clientId === LINK_PERSONAL_CLIENT_ID,
  });

  const managedGrant = async (grant: LinkGrantRecord): Promise<LinkManagedGrant> => ({
    ...publicGrant(grant),
    spend: (await standings(grant)).spend,
  });

  // Plans and keys the user can grant, and limits only on them.
  const ownedCredentials = async (subject: string, credentialIds: readonly string[], limits: readonly LinkLimit[] = []) => {
    const owned = new Set((await users.plans(subject)).map((plan) => plan.id));
    if (credentialIds.length === 0 || !credentialIds.every((id) => owned.has(id))) {
      throw new HttpError(400, "Choose one or more of your connected plans or API keys.", "invalid_request");
    }
    if (!limits.every((limit) => credentialIds.includes(limit.credentialId))) {
      throw new HttpError(400, "Set limits only on the plans and keys the grant shares.", "invalid_request");
    }
    return [...new Set(credentialIds)].sort();
  };

  // The one user a key acts for: endpoints are personal, so an operator key
  // that manages everyone cannot make one.
  const endpointOwner = async (apiKey: string): Promise<string> => {
    const subject = await users.manager(apiKey);
    if (subject === null) {
      throw new HttpError(403, "Use your personal key: an endpoint serves one user's plans.", "permission_denied");
    }
    return subject;
  };

  const ownEndpoint = async (subject: string | null, grantId: string) => {
    const grant = await ownGrant(subject, grantId);
    return grant !== null && grant.clientId === LINK_PERSONAL_CLIENT_ID ? grant : null;
  };

  const newKey = (): { key: string; issue: LinkTokenIssue } => {
    const key = linkSecret(TOKEN_PREFIX.key);
    return { key, issue: { tokenHash: linkHash(key), kind: "key", expiresAt: null } };
  };


  const revoke = (grantId: string) => store.revokeGrant(grantId, "user", Date.now());

  return {
    httpRedirectHosts: users.httpRedirectHosts ?? [],
    approval: {
      sessionSecret: () => users.sessionSecret(),
      ...(users.signIn === undefined ? {} : { signIn: users.signIn }),
      connectable: users.connectable,
      keyProviders: users.keyProviders,
      subscriptions: (subject) => users.plans(subject),
      async addKey(subject, provider, apiKey) {
        if (!users.keyProviders.some((candidate) => candidate.id === provider)) {
          throw new HttpError(400, "Choose a provider to add a key for.", "invalid_request");
        }
        return await users.addKey(subject, provider, apiKey);
      },
      startConnect: (kind) => users.startConnect(kind),
      completeConnect: (subject, session, response) => users.completeConnect(subject, session, response),
      async remove(subject, credentialId) {
        if (!(await users.plans(subject)).some((plan) => plan.id === credentialId)) return false;
        // Every app loses it first, and a grant left with nothing ends, so a
        // failure part way never leaves a grant on a deleted plan.
        for (const grant of await store.grants(subject)) {
          if (!grant.credentialIds.includes(credentialId)) continue;
          const left = grant.credentialIds.filter((id) => id !== credentialId);
          if (left.length === 0) await revoke(grant.id);
          else await store.updateGrant(grant.id, { credentialIds: left });
        }
        return await users.removePlan(subject, credentialId);
      },
      async grant(subject, grantId, clientId) {
        const grant = await ownGrant(subject, grantId);
        return grant === null || grant.clientId !== clientId ? null : { credentialIds: grant.credentialIds, budget: grant.budget };
      },
      async approve(request) {
        const owned = new Set((await users.plans(request.subject)).map((plan) => plan.id));
        if (request.credentialIds.length === 0 || !request.credentialIds.every((id) => owned.has(id))) {
          throw new HttpError(400, "Choose one or more connected subscriptions.", "invalid_request");
        }
        const app = await store.appRecord(request.clientId);
        if (app === null || !app.redirectUris.includes(request.redirectUri)) {
          throw new HttpError(400, "Unknown app or redirect URI.", "invalid_client");
        }
        const code = linkSecret(LINK_CODE_PREFIX);
        const now = Date.now();
        const grantId = await store.saveGrant({
          ...(request.grantId === undefined ? {} : { grantId: request.grantId }),
          subject: request.subject,
          clientId: request.clientId,
          redirectUri: request.redirectUri,
          codeHash: linkHash(code),
          codeChallenge: request.codeChallenge,
          codeExpiresAt: now + LINK_CODE_TTL_MS,
          credentialIds: [...new Set(request.credentialIds)].sort(),
          budget: request.budget,
          now,
        });
        if (grantId === null) throw new HttpError(400, "That connection no longer exists.", "invalid_request");
        return { code };
      },
      async connections(subject) {
        return await Promise.all((await store.grants(subject)).map(async (grant) => {
          const { byModel: _, ...usage } = await protocol.usage(grant.id, { tags: {} });
          return {
            id: grant.id,
            clientId: grant.clientId,
            appName: grant.appName,
            endpoint: grant.clientId === LINK_PERSONAL_CLIENT_ID,
            createdAt: grant.createdAt,
            ...(await standings(grant)),
            subscriptions: await users.plansWithIds(grant.credentialIds),
            usage,
          };
        }));
      },
      async disconnect(subject, grantId) {
        return (await ownGrant(subject, grantId)) !== null && (await revoke(grantId));
      },
      async setLimits(subject, grantId, limits) {
        const grant = await ownGrant(subject, grantId);
        if (grant === null) return false;
        await ownedCredentials(subject, grant.credentialIds, limits);
        return await store.updateGrant(grantId, { limits });
      },
    },
    async registerApp({ apiKey, name, redirectUris, confidential }) {
      if (apiKey === undefined && !users.openRegistration) {
        throw new HttpError(401, "Register with a Dari API key, so the app belongs to an organization.", "authentication_error");
      }
      const { record, clientSecret } = newLinkApp({ name, redirectUris, confidential: confidential === true });
      await users.registerApp(record, apiKey);
      const { clientSecretHash: _, ...app } = record;
      return { ...app, ...(clientSecret === undefined ? {} : { clientSecret }) };
    },
    async app(clientId) {
      const record = await store.appRecord(clientId);
      if (record === null) return null;
      const { clientSecretHash: _, ...app } = record;
      return app;
    },
    exchangeCode: (request) => protocol.exchangeCode(request),
    refresh: (request) => protocol.refresh(request),
    exchangeToken: (request) => protocol.exchangeToken(request),
    revokeToken: (request) => protocol.revokeToken(request),
    async grant(accessToken) {
      const { id } = await protocol.parentGrant(accessToken);
      const grant = await store.grant(id);
      // Revoked since the token was read.
      if (grant === null) throw linkGrantRevoked(null, null);
      return {
        id: grant.id,
        clientId: grant.clientId,
        appName: grant.appName,
        endpoint: grant.clientId === LINK_PERSONAL_CLIENT_ID,
        createdAt: grant.createdAt,
        ...(await standings(grant)),
        subscriptions: await users.plansWithIds(grant.credentialIds),
      };
    },
    async usage({ accessToken, ...query }) {
      const { id } = await protocol.parentGrant(accessToken);
      // Read before the rows, so a request recorded in between is counted.
      const completeThrough = users.completeThrough(id);
      return { ...(await protocol.usage(id, query)), completeThrough };
    },
    async grants(apiKey) {
      const subject = await users.manager(apiKey);
      return await Promise.all((await store.grants(subject)).map(managedGrant));
    },
    async plans(apiKey) {
      return await users.plans(await endpointOwner(apiKey));
    },
    async createEndpoint({ apiKey, name, credentialIds, limits }) {
      const subject = await endpointOwner(apiKey);
      const granted = await ownedCredentials(subject, credentialIds, limits);
      const { key, issue } = newKey();
      const grantId = await store.createEndpoint({
        subject,
        name: endpointName(name),
        credentialIds: granted,
        limits,
        key: issue,
        now: Date.now(),
      });
      const grant = await store.grant(grantId);
      if (grant === null) throw new Error("A new endpoint's grant was not stored.");
      return { grant: await managedGrant(grant), key };
    },
    async updateEndpoint({ apiKey, grantId, name, credentialIds }) {
      const subject = await endpointOwner(apiKey);
      const grant = await ownEndpoint(subject, grantId);
      if (grant === null) return false;
      const granted = credentialIds === undefined ? undefined : await ownedCredentials(subject, credentialIds);
      return await store.updateGrant(grantId, {
        ...(name === undefined ? {} : { name: endpointName(name) }),
        ...(granted === undefined
          ? {}
          // A plan or key the endpoint no longer shares keeps no limit.
          : { credentialIds: granted, limits: grant.limits.filter((limit) => granted.includes(limit.credentialId)) }),
      });
    },
    async issueEndpointKey({ apiKey, grantId }) {
      const subject = await endpointOwner(apiKey);
      if ((await ownEndpoint(subject, grantId)) === null) return null;
      const { key, issue } = newKey();
      const now = Date.now();
      const result = await store.issueTokens({ grantId, tokens: [issue], now, forgetBefore: now - LINK_TOKEN_RETENTION_MS });
      return result === "ok" ? key : null;
    },
    async setLimits({ apiKey, grantId, limits }) {
      const subject = await users.manager(apiKey);
      const grant = await ownGrant(subject, grantId);
      if (grant === null) return false;
      if (!limits.every((limit) => grant.credentialIds.includes(limit.credentialId))) {
        throw new HttpError(400, "Set limits only on the plans and keys the grant shares.", "invalid_request");
      }
      return await store.updateGrant(grantId, { limits });
    },
    async setBudget({ apiKey, grantId, budget }) {
      const subject = await users.manager(apiKey);
      return (await ownGrant(subject, grantId)) !== null && (await store.updateGrant(grantId, { budget }));
    },
    async revokeGrant({ apiKey, grantId }) {
      const subject = await users.manager(apiKey);
      return (await ownGrant(subject, grantId)) !== null && (await revoke(grantId));
    },
  };
}

/**
 * A new app: its client id, and for a confidential one a client secret,
 * returned this once, of which only the hash is kept. Every app is made here,
 * whichever way it registers (hosted Dari's console included).
 */
export function newLinkApp(request: { name: string; redirectUris: string[]; confidential: boolean }): {
  record: LinkAppRecord;
  clientSecret?: string;
} {
  const secret = request.confidential ? newLinkClientSecret() : null;
  const record: LinkAppRecord = {
    clientId: `lnk_${randomUUID().replaceAll("-", "")}`,
    name: request.name,
    redirectUris: request.redirectUris,
    confidential: secret !== null,
    clientSecretHash: secret?.hash ?? null,
  };
  return { record, ...(secret === null ? {} : { clientSecret: secret.secret }) };
}

/** A confidential app's client secret, and the hash that is kept of it. */
export function newLinkClientSecret(): { secret: string; hash: string } {
  const secret = linkSecret(LINK_CLIENT_SECRET_PREFIX);
  return { secret, hash: linkHash(secret) };
}

/**
 * The grant a link token serves a request for: null when the key is no link
 * token. Its plans and keys at their monthly spend limit are left out. Throws
 * the 401 a dead token gets, and the 424 a grant at its budget, or with every
 * plan and key at its limit, gets until it serves again.
 */
export async function linkTokenGrant(store: LinkStore, token: string, now = new Date()): Promise<ActiveLinkGrant | null> {
  const auth = await linkGrants(store).authenticate(token, now);
  if (auth === null) return null;
  if (auth.status === "expired") throw linkTokenExpired();
  if (auth.status === "revoked") throw linkGrantRevoked(auth.revokedBy, auth.revokedAt);
  const { grant } = auth;
  if (grant.budget.length === 0 && grant.limits.length === 0) return grant;
  const uses = await store.budgetUses(grant.id, usesSince(grant.budget, now));
  const back = overBudgetUntil(budgetStandings(grant.budget, uses, now));
  if (back !== undefined) throw linkUnavailableError(budgetExhausted(back));
  const reached = new Set(
    grantSpend(grant.credentialIds, grant.limits, uses, now).filter((entry) => entry.reached).map((entry) => entry.credentialId),
  );
  if (reached.size === 0) return grant;
  const credentialIds = new Set([...grant.credentialIds].filter((id) => !reached.has(id)));
  if (credentialIds.size === 0) throw linkUnavailableError(limitsReached(nextMonthStart(now)));
  return { ...grant, credentialIds };
}

function endpointName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 120) {
    throw new HttpError(400, "Name the endpoint, in 120 characters or fewer.", "invalid_request");
  }
  return trimmed;
}
