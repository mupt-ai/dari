/**
 * SQLite storage for personal subscription credentials and pending OAuth flows.
 *
 * Tokens are stored as PLAINTEXT in the gateway's own database file. Anyone
 * who can read that file can use the connected subscriptions until the
 * provider revokes them, so keep the file on storage only the gateway's
 * operator can read, and treat backups of it as secrets.
 *
 * Connection order (`position`) is the order routing switches through: the
 * active credential for a provider is the first one, in that order, that is
 * not held. A hold ends on its own once `unavailable_until` passes.
 */
import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";

import type { OAuthTokens, SubscriptionProvider } from "./oauth.js";

export type SubscriptionCredential = {
  id: string;
  provider: SubscriptionProvider;
  // Stable env-var-style handle the CLI addresses a subscription by.
  name: string;
  // The user's own name for the subscription.
  label: string | null;
  accountEmail: string | null;
  accountId: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  unavailableUntil: Date | null;
  unavailableReason: string | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
};

export type PendingOAuthSession = {
  token: string;
  provider: SubscriptionProvider;
  flow: Record<string, string>;
  // The subscription this flow reconnects; null connects another one.
  credentialName: string | null;
  expiresAt: Date;
};

const BASE_NAMES: Record<SubscriptionProvider, string> = {
  anthropic_claude_code: "ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN",
  openai_codex: "OPENAI_CODEX_OAUTH_TOKEN",
  meta_muse: "META_MUSE_OAUTH_TOKEN",
};

type CredentialRow = {
  id: string;
  provider: SubscriptionProvider;
  name: string;
  label: string | null;
  account_email: string | null;
  account_id: string | null;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  unavailable_until: number | null;
  unavailable_reason: string | null;
  position: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
};

type SessionRow = {
  token: string;
  provider: SubscriptionProvider;
  flow_json: string;
  credential_name: string | null;
  expires_at: number;
};

export class SubscriptionStore {
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS subscription_credentials (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      name TEXT NOT NULL UNIQUE,
      label TEXT,
      account_email TEXT,
      account_id TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      unavailable_until INTEGER,
      unavailable_reason TEXT,
      position INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS subscription_oauth_sessions (
      token TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      flow_json TEXT NOT NULL,
      credential_name TEXT,
      expires_at INTEGER NOT NULL
    )`);
  }

  /** Every subscription, grouped by provider, in connection order. */
  list(provider?: SubscriptionProvider): SubscriptionCredential[] {
    const rows = provider === undefined
      ? this.db.query<CredentialRow, []>("SELECT * FROM subscription_credentials ORDER BY provider, position").all()
      : this.db
        .query<CredentialRow, [string]>("SELECT * FROM subscription_credentials WHERE provider = ? ORDER BY position")
        .all(provider);
    return rows.map(credentialFromRow);
  }

  get(id: string): SubscriptionCredential | null {
    const row = this.db.query<CredentialRow, [string]>("SELECT * FROM subscription_credentials WHERE id = ?").get(id);
    return row === null ? null : credentialFromRow(row);
  }

  getByName(name: string): SubscriptionCredential | null {
    const row = this.db
      .query<CredentialRow, [string]>("SELECT * FROM subscription_credentials WHERE name = ?")
      .get(normalizeName(name));
    return row === null ? null : credentialFromRow(row);
  }

  /** The credential routing uses now, or null when none is connected or every one is held. */
  activeCredential(provider: SubscriptionProvider, now = new Date()): SubscriptionCredential | null {
    // Stay on the most recently used subscription while it serves, so its
    // prompt cache stays warm; once it is held, move on in connection order.
    const credentials = this.list(provider);
    let start = 0;
    credentials.forEach((credential, index) => {
      const lastUsed = credential.lastUsedAt?.getTime() ?? -1;
      if (lastUsed > (credentials[start]!.lastUsedAt?.getTime() ?? -1)) start = index;
    });
    for (let offset = 0; offset < credentials.length; offset += 1) {
      const credential = credentials[(start + offset) % credentials.length]!;
      if (!isHeld(credential, now)) return credential;
    }
    return null;
  }

  /**
   * Store tokens from a completed OAuth flow. `reconnectName` replaces that
   * subscription (null when it is not connected). Otherwise a subscription
   * for the same account email is replaced, and anything else is connected
   * last in order under the first free name.
   */
  connect(tokens: OAuthTokens, reconnectName: string | null, now = new Date()): SubscriptionCredential | null {
    return this.db.transaction(() => {
      const existing = reconnectName !== null
        ? this.getByName(reconnectName)
        : this.list(tokens.provider).find(
          (credential) => tokens.accountEmail !== null && credential.accountEmail === tokens.accountEmail,
        ) ?? null;
      if (reconnectName !== null && existing?.provider !== tokens.provider) return null;

      if (existing !== null) {
        // Another (or an unidentified) account must not inherit the previous account's hold.
        const sameAccount = tokens.accountEmail !== null && tokens.accountEmail === existing.accountEmail;
        this.db.run(
          `UPDATE subscription_credentials SET access_token = ?, refresh_token = ?, expires_at = ?,
             account_id = ?, account_email = ?, unavailable_until = ?, unavailable_reason = ?, updated_at = ?
           WHERE id = ?`,
          [
            tokens.accessToken,
            tokens.refreshToken,
            tokens.expiresAt.getTime(),
            tokens.accountId,
            tokens.accountEmail,
            sameAccount ? existing.unavailableUntil?.getTime() ?? null : null,
            sameAccount ? existing.unavailableReason : null,
            now.getTime(),
            existing.id,
          ],
        );
        return this.get(existing.id);
      }

      const id = `cred_${randomUUID().replaceAll("-", "")}`;
      const position = this.db
        .query<{ next: number }, []>("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM subscription_credentials")
        .get()!.next;
      this.db.run(
        `INSERT INTO subscription_credentials (id, provider, name, account_email, account_id, access_token,
           refresh_token, expires_at, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          tokens.provider,
          this.freeName(BASE_NAMES[tokens.provider]),
          tokens.accountEmail,
          tokens.accountId,
          tokens.accessToken,
          tokens.refreshToken,
          tokens.expiresAt.getTime(),
          position,
          now.getTime(),
          now.getTime(),
        ],
      );
      return this.get(id);
    })();
  }

  /** Persist refreshed tokens. Keeps the stored account id when the refresh carries none. */
  updateTokens(id: string, tokens: OAuthTokens, now = new Date()): void {
    this.db.run(
      `UPDATE subscription_credentials SET access_token = ?, refresh_token = ?, expires_at = ?,
         account_id = COALESCE(?, account_id), updated_at = ? WHERE id = ?`,
      [tokens.accessToken, tokens.refreshToken, tokens.expiresAt.getTime(), tokens.accountId, now.getTime(), id],
    );
  }

  touch(id: string, now = new Date()): void {
    this.db.run("UPDATE subscription_credentials SET last_used_at = ? WHERE id = ?", [now.getTime(), id]);
  }

  /** An empty label clears it. Null when the subscription is not connected. */
  rename(name: string, label: string | null, now = new Date()): SubscriptionCredential | null {
    const normalized = label?.trim() || null;
    if (normalized !== null && normalized.length > 120) {
      throw new RangeError("Subscription name must be at most 120 characters.");
    }
    const credential = this.getByName(name);
    if (credential === null) return null;
    this.db.run("UPDATE subscription_credentials SET label = ?, updated_at = ? WHERE id = ?", [
      normalized,
      now.getTime(),
      credential.id,
    ]);
    return this.get(credential.id);
  }

  /** Remove a subscription. Returns what was removed, or null when it was not connected. */
  disconnect(name: string): SubscriptionCredential | null {
    const credential = this.getByName(name);
    if (credential === null) return null;
    this.db.run("DELETE FROM subscription_credentials WHERE id = ?", [credential.id]);
    return credential;
  }

  /**
   * Hold an exhausted subscription until its reset. A hold only grows: a later
   * report with an earlier reset never shortens a longer one. Returns whether
   * a subscription for the same provider is available now.
   */
  markUnavailable(id: string, until: Date, reason: string, now = new Date()): boolean {
    const credential = this.get(id);
    if (credential === null) return false;
    if (!isHeld(credential, now) || until > credential.unavailableUntil!) {
      this.db.run(
        "UPDATE subscription_credentials SET unavailable_until = ?, unavailable_reason = ?, updated_at = ? WHERE id = ?",
        [until.getTime(), reason, now.getTime(), id],
      );
    }
    return this.activeCredential(credential.provider, now) !== null;
  }

  /** Clear a usage-limit hold. Null when the subscription is not connected. */
  markAvailable(name: string, now = new Date()): SubscriptionCredential | null {
    const credential = this.getByName(name);
    if (credential === null) return null;
    this.db.run(
      "UPDATE subscription_credentials SET unavailable_until = NULL, unavailable_reason = NULL, updated_at = ? WHERE id = ?",
      [now.getTime(), credential.id],
    );
    return this.get(credential.id);
  }

  createSession(
    session: Omit<PendingOAuthSession, "token">,
    now = new Date(),
  ): PendingOAuthSession {
    const token = randomBytes(32).toString("base64url");
    this.db.run("DELETE FROM subscription_oauth_sessions WHERE expires_at <= ?", [now.getTime()]);
    this.db.run(
      "INSERT INTO subscription_oauth_sessions (token, provider, flow_json, credential_name, expires_at) VALUES (?, ?, ?, ?, ?)",
      [token, session.provider, JSON.stringify(session.flow), session.credentialName, session.expiresAt.getTime()],
    );
    return { token, ...session };
  }

  /** A pending session, including an expired one so callers can say it expired. */
  getSession(token: string): PendingOAuthSession | null {
    const row = this.db
      .query<SessionRow, [string]>("SELECT * FROM subscription_oauth_sessions WHERE token = ?")
      .get(token);
    if (row === null) return null;
    return {
      token: row.token,
      provider: row.provider,
      flow: JSON.parse(row.flow_json) as Record<string, string>,
      credentialName: row.credential_name,
      expiresAt: new Date(row.expires_at),
    };
  }

  deleteSession(token: string): void {
    this.db.run("DELETE FROM subscription_oauth_sessions WHERE token = ?", [token]);
  }

  private freeName(base: string): string {
    let name = base;
    for (let index = 2; this.getByName(name) !== null; index += 1) name = `${base}_${index}`;
    return name;
  }
}

export function isHeld(credential: SubscriptionCredential, now: Date): boolean {
  return credential.unavailableUntil !== null && credential.unavailableUntil > now;
}

/** Subscription names are env-var-style identifiers; matching is case-insensitive. */
export function normalizeName(name: string): string {
  return name.trim().toUpperCase();
}

function credentialFromRow(row: CredentialRow): SubscriptionCredential {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    label: row.label,
    accountEmail: row.account_email,
    accountId: row.account_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: new Date(row.expires_at),
    unavailableUntil: row.unavailable_until === null ? null : new Date(row.unavailable_until),
    unavailableReason: row.unavailable_reason,
    position: row.position,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at),
  };
}
