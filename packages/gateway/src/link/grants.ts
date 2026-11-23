/* The Dari Link token protocol, once, for every platform: redeeming a code,
   refreshing, minting child tokens, telling what a presented token is,
   revoking, and totalling usage. A platform supplies only storage (`LinkRepo`):
   the self-hosted gateway its SQLite database, hosted Dari its control plane.

   Every token is its own row holding only the token's SHA-256:

   - an access token lasts an hour, whatever is issued after it;
   - a refresh token does not expire. A public client's rotates on use:
     presenting the rotated one again within a minute is refused as a lost
     race, and later reuse revokes the grant. A confidential client, which
     also proves its secret, keeps its own;
   - a child token serves only its models, for up to twelve hours, and cannot
     refresh, mint, or read the grant;
   - a personal endpoint's key does not expire: it is what a user pastes into
     an app that takes their own key, and acts as the grant's access token.

   Revoking the grant stops them all at once. */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { HttpError } from "../http/errors.js";
import { linkGrantRevoked, linkTokenExpired } from "./errors.js";
import type {
  LinkApp,
  LinkBudget,
  LinkChildToken,
  LinkClient,
  LinkCodeExchange,
  LinkLimit,
  LinkTokenExchange,
  LinkTokens,
  LinkUsage,
  LinkUsageQuery,
  LinkUsageTotals,
} from "../platform/platform.js";
import {
  LINK_ACCESS_TOKEN_PREFIX,
  LINK_CHILD_TOKEN_PREFIX,
  LINK_KEY_TOKEN_PREFIX,
  isLinkToken,
} from "../protocol/input/router_model.js";

export const LINK_ACCESS_TOKEN_TTL_MS = 60 * 60_000;
export const LINK_CODE_TTL_MS = 10 * 60_000;
// A rotated refresh token presented again this soon lost a race with its own
// rotation (two instances, or a retry after a lost response); later, it leaked.
export const LINK_REFRESH_RACE_MS = 60_000;
// Expired tokens are kept this long so they are told apart from unknown ones.
export const LINK_TOKEN_RETENTION_MS = 24 * 60 * 60_000;

// Prefixes keep link tokens apart from gateway keys and from each other.
export const LINK_REFRESH_TOKEN_PREFIX = "dlk_rt_";
export const LINK_CODE_PREFIX = "dlk_code_";
export const LINK_CLIENT_SECRET_PREFIX = "dlk_cs_";

export type LinkRevoker = "user" | "app" | "reuse_detected";
export type LinkTokenKind = "access" | "refresh" | "child" | "key";
export type LinkPin = { model: string; thinking: string | null };

export type ActiveLinkGrant = {
  id: string;
  clientId: string;
  credentialIds: ReadonlySet<string>;
  budget: LinkBudget[];
  limits: LinkLimit[];
  // Set for a child token: the models it serves, each with its pinned thinking.
  pins?: LinkPin[];
  tags?: Record<string, string>;
};

/** What a presented link token is; null when it is not one the platform issued. */
export type LinkTokenAuth =
  | { status: "active"; grant: ActiveLinkGrant }
  | { status: "expired" }
  | { status: "revoked"; revokedBy: string | null; revokedAt: string | null };

/** A registered app as stored: with the hash of a confidential client's secret. */
export type LinkAppRecord = LinkApp & { clientSecretHash: string | null };

const LOOPBACK_HOSTS = ["127.0.0.1", "[::1]"];

/**
 * Whether an app registered this redirect URI. A loopback one matches on any
 * port (RFC 8252 section 7.3), so a CLI can listen on whatever port is free.
 */
export function registeredRedirect(redirectUris: readonly string[], redirectUri: string): boolean {
  if (redirectUris.includes(redirectUri)) return true;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.includes(url.hostname)) return false;
  url.port = "";
  return redirectUris.some((registered) => {
    try {
      const candidate = new URL(registered);
      candidate.port = "";
      return candidate.toString() === url.toString();
    } catch {
      return false;
    }
  });
}

/** A stored token with the grant it belongs to. Times are epoch milliseconds. */
export type LinkTokenRecord = {
  kind: LinkTokenKind;
  expiresAt: number | null;
  rotatedAt: number | null;
  pins: LinkPin[] | null;
  tags: Record<string, string> | null;
  grantId: string;
  clientId: string;
  credentialIds: string[];
  // The grant's budget and monthly spend limits.
  budget: LinkBudget[];
  limits: LinkLimit[];
  revokedAt: number | null;
  revokedBy: string | null;
  // False when the platform no longer serves the grant for a reason of its
  // own (hosted: its user left the organization); its tokens then read as
  // unknown.
  usable: boolean;
};

/** A token to store: its hash, never the token. */
export type LinkTokenIssue = {
  tokenHash: string;
  kind: LinkTokenKind;
  expiresAt: number | null;
  pins?: LinkPin[];
  tags?: Record<string, string>;
};

/** One request's usage as stored. */
export type LinkUsageRecord = Omit<LinkUsageTotals, "requests" | "errors"> & {
  // The request's outcome, as the request record's `status`.
  status: string | null;
  model: string | null;
  thinking: string | null;
  tags: Record<string, string>;
};

type MaybePromise<T> = T | Promise<T>;

/**
 * Storage for the token protocol. Each method is one atomic step; the rules
 * that decide between them are `linkGrants`'s.
 */
export type LinkRepo = {
  /** The app a client id names; null for an unknown or disabled one. */
  appRecord(clientId: string): MaybePromise<LinkAppRecord | null>;
  /**
   * Consume a live grant's unexpired code when the client, redirect URI, and
   * PKCE challenge are the ones it was issued for, and store its first tokens
   * in the same step: the grant's id, once.
   */
  redeemCode(request: {
    codeHash: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    tokens: LinkTokenIssue[];
    now: number;
  }): MaybePromise<string | null>;
  /** The token with this hash and its grant; null when there is none. */
  tokenRecord(tokenHash: string): MaybePromise<LinkTokenRecord | null>;
  /**
   * Store tokens for a grant, all or none. With `rotate`, also mark that
   * refresh token rotated: `race` when another request already did. `revoked`
   * when the grant is no longer live. The grant's tokens that expired, or were
   * rotated (except refresh tokens), before `forgetBefore` go.
   */
  issueTokens(request: {
    grantId: string;
    tokens: LinkTokenIssue[];
    rotate?: string;
    now: number;
    forgetBefore: number;
  }): MaybePromise<"ok" | "race" | "revoked">;
  /** Delete one token. */
  deleteToken(tokenHash: string): MaybePromise<void>;
  /**
   * Revoke a grant: its code and refresh tokens go, and its access and child
   * tokens stop working. False when none is live by that id.
   */
  revokeGrant(grantId: string, by: LinkRevoker, now: number): MaybePromise<boolean>;
  /** A grant's requests, received in the time range or the one by that id. */
  usageRecords(
    grantId: string,
    query: Pick<LinkUsageQuery, "since" | "until" | "requestId">,
  ): MaybePromise<LinkUsageRecord[]>;
};

/** The token protocol over a platform's storage. `now` is for tests. */
export function linkGrants(repo: LinkRepo) {
  const client = async ({ clientId, clientSecret }: LinkClient): Promise<LinkAppRecord> => {
    const app = await repo.appRecord(clientId);
    // A confidential client must send its secret; a public one must not.
    const proven = app !== null && (app.clientSecretHash === null
      ? !clientSecret
      : clientSecret !== undefined && sameText(app.clientSecretHash, linkHash(clientSecret)));
    if (app === null || !proven) {
      throw new HttpError(401, "Unknown client, or a missing or wrong client secret.", "invalid_client");
    }
    return app;
  };

  const issue = async (
    grantId: string,
    kinds: Array<Omit<LinkTokenIssue, "tokenHash">>,
    now: Date,
    rotate?: string,
  ): Promise<string[]> => {
    const tokens = kinds.map((entry) => linkSecret(TOKEN_PREFIX[entry.kind]));
    const result = await repo.issueTokens({
      grantId,
      tokens: kinds.map((entry, index) => ({ ...entry, tokenHash: linkHash(tokens[index]!) })),
      ...(rotate === undefined ? {} : { rotate }),
      now: now.getTime(),
      // Rotated refresh tokens stay while the grant lives (revoking it deletes
      // them): presenting one again is how a stolen refresh token is caught.
      forgetBefore: now.getTime() - LINK_TOKEN_RETENTION_MS,
    });
    if (result === "race") {
      throw new HttpError(
        400,
        "This refresh token was just rotated by another request. Use the tokens that request received.",
        "refresh_race",
      );
    }
    if (result === "revoked") throw invalidGrant("The refresh token is invalid or revoked.");
    return tokens;
  };

  const access = (now: Date): Omit<LinkTokenIssue, "tokenHash"> => ({
    kind: "access",
    expiresAt: now.getTime() + LINK_ACCESS_TOKEN_TTL_MS,
  });

  const authenticate = async (token: string, now = new Date()): Promise<LinkTokenAuth | null> => {
    if (!isLinkToken(token)) return null;
    return linkTokenAuth(await repo.tokenRecord(linkHash(token)), now);
  };

  return {
    /** What a presented access or child token is, or null when it is neither. */
    authenticate,

    /** The app a client id and secret prove; throws `invalid_client` otherwise. */
    authenticateClient: client,

    /** Redeem a code once: the grant's first tokens. */
    async exchangeCode(request: LinkCodeExchange, now = new Date()): Promise<LinkTokens> {
      await client(request);
      // The code is spent only with its tokens stored, so a failed step can be retried.
      const accessToken = linkSecret(TOKEN_PREFIX.access);
      const refreshToken = linkSecret(TOKEN_PREFIX.refresh);
      const grantId = await repo.redeemCode({
        codeHash: linkHash(request.code),
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        tokens: [
          { ...access(now), tokenHash: linkHash(accessToken) },
          { kind: "refresh", expiresAt: null, tokenHash: linkHash(refreshToken) },
        ],
        now: now.getTime(),
      });
      if (grantId === null) throw invalidGrant("The authorization code is invalid, expired, or already used.");
      return { accessToken, refreshToken, expiresIn: LINK_ACCESS_TOKEN_TTL_MS / 1000 };
    },

    /**
     * A new access token for a grant. A public client's refresh token rotates;
     * a confidential client keeps the one it presented.
     */
    async refresh(request: LinkClient & { refreshToken: string }, now = new Date()): Promise<LinkTokens> {
      const app = await client(request);
      const presented = linkHash(request.refreshToken);
      const record = await repo.tokenRecord(presented);
      if (record === null || record.kind !== "refresh" || record.clientId !== request.clientId || record.revokedAt !== null) {
        throw invalidGrant("The refresh token is invalid or revoked.");
      }
      if (record.rotatedAt !== null) {
        if (now.getTime() - record.rotatedAt > LINK_REFRESH_RACE_MS) {
          // A rotated refresh token came back long after: it leaked.
          await repo.revokeGrant(record.grantId, "reuse_detected", now.getTime());
          throw invalidGrant("The refresh token is invalid or revoked.");
        }
        throw new HttpError(
          400,
          "This refresh token was just rotated by another request. Use the tokens that request received.",
          "refresh_race",
        );
      }
      if (app.confidential) {
        const [accessToken] = await issue(record.grantId, [access(now)], now);
        return { accessToken: accessToken!, refreshToken: request.refreshToken, expiresIn: LINK_ACCESS_TOKEN_TTL_MS / 1000 };
      }
      const [accessToken, refreshToken] = await issue(
        record.grantId,
        [access(now), { kind: "refresh", expiresAt: null }],
        now,
        presented,
      );
      return { accessToken: accessToken!, refreshToken: refreshToken!, expiresIn: LINK_ACCESS_TOKEN_TTL_MS / 1000 };
    },

    /** Mint a child token from the grant's access token (RFC 8693). */
    async exchangeToken(request: LinkTokenExchange, now = new Date()): Promise<LinkChildToken> {
      await client(request);
      const subject = await authenticate(request.subjectToken, now);
      if (subject?.status !== "active" || subject.grant.pins !== undefined || subject.grant.clientId !== request.clientId) {
        throw invalidGrant("subject_token must be a live access token of this client's grant.");
      }
      const [accessToken] = await issue(
        subject.grant.id,
        [{
          kind: "child",
          expiresAt: now.getTime() + request.expiresIn * 1000,
          pins: request.models.map((entry) => ({ model: entry.model, thinking: entry.thinking ?? null })),
          ...(Object.keys(request.tags).length === 0 ? {} : { tags: request.tags }),
        }],
        now,
      );
      return { accessToken: accessToken!, expiresIn: request.expiresIn, grantId: subject.grant.id };
    },

    /** Revoke the grant any of its tokens names, when the client owns it (RFC 7009). */
    async revokeToken(request: LinkClient & { token: string }, now = new Date()): Promise<void> {
      await client(request);
      const tokenHash = linkHash(request.token);
      const record = await repo.tokenRecord(tokenHash);
      if (record === null || record.clientId !== request.clientId) return;
      // A child token ends only itself: a sandbox holding one cannot end the grant.
      if (record.kind === "child") await repo.deleteToken(tokenHash);
      else await repo.revokeGrant(record.grantId, "app", now.getTime());
    },

    /**
     * The live grant a grant's own access token names. Throws the 401 a dead
     * token gets, and 403 for a child token, which cannot read its grant or
     * its usage.
     */
    async parentGrant(accessToken: string, now = new Date()): Promise<ActiveLinkGrant> {
      const auth = await authenticate(accessToken, now);
      if (auth === null) throw new HttpError(401, "Missing or invalid Dari Link access token.", "authentication_error");
      if (auth.status === "expired") throw linkTokenExpired();
      if (auth.status === "revoked") throw linkGrantRevoked(auth.revokedBy, auth.revokedAt);
      if (auth.grant.pins !== undefined) {
        throw new HttpError(403, "A child token cannot read its grant or its usage.", "permission_denied");
      }
      return auth.grant;
    },

    /** What a grant's requests used, filtered by tags and receive time. */
    async usage(grantId: string, query: Omit<LinkUsageQuery, "accessToken">): Promise<Omit<LinkUsage, "completeThrough">> {
      return summarizeLinkUsage(await repo.usageRecords(grantId, query), query.tags, query.groupByTag);
    },
  };
}

export const TOKEN_PREFIX: Record<LinkTokenKind, string> = {
  access: LINK_ACCESS_TOKEN_PREFIX,
  child: LINK_CHILD_TOKEN_PREFIX,
  key: LINK_KEY_TOKEN_PREFIX,
  refresh: LINK_REFRESH_TOKEN_PREFIX,
};

/** What a stored access, child, or key token is now; null when it serves nothing. */
export function linkTokenAuth(record: LinkTokenRecord | null, now: Date): LinkTokenAuth | null {
  if (record === null || record.kind === "refresh") return null;
  if (record.revokedAt !== null) {
    return { status: "revoked", revokedBy: record.revokedBy, revokedAt: new Date(record.revokedAt).toISOString() };
  }
  // An endpoint's key never expires; every other token does.
  if (record.kind !== "key" && (record.expiresAt === null || record.expiresAt <= now.getTime())) {
    return { status: "expired" };
  }
  if (!record.usable) return null;
  const pins = record.kind === "child" ? record.pins ?? [] : undefined;
  // A child token that names no model serves nothing.
  if (pins?.length === 0) return null;
  return {
    status: "active",
    grant: {
      id: record.grantId,
      clientId: record.clientId,
      credentialIds: new Set(record.credentialIds),
      budget: record.budget,
      limits: record.limits,
      ...(pins === undefined ? {} : { pins }),
      ...(record.tags === null ? {} : { tags: record.tags }),
    },
  };
}

/** Totals of a grant's requests carrying every given tag, by model and optionally by one tag's values. */
export function summarizeLinkUsage(
  records: readonly LinkUsageRecord[],
  tags: Record<string, string>,
  groupByTag?: string,
): Omit<LinkUsage, "completeThrough"> {
  const empty = (): LinkUsageTotals => ({
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  const add = (totals: LinkUsageTotals, record: LinkUsageRecord) => {
    totals.requests += 1;
    // A request the provider or Dari failed; an aborted one is the client's choice.
    totals.errors += record.status === "provider_error" || record.status === "selector_error" ? 1 : 0;
    totals.inputTokens += record.inputTokens;
    totals.outputTokens += record.outputTokens;
    totals.cacheReadTokens += record.cacheReadTokens;
    totals.cacheWriteTokens += record.cacheWriteTokens;
  };
  const filters = Object.entries(tags);
  const total = empty();
  const byModel = new Map<string, LinkUsage["byModel"][number]>();
  const byTag = new Map<string | null, NonNullable<LinkUsage["byTag"]>[number]>();
  for (const record of records) {
    if (!filters.every(([key, value]) => record.tags[key] === value)) continue;
    add(total, record);
    if (groupByTag !== undefined) {
      const value = record.tags[groupByTag] ?? null;
      let tagged = byTag.get(value);
      if (tagged === undefined) {
        tagged = { value, ...empty() };
        byTag.set(value, tagged);
      }
      add(tagged, record);
    }
    const model = record.model ?? "unknown";
    const key = `${model}\u0000${record.thinking ?? ""}`;
    let entry = byModel.get(key);
    if (entry === undefined) {
      entry = { model, thinking: record.thinking, ...empty() };
      byModel.set(key, entry);
    }
    add(entry, record);
  }
  return {
    ...total,
    byModel: [...byModel.values()].sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model)),
    ...(groupByTag === undefined
      ? {}
      : {
          byTag: [...byTag.values()].sort(
            (a, b) => b.requests - a.requests || (a.value ?? "").localeCompare(b.value ?? ""),
          ),
        }),
  };
}

/** A new secret: a code, a token, or a client secret. */
export function linkSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

/** How a secret is stored. */
export function linkHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameText(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function invalidGrant(message: string): HttpError {
  return new HttpError(400, message, "invalid_grant");
}
