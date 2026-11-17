/* Dari Link's rules, once, for every platform. A platform supplies its
   storage (`LinkStore`: the self-hosted gateway's SQLite database, hosted
   Dari's control plane) and its users (`LinkUsers`: who a key or a page
   visitor is, and where their plans and API keys live); `linkPlatform` makes
   the rest: approving grants, managing them, budgets, and the token protocol
   (grants.ts). */

import { randomUUID } from "node:crypto";

import { HttpError } from "../http/errors.js";
import type {
  LinkBudget,
  LinkBudgetStanding,
  LinkConnect,
  LinkKeyProvider,
  LinkPlanAdded,
  LinkPlatform,
  LinkSignIn,
  LinkSubscription,
} from "../platform/platform.js";
import type { SubscriptionKind } from "../types.js";
import { type BudgetUse, budgetLookbackMs, budgetStandings, overBudgetUntil } from "./budget.js";
import { budgetExhausted, linkGrantRevoked, linkTokenExpired, linkUnavailableError } from "./errors.js";
import {
  type ActiveLinkGrant,
  LINK_CLIENT_SECRET_PREFIX,
  LINK_CODE_PREFIX,
  LINK_CODE_TTL_MS,
  type LinkAppRecord,
  type LinkRepo,
  linkGrants,
  linkHash,
  linkSecret,
} from "./grants.js";

type MaybePromise<T> = T | Promise<T>;

/** A live grant as stored. */
export type LinkGrantRecord = {
  id: string;
  clientId: string;
  appName: string;
  // The user who approved it; null for a grant from before users had one.
  subject: string | null;
  credentialIds: string[];
  createdAt: string;
  budget: LinkBudget[];
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
  /** Change a live grant's plans or budget; false when none is live by that id. */
  updateGrant(grantId: string, change: { credentialIds?: string[]; budget?: LinkBudget[] }): MaybePromise<boolean>;
  /** The tokens each of a grant's requests received after `since` used. */
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

  const standings = async (grant: { id: string; budget: LinkBudget[] }, now = new Date()): Promise<LinkBudgetStanding[]> =>
    (await linkBudgetStandings(store, grant, now)).map((standing) => ({
      ...standing,
      resetsAt: standing.resetsAt?.toISOString() ?? null,
    }));

  // A live grant of this user's; null for anyone else's.
  const ownGrant = async (subject: string | null, grantId: string) => {
    const grant = await store.grant(grantId);
    return grant !== null && (subject === null || grant.subject === subject) ? grant : null;
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
            createdAt: grant.createdAt,
            budget: await standings(grant),
            subscriptions: await users.plansWithIds(grant.credentialIds),
            usage,
          };
        }));
      },
      async disconnect(subject, grantId) {
        return (await ownGrant(subject, grantId)) !== null && (await revoke(grantId));
      },
      async setBudget(subject, grantId, budget) {
        return (await ownGrant(subject, grantId)) !== null && (await store.updateGrant(grantId, { budget }));
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
        createdAt: grant.createdAt,
        budget: await standings(grant),
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
      return (await store.grants(subject)).map(({ subject: _, ...grant }) => grant);
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
 * token. Throws the 401 a dead token gets, and the 424 a grant at its budget
 * gets until its window rolls on.
 */
export async function linkTokenGrant(store: LinkStore, token: string, now = new Date()): Promise<ActiveLinkGrant | null> {
  const auth = await linkGrants(store).authenticate(token, now);
  if (auth === null) return null;
  if (auth.status === "expired") throw linkTokenExpired();
  if (auth.status === "revoked") throw linkGrantRevoked(auth.revokedBy, auth.revokedAt);
  const back = overBudgetUntil(await linkBudgetStandings(store, auth.grant, now));
  if (back !== undefined) throw linkUnavailableError(budgetExhausted(back));
  return auth.grant;
}

async function linkBudgetStandings(store: LinkStore, grant: { id: string; budget: LinkBudget[] }, now: Date) {
  if (grant.budget.length === 0) return [];
  const uses = await store.budgetUses(grant.id, now.getTime() - budgetLookbackMs(grant.budget));
  return budgetStandings(grant.budget, uses, now);
}
