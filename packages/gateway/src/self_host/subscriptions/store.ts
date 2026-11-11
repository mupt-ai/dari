/**
 * SQLite storage for personal subscription credentials, the conversations
 * each one serves, and pending OAuth flows.
 *
 * Tokens are stored as PLAINTEXT in the gateway's own database file. Anyone
 * who can read that file can use the connected subscriptions until the
 * provider revokes them, so keep the file on storage only the gateway's
 * operator can read, and treat backups of it as secrets.
 *
 * Choosing a subscription (`selectCredential`), for each provider:
 * - A conversation stays on the subscription it started on, so its prompt
 *   cache stays warm, until that subscription is held or reports at least
 *   SWITCH_AT_UTILIZATION of a window used.
 * - Otherwise it moves to the subscription with headroom whose reported
 *   usage resets soonest, so quota about to reset is spent before fresh
 *   quota. Ties go to the subscription used last, whose cached system prompt
 *   new conversations share, then onward from it in connection order
 *   (`position`). A request with no conversation stays on the subscription
 *   used last.
 * - When every subscription is past the threshold, the least used serves.
 * A hold ends on its own once `unavailable_until` passes; reported usage
 * stops counting once its window resets.
 */
import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";

import type { SubscriptionUsage } from "../../providers/subscription_limits.js";
import type { OAuthTokens, SubscriptionProvider } from "./oauth.js";

// The share of a usage window past which conversations leave a subscription
// at their next turn, before the provider starts refusing requests.
export const SWITCH_AT_UTILIZATION = 0.95;

// A conversation idle this long is forgotten; its next turn starts over.
const CONVERSATION_PIN_TTL_MS = 7 * 24 * 60 * 60_000;

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
  // The last usage a response reported, and when.
  usage: (SubscriptionUsage & { observedAt: Date }) | null;
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
  usage_utilization: number | null;
  usage_resets_at: number | null;
  usage_observed_at: number | null;
  usage_windows: string | null;
  position: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
};

// Usage columns added after the table first shipped; existing databases gain
// them on open.
const USAGE_COLUMNS = {
  usage_utilization: "REAL",
  usage_resets_at: "INTEGER",
  usage_observed_at: "INTEGER",
  usage_windows: "TEXT",
} as const;

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
      usage_utilization REAL,
      usage_resets_at INTEGER,
      usage_observed_at INTEGER,
      usage_windows TEXT,
      position INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    )`);
    const columns = new Set(
      db.query<{ name: string }, []>("PRAGMA table_info(subscription_credentials)").all().map((column) => column.name),
    );
    for (const [column, type] of Object.entries(USAGE_COLUMNS)) {
      if (!columns.has(column)) db.run(`ALTER TABLE subscription_credentials ADD COLUMN ${column} ${type}`);
    }
    db.run(`CREATE TABLE IF NOT EXISTS subscription_conversation_pins (
      conversation_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      used_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, provider)
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

  /**
   * The subscription a request without a conversation would use now, or null
   * when none is connected or every one is held.
   */
  activeCredential(provider: SubscriptionProvider, now = new Date()): SubscriptionCredential | null {
    return this.selectCredential(provider, undefined, now);
  }

  /**
   * The subscription that serves a conversation's next turn (see the module
   * comment), or null when none is connected or every one is held. A
   * conversation is remembered on the subscription chosen for it.
   */
  selectCredential(
    provider: SubscriptionProvider,
    conversationId: string | undefined,
    now = new Date(),
  ): SubscriptionCredential | null {
    const all = this.list(provider);
    const available = all.filter((credential) => !isHeld(credential, now));
    if (available.length === 0) return null;
    const order = rotationFrom(all, lastUsed(all));
    const withHeadroom = available.filter((credential) => hasHeadroom(credential, now));

    const current = conversationId === undefined
      ? lastUsed(available)
      : this.pinnedCredential(conversationId, provider, available, now);
    let chosen = current !== null && withHeadroom.includes(current) ? current : null;
    if (chosen === null) {
      chosen = withHeadroom.length > 0
        ? [...withHeadroom].sort(soonestResetFirst(now, order))[0]!
        : [...available].sort(leastUsedFirst(now, order))[0]!;
    }
    if (conversationId !== undefined) this.pinConversation(conversationId, provider, chosen.id, now);
    return chosen;
  }

  /** Record the usage a response reported for a subscription. */
  recordUsage(id: string, usage: SubscriptionUsage, now = new Date()): void {
    this.db.run(
      `UPDATE subscription_credentials SET usage_utilization = ?, usage_resets_at = ?, usage_observed_at = ?,
         usage_windows = ? WHERE id = ?`,
      [usage.utilization, usage.resetsAt.getTime(), now.getTime(), windowsJson(usage), id],
    );
  }

  // A pin idle past CONVERSATION_PIN_TTL_MS is forgotten: the conversation is
  // assigned like a new one.
  private pinnedCredential(
    conversationId: string,
    provider: SubscriptionProvider,
    available: SubscriptionCredential[],
    now: Date,
  ): SubscriptionCredential | null {
    const row = this.db
      .query<{ credential_id: string }, [string, string, number]>(
        `SELECT credential_id FROM subscription_conversation_pins
         WHERE conversation_id = ? AND provider = ? AND used_at >= ?`,
      )
      .get(conversationId, provider, now.getTime() - CONVERSATION_PIN_TTL_MS);
    return available.find((credential) => credential.id === row?.credential_id) ?? null;
  }

  private pinConversation(conversationId: string, provider: SubscriptionProvider, credentialId: string, now: Date): void {
    this.db.run(
      `INSERT INTO subscription_conversation_pins (conversation_id, provider, credential_id, used_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (conversation_id, provider) DO UPDATE SET credential_id = excluded.credential_id, used_at = excluded.used_at`,
      [conversationId, provider, credentialId, now.getTime()],
    );
    this.db.run("DELETE FROM subscription_conversation_pins WHERE used_at < ?", [now.getTime() - CONVERSATION_PIN_TTL_MS]);
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
        // Another (or an unidentified) account must not inherit the previous
        // account's hold, reported usage, or conversations (whose cache is
        // the previous account's).
        const sameAccount = tokens.accountEmail !== null && tokens.accountEmail === existing.accountEmail;
        const usage = sameAccount ? existing.usage : null;
        this.db.run(
          `UPDATE subscription_credentials SET access_token = ?, refresh_token = ?, expires_at = ?,
             account_id = ?, account_email = ?, unavailable_until = ?, unavailable_reason = ?,
             usage_utilization = ?, usage_resets_at = ?, usage_observed_at = ?, usage_windows = ?, updated_at = ?
           WHERE id = ?`,
          [
            tokens.accessToken,
            tokens.refreshToken,
            tokens.expiresAt.getTime(),
            tokens.accountId,
            tokens.accountEmail,
            sameAccount ? existing.unavailableUntil?.getTime() ?? null : null,
            sameAccount ? existing.unavailableReason : null,
            usage?.utilization ?? null,
            usage?.resetsAt.getTime() ?? null,
            usage?.observedAt.getTime() ?? null,
            usage === null ? null : windowsJson(usage),
            now.getTime(),
            existing.id,
          ],
        );
        if (!sameAccount) {
          this.db.run("DELETE FROM subscription_conversation_pins WHERE credential_id = ?", [existing.id]);
        }
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
    this.db.run("DELETE FROM subscription_conversation_pins WHERE credential_id = ?", [credential.id]);
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

/** The usage a subscription last reported, while its window has not reset. */
/**
 * The last reported usage of every window that has not reset. A short window
 * resetting leaves the longer ones in force, so the binding window is the
 * most used of those still running.
 */
export function currentUsage(credential: SubscriptionCredential, now: Date): SubscriptionUsage | null {
  const usage = credential.usage;
  if (usage === null) return null;
  // Usage recorded before per-window reports has only the binding window.
  if (usage.windows.length === 0) return usage.resetsAt > now ? usage : null;
  const windows = usage.windows.filter((window) => window.resetsAt > now);
  if (windows.length === 0) return null;
  const binding = windows.reduce((a, b) => (b.utilization > a.utilization ? b : a));
  return { utilization: binding.utilization, resetsAt: binding.resetsAt, windows };
}

function hasHeadroom(credential: SubscriptionCredential, now: Date): boolean {
  return (currentUsage(credential, now)?.utilization ?? 0) < SWITCH_AT_UTILIZATION;
}

function lastUsed(credentials: SubscriptionCredential[]): SubscriptionCredential | null {
  let latest: SubscriptionCredential | null = null;
  for (const credential of credentials) {
    if (credential.lastUsedAt !== null && (latest === null || credential.lastUsedAt > latest.lastUsedAt!)) {
      latest = credential;
    }
  }
  return latest;
}

// Each credential's rank in connection order starting at `anchor` (the one
// used last), wrapping past the end; without an anchor, connection order.
function rotationFrom(all: SubscriptionCredential[], anchor: SubscriptionCredential | null): Map<string, number> {
  const start = anchor === null ? 0 : all.indexOf(anchor);
  return new Map(all.map((credential, index) => [credential.id, (index - start + all.length) % all.length]));
}

// Spend quota about to reset first; a subscription with no current usage
// report (fresh, or its window reset) comes after, then rotation order.
function soonestResetFirst(now: Date, order: Map<string, number>) {
  return (a: SubscriptionCredential, b: SubscriptionCredential): number => {
    const resetA = currentUsage(a, now)?.resetsAt.getTime() ?? Infinity;
    const resetB = currentUsage(b, now)?.resetsAt.getTime() ?? Infinity;
    return resetA - resetB || order.get(a.id)! - order.get(b.id)!;
  };
}

function leastUsedFirst(now: Date, order: Map<string, number>) {
  return (a: SubscriptionCredential, b: SubscriptionCredential): number =>
    (currentUsage(a, now)?.utilization ?? 0) - (currentUsage(b, now)?.utilization ?? 0)
    || order.get(a.id)! - order.get(b.id)!;
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
    usage: row.usage_utilization === null || row.usage_resets_at === null || row.usage_observed_at === null
      ? null
      : {
        utilization: row.usage_utilization,
        resetsAt: new Date(row.usage_resets_at),
        observedAt: new Date(row.usage_observed_at),
        windows: parseWindows(row.usage_windows),
      },
    position: row.position,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at),
  };
}

function windowsJson(usage: SubscriptionUsage): string {
  return JSON.stringify(usage.windows.map((window) => ({ ...window, resetsAt: window.resetsAt.getTime() })));
}

// Rows recorded before windows were stored have none.
function parseWindows(value: string | null): SubscriptionUsage["windows"] {
  if (value === null) return [];
  return (JSON.parse(value) as Array<{ minutes: number; utilization: number; resetsAt: number }>)
    .map((window) => ({ ...window, resetsAt: new Date(window.resetsAt) }));
}
