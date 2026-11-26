/**
 * SQLite storage for personal subscription credentials, the conversations
 * each one serves, and pending OAuth flows.
 *
 * With an encryption key (see secret_box.ts) tokens and pending sign-ins are
 * encrypted in the gateway's database file, each bound to its own row.
 * Without one they are PLAINTEXT there: anyone who can read that file can use
 * the connected subscriptions until the provider revokes them, so keep the
 * file on storage only the gateway's operator can read, and treat backups of
 * it as secrets.
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
 * stops counting once its window resets. A model hold (one model at its own
 * limit) leaves the subscription serving its other models.
 */
import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";

import { subscriptionUsageFromWindows, type SubscriptionUsage } from "../../providers/subscription_limits.js";
import { type SecretBox, openWithoutKey } from "../secret_box.js";
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
  // The Dari Link user who connected the plan on the approval page; null for
  // the gateway owner's own plans, which alone serve the gateway's keys.
  owner: string | null;
  // Kept off hosted Dari: a gateway connected to it neither serves nor
  // reports the plan.
  private: boolean;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  unavailableUntil: Date | null;
  unavailableReason: string | null;
  // Models at their own usage limit on this plan, including expired holds.
  modelHolds: SubscriptionModelHold[];
  // The last usage a response reported, and when.
  usage: (SubscriptionUsage & { observedAt: Date }) | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
};

export type SubscriptionModelHold = {
  model: string;
  until: Date;
  reason: string;
};

export type PendingOAuthSession = {
  token: string;
  provider: SubscriptionProvider;
  flow: Record<string, string>;
  // The subscription this flow reconnects; null connects another one.
  credentialName: string | null;
  // The Dari Link user connecting the plan; null for the gateway owner.
  owner: string | null;
  // Whether the plan connects as private (see SubscriptionCredential).
  private: boolean;
  // The plan on hosted Dari this sign-in moves here, by name: its account is
  // not a second copy, since the caller disconnects it there next.
  movingFrom: string | null;
  expiresAt: Date;
};

/** The parts of a plan that say which provider account it is. */
export type AccountRef = {
  provider: SubscriptionProvider;
  accountId: string | null;
  accountEmail: string | null;
};

/**
 * A plan of the same user that already holds an account, wherever it lives.
 * `name` is the plan's handle where it is known; `gatewayName` names the other
 * computer for an `other_computer` plan.
 */
export type ConnectedAccount = AccountRef & {
  place: "dari" | "this_computer" | "private" | "other_computer";
  name: string | null;
  gatewayName: string | null;
};

/** Connecting an account the same user already has connected; the message says where it lives and how to move it. */
export class SubscriptionAccountConnectedError extends Error {}

/**
 * Whether two plans are the same provider account: by account id when both
 * carry one, otherwise by email (Claude Code sign-ins carry only an email).
 */
export function sameConnectedAccount(a: AccountRef, b: AccountRef): boolean {
  if (a.provider !== b.provider) return false;
  if (a.accountId !== null && b.accountId !== null) return a.accountId === b.accountId;
  return a.accountEmail !== null && b.accountEmail !== null
    && a.accountEmail.toLowerCase() === b.accountEmail.toLowerCase();
}

const PROVIDER_LABELS: Record<SubscriptionProvider, string> = {
  anthropic_claude_code: "Claude",
  openai_codex: "ChatGPT",
  meta_muse: "Muse Code",
  opencode_go: "OpenCode Go",
  xai_grok: "Grok",
  vercel_token_pass: "Vercel Token Pass",
};

function connectedAccountMessage(account: ConnectedAccount): string {
  const label = PROVIDER_LABELS[account.provider];
  const handle = account.name ?? "NAME";
  const asName = account.name === null ? "" : ` as ${handle}`;
  switch (account.place) {
    case "dari":
      return `This ${label} account is already connected on Dari${asName}. Move it with \`dari accounts subscription move ${handle} --on computer\`, or disconnect it first.`;
    case "this_computer":
      return `This ${label} account is already connected on This Computer${asName}. Move it with \`dari accounts subscription move ${handle} --on dari\`, or disconnect it first.`;
    case "private":
      return `This ${label} account is already connected Private on This Computer${asName}. Move it with \`dari accounts subscription move ${handle} --on dari\` or \`--on computer\`, or disconnect it first.`;
    case "other_computer":
      return `This ${label} account is already connected on another computer${account.gatewayName ? ` (${account.gatewayName})` : ""}. Disconnect it there, or move it to Dari there with \`dari accounts subscription move\`.`;
  }
}

const BASE_NAMES: Record<SubscriptionProvider, string> = {
  anthropic_claude_code: "ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN",
  openai_codex: "OPENAI_CODEX_OAUTH_TOKEN",
  meta_muse: "META_MUSE_OAUTH_TOKEN",
  opencode_go: "OPENCODE_GO_OAUTH_TOKEN",
  xai_grok: "XAI_GROK_OAUTH_TOKEN",
  vercel_token_pass: "VERCEL_TOKEN_PASS_API_KEY",
};

type CredentialRow = {
  id: string;
  provider: SubscriptionProvider;
  name: string;
  label: string | null;
  account_email: string | null;
  account_id: string | null;
  owner: string | null;
  private: number | null;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  unavailable_until: number | null;
  unavailable_reason: string | null;
  usage_utilization: number | null;
  usage_resets_at: number | null;
  usage_observed_at: number | null;
  usage_windows: string | null;
  model_holds: string | null;
  position: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
};

// Columns added after the table first shipped; existing databases gain them
// on open.
const ADDED_COLUMNS = {
  usage_utilization: "REAL",
  usage_resets_at: "INTEGER",
  usage_observed_at: "INTEGER",
  usage_windows: "TEXT",
  model_holds: "TEXT",
  owner: "TEXT",
  private: "INTEGER",
  auto_redeem_resets: "INTEGER", // no longer read; resets follow each model's sources
} as const;

type SessionRow = {
  token: string;
  provider: SubscriptionProvider;
  flow_json: string;
  credential_name: string | null;
  owner: string | null;
  private: number | null;
  moving_from: string | null;
  expires_at: number;
};

export class SubscriptionStore {
  /**
   * Told of each change hosted Dari's copy of the plans would show: `plans`
   * for a plan connected, removed, renamed, moved, held, or released, and
   * `usage` for reported usage or use.
   */
  onChange: ((change: "plans" | "usage") => void) | undefined;

  /**
   * `privatePlansServe: false` (a gateway connected to hosted Dari) leaves
   * private plans out of routing and `list`; `list(provider, true)` still
   * shows them.
   */
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox | null = null,
    private readonly options: { privatePlansServe?: boolean } = {},
  ) {
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
      model_holds TEXT,
      owner TEXT,
      private INTEGER,
      auto_redeem_resets INTEGER,
      position INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    )`);
    const columns = new Set(
      db.query<{ name: string }, []>("PRAGMA table_info(subscription_credentials)").all().map((column) => column.name),
    );
    for (const [column, type] of Object.entries(ADDED_COLUMNS)) {
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
      owner TEXT,
      private INTEGER,
      moving_from TEXT,
      expires_at INTEGER NOT NULL
    )`);
    const sessionColumns = new Set(
      db.query<{ name: string }, []>("PRAGMA table_info(subscription_oauth_sessions)").all().map((column) => column.name),
    );
    for (const [column, type] of [["owner", "TEXT"], ["private", "INTEGER"], ["moving_from", "TEXT"]] as const) {
      if (!sessionColumns.has(column)) db.run(`ALTER TABLE subscription_oauth_sessions ADD COLUMN ${column} ${type}`);
    }
    this.encryptStored();
  }

  /** Whether stored tokens are encrypted. */
  get encrypted(): boolean {
    return this.box !== null;
  }

  // Seal what was stored before encryption was turned on, or under a key that
  // no longer encrypts.
  private encryptStored(): void {
    const box = this.box;
    if (box === null) return;
    this.db.transaction(() => {
      const credentials = this.db
        .query<Pick<CredentialRow, "id" | "access_token" | "refresh_token">, []>(
          "SELECT id, access_token, refresh_token FROM subscription_credentials",
        )
        .all();
      for (const row of credentials) {
        if (box.current(row.access_token) && box.current(row.refresh_token)) continue;
        this.db.run("UPDATE subscription_credentials SET access_token = ?, refresh_token = ? WHERE id = ?", [
          box.seal(box.adopt(row.access_token, tokenPlace(row.id, "access_token")), tokenPlace(row.id, "access_token")),
          box.seal(box.adopt(row.refresh_token, tokenPlace(row.id, "refresh_token")), tokenPlace(row.id, "refresh_token")),
          row.id,
        ]);
      }
      const sessions = this.db
        .query<Pick<SessionRow, "token" | "flow_json">, []>("SELECT token, flow_json FROM subscription_oauth_sessions")
        .all();
      for (const row of sessions) {
        if (box.current(row.flow_json)) continue;
        this.db.run("UPDATE subscription_oauth_sessions SET flow_json = ? WHERE token = ?", [
          box.seal(box.adopt(row.flow_json, flowPlace(row.token)), flowPlace(row.token)),
          row.token,
        ]);
      }
    })();
  }

  private seal(value: string, place: string): string {
    return this.box === null ? value : this.box.seal(value, place);
  }

  private open(stored: string, place: string): string {
    return this.box === null ? openWithoutKey(stored) : this.box.open(stored, place);
  }

  private credential(row: CredentialRow): SubscriptionCredential {
    return credentialFromRow({
      ...row,
      access_token: this.open(row.access_token, tokenPlace(row.id, "access_token")),
      refresh_token: this.open(row.refresh_token, tokenPlace(row.id, "refresh_token")),
    });
  }

  /**
   * The gateway owner's subscriptions that serve, grouped by provider, in
   * connection order; with `includePrivate`, private ones too even where they
   * do not serve.
   */
  list(provider?: SubscriptionProvider, includePrivate = false): SubscriptionCredential[] {
    const privateShown = includePrivate || this.options.privatePlansServe !== false;
    return this.every(provider).filter((credential) => credential.owner === null && (privateShown || !credential.private));
  }

  /** The subscriptions a Dari Link user connected. */
  owned(owner: string): SubscriptionCredential[] {
    return this.every().filter((credential) => credential.owner === owner);
  }

  /** The subscriptions with these ids, whoever connected them. */
  withIds(ids: ReadonlySet<string>, provider?: SubscriptionProvider): SubscriptionCredential[] {
    return this.every(provider).filter((credential) => ids.has(credential.id));
  }

  private every(provider?: SubscriptionProvider): SubscriptionCredential[] {
    const rows = provider === undefined
      ? this.db.query<CredentialRow, []>("SELECT * FROM subscription_credentials ORDER BY provider, position").all()
      : this.db
        .query<CredentialRow, [string]>("SELECT * FROM subscription_credentials WHERE provider = ? ORDER BY position")
        .all(provider);
    return rows.map((row) => this.credential(row));
  }

  get(id: string): SubscriptionCredential | null {
    const row = this.db.query<CredentialRow, [string]>("SELECT * FROM subscription_credentials WHERE id = ?").get(id);
    return row === null ? null : this.credential(row);
  }

  /**
   * The gateway owner's subscription by name, or a Dari Link user's with
   * `owner`: the owner's endpoints never reach a Link user's plan.
   */
  getByName(name: string, owner: string | null = null): SubscriptionCredential | null {
    const row = this.db
      .query<CredentialRow, [string, string | null]>("SELECT * FROM subscription_credentials WHERE name = ? AND owner IS ?")
      .get(normalizeName(name), owner);
    return row === null ? null : this.credential(row);
  }

  /**
   * The subscription a request without a conversation would use now, or null
   * when none is connected or every one is held: one of the gateway owner's,
   * or with `only` one of those subscription ids, as for a Dari Link grant.
   */
  activeCredential(
    provider: SubscriptionProvider,
    now = new Date(),
    only?: ReadonlySet<string>,
  ): SubscriptionCredential | null {
    return this.selectCredential(provider, undefined, now, only);
  }

  /**
   * The subscription that serves a conversation's next turn (see the module
   * comment), or null when none is connected or every one is held. A
   * conversation is remembered on the subscription chosen for it. The choice
   * is among the gateway owner's, or with `only` among those subscription ids,
   * as for a Dari Link grant.
   */
  selectCredential(
    provider: SubscriptionProvider,
    conversationId: string | undefined,
    now = new Date(),
    only?: ReadonlySet<string>,
    model?: string,
  ): SubscriptionCredential | null {
    const all = only === undefined ? this.list(provider) : this.withIds(only, provider);
    const available = all.filter((credential) => !isHeld(credential, now)
      && (model === undefined || !activeModelHolds(credential, now).some((hold) => hold.model === model)));
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
    if (conversationId !== undefined && model === undefined) this.pinConversation(conversationId, provider, chosen.id, now);
    return chosen;
  }

  /** Record the usage a response reported for a subscription. */
  recordUsage(id: string, usage: SubscriptionUsage, now = new Date()): void {
    if (usage.windows.length > 0) {
      // Responses may omit meters belonging to another model family. Only
      // replace matching windows, including explicit resets, and age out the rest.
      const previous = this.get(id)?.usage?.windows ?? [];
      const windows = [...previous.filter((old) => !usage.windows.some((window) =>
        window.minutes === old.minutes && window.modelFamily === old.modelFamily,
      )), ...usage.windows];
      usage = subscriptionUsageFromWindows(windows.map((window) => ({ ...window, used: window.utilization })), now) ?? usage;
    }
    this.db.run(
      `UPDATE subscription_credentials SET usage_utilization = ?, usage_resets_at = ?, usage_observed_at = ?,
         usage_windows = ? WHERE id = ?`,
      [usage.utilization, usage.resetsAt.getTime(), now.getTime(), windowsJson(usage), id],
    );
    this.onChange?.("usage");
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
   * subscription (null when it is not connected) and keeps its place, as long
   * as it is still the same account. Otherwise the sign-in is connected last
   * in order under the first free name. A sign-in refused as a second copy
   * throws `SubscriptionAccountConnectedError`: the same account is already
   * connected for this owner (`owner` is the Dari Link user connecting it;
   * null is the gateway owner), or `elsewhere` (the owner's plans on hosted
   * Dari and other computers) holds it.
   */
  connect(
    tokens: OAuthTokens,
    reconnectName: string | null,
    now = new Date(),
    owner: string | null = null,
    isPrivate = false,
    elsewhere: ConnectedAccount[] = [],
  ): SubscriptionCredential | null {
    const connected = this.db.transaction(() => {
      const existing = reconnectName !== null ? this.getByName(reconnectName, owner ?? null) : null;
      if (reconnectName !== null && existing?.provider !== tokens.provider) return null;

      if (existing !== null) {
        // Another account must not inherit the previous account's holds,
        // reported usage, or conversations (whose cache is the previous
        // account's). Reconnecting the same account keeps them.
        const sameAccount = sameConnectedAccount(existing, tokens);
        if (!sameAccount) this.refuseSecondCopy(tokens, owner ?? null, existing.id, elsewhere);
        const usage = sameAccount ? existing.usage : null;
        this.db.run(
          `UPDATE subscription_credentials SET access_token = ?, refresh_token = ?, expires_at = ?,
             account_id = ?, account_email = ?, unavailable_until = ?, unavailable_reason = ?,
             usage_utilization = ?, usage_resets_at = ?, usage_observed_at = ?, usage_windows = ?, model_holds = ?,
             private = ?, updated_at = ?
           WHERE id = ?`,
          [
            this.seal(tokens.accessToken, tokenPlace(existing.id, "access_token")),
            this.seal(tokens.refreshToken, tokenPlace(existing.id, "refresh_token")),
            tokens.expiresAt.getTime(),
            tokens.accountId,
            tokens.accountEmail,
            sameAccount ? existing.unavailableUntil?.getTime() ?? null : null,
            sameAccount ? existing.unavailableReason : null,
            usage?.utilization ?? null,
            usage?.resetsAt.getTime() ?? null,
            usage?.observedAt.getTime() ?? null,
            usage === null ? null : windowsJson(usage),
            sameAccount ? modelHoldsJson(existing.modelHolds) : null,
            isPrivate ? 1 : 0,
            now.getTime(),
            existing.id,
          ],
        );
        if (!sameAccount) {
          this.db.run("DELETE FROM subscription_conversation_pins WHERE credential_id = ?", [existing.id]);
        }
        return this.get(existing.id);
      }

      this.refuseSecondCopy(tokens, owner ?? null, null, elsewhere);
      const id = `cred_${randomUUID().replaceAll("-", "")}`;
      const position = this.db
        .query<{ next: number }, []>("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM subscription_credentials")
        .get()!.next;
      this.db.run(
        `INSERT INTO subscription_credentials (id, provider, name, account_email, account_id, owner, private,
           access_token, refresh_token, expires_at, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          tokens.provider,
          this.freeName(BASE_NAMES[tokens.provider]),
          tokens.accountEmail,
          tokens.accountId,
          owner,
          isPrivate ? 1 : 0,
          this.seal(tokens.accessToken, tokenPlace(id, "access_token")),
          this.seal(tokens.refreshToken, tokenPlace(id, "refresh_token")),
          tokens.expiresAt.getTime(),
          position,
          now.getTime(),
          now.getTime(),
        ],
      );
      return this.get(id);
    })();
    if (connected !== null) this.onChange?.("plans");
    return connected;
  }

  // Throws when the owner's other plans, or `elsewhere`, already hold this
  // account. `exceptId` is the plan being reconnected, which may not be a copy.
  private refuseSecondCopy(tokens: AccountRef, owner: string | null, exceptId: string | null, elsewhere: ConnectedAccount[]): void {
    const local = this.every(tokens.provider).find((credential) =>
      credential.owner === owner && credential.id !== exceptId && sameConnectedAccount(credential, tokens));
    if (local !== undefined) {
      throw new SubscriptionAccountConnectedError(connectedAccountMessage({
        provider: local.provider,
        accountId: local.accountId,
        accountEmail: local.accountEmail,
        place: local.private ? "private" : "this_computer",
        name: local.name,
        gatewayName: null,
      }));
    }
    const other = elsewhere.find((account) => sameConnectedAccount(account, tokens));
    if (other !== undefined) throw new SubscriptionAccountConnectedError(connectedAccountMessage(other));
  }

  /** Persist refreshed tokens. Keeps the stored account id when the refresh carries none. */
  updateTokens(id: string, tokens: OAuthTokens, now = new Date()): void {
    this.db.run(
      `UPDATE subscription_credentials SET access_token = ?, refresh_token = ?, expires_at = ?,
         account_id = COALESCE(?, account_id), updated_at = ? WHERE id = ?`,
      [
        this.seal(tokens.accessToken, tokenPlace(id, "access_token")),
        this.seal(tokens.refreshToken, tokenPlace(id, "refresh_token")),
        tokens.expiresAt.getTime(),
        tokens.accountId,
        now.getTime(),
        id,
      ],
    );
  }

  touch(id: string, now = new Date()): void {
    this.db.run("UPDATE subscription_credentials SET last_used_at = ? WHERE id = ?", [now.getTime(), id]);
    this.onChange?.("usage");
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
    this.onChange?.("plans");
    return this.get(credential.id);
  }

  /** Make the gateway owner's subscription private, or not. Null when it is not connected. */
  setPrivate(name: string, isPrivate: boolean, now = new Date()): SubscriptionCredential | null {
    const credential = this.getByName(name);
    if (credential === null) return null;
    this.db.run("UPDATE subscription_credentials SET private = ?, updated_at = ? WHERE id = ?", [
      isPrivate ? 1 : 0,
      now.getTime(),
      credential.id,
    ]);
    this.onChange?.("plans");
    return this.get(credential.id);
  }

  /** Remove a subscription. Returns what was removed, or null when it was not connected. */
  disconnect(name: string, owner: string | null = null): SubscriptionCredential | null {
    const credential = this.getByName(name, owner);
    if (credential === null) return null;
    this.db.run("DELETE FROM subscription_credentials WHERE id = ?", [credential.id]);
    this.db.run("DELETE FROM subscription_conversation_pins WHERE credential_id = ?", [credential.id]);
    this.onChange?.("plans");
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
      this.onChange?.("plans");
    }
    return this.activeCredential(credential.provider, now) !== null;
  }

  /**
   * Hold one model at its own usage limit on a subscription, which keeps
   * serving its other models. A hold only grows, like the plan's. Returns
   * whether the subscription is connected.
   */
  holdModel(id: string, model: string, until: Date, reason: string, now = new Date()): boolean {
    const credential = this.get(id);
    if (credential === null) return false;
    const current = activeModelHolds(credential, now);
    const existing = current.find((hold) => hold.model === model);
    if (existing === undefined || until > existing.until) {
      const holds = [...current.filter((hold) => hold.model !== model), { model, until, reason }];
      this.db.run("UPDATE subscription_credentials SET model_holds = ?, updated_at = ? WHERE id = ?", [
        modelHoldsJson(holds),
        now.getTime(),
        id,
      ]);
      this.onChange?.("plans");
    }
    return true;
  }

  /** Clear a subscription's usage-limit holds (a Dari Link user's with `owner`). Null when it is not connected. */
  markAvailable(name: string, now = new Date(), owner: string | null = null): SubscriptionCredential | null {
    const credential = this.getByName(name, owner);
    if (credential === null) return null;
    this.db.run(
      `UPDATE subscription_credentials SET unavailable_until = NULL, unavailable_reason = NULL, model_holds = NULL,
         updated_at = ? WHERE id = ?`,
      [now.getTime(), credential.id],
    );
    this.onChange?.("plans");
    return this.get(credential.id);
  }

  createSession(
    session: Omit<PendingOAuthSession, "token">,
    now = new Date(),
  ): PendingOAuthSession {
    const token = randomBytes(32).toString("base64url");
    this.db.run("DELETE FROM subscription_oauth_sessions WHERE expires_at <= ?", [now.getTime()]);
    this.db.run(
      `INSERT INTO subscription_oauth_sessions (token, provider, flow_json, credential_name, owner, private, moving_from, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        token,
        session.provider,
        this.seal(JSON.stringify(session.flow), flowPlace(token)),
        session.credentialName,
        session.owner,
        session.private ? 1 : 0,
        session.movingFrom,
        session.expiresAt.getTime(),
      ],
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
      flow: JSON.parse(this.open(row.flow_json, flowPlace(row.token))) as Record<string, string>,
      credentialName: row.credential_name,
      owner: row.owner,
      private: row.private === 1,
      movingFrom: row.moving_from,
      expiresAt: new Date(row.expires_at),
    };
  }

  deleteSession(token: string): void {
    this.db.run("DELETE FROM subscription_oauth_sessions WHERE token = ?", [token]);
  }

  private freeName(base: string): string {
    let name = base;
    const taken = (candidate: string) =>
      this.db.query("SELECT 1 FROM subscription_credentials WHERE name = ?").get(normalizeName(candidate)) !== null;
    for (let index = 2; taken(name); index += 1) name = `${base}_${index}`;
    return name;
  }
}

export function isHeld(credential: SubscriptionCredential, now: Date): boolean {
  return credential.unavailableUntil !== null && credential.unavailableUntil > now;
}

/** The models held at their own limit on a subscription now, by model. */
export function activeModelHolds(credential: SubscriptionCredential, now: Date): SubscriptionModelHold[] {
  return credential.modelHolds
    .filter((hold) => hold.until > now)
    .sort((a, b) => a.model.localeCompare(b.model));
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
  return subscriptionUsageFromWindows(usage.windows.map((window) => ({ ...window, used: window.utilization })), now);
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
  const sharedReset = (credential: SubscriptionCredential): number => {
    const usage = currentUsage(credential, now);
    if (usage === null) return Infinity;
    if (usage.windows.length === 0) return usage.resetsAt.getTime();
    const binding = usage.windows.filter((window) => window.modelFamily === undefined)
      .reduce<SubscriptionUsage["windows"][number] | null>(
        (most, window) => most === null || window.utilization > most.utilization ? window : most, null,
      );
    return binding?.resetsAt.getTime() ?? Infinity;
  };
  return (a: SubscriptionCredential, b: SubscriptionCredential): number => {
    const resetA = sharedReset(a);
    const resetB = sharedReset(b);
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

// Where a stored secret belongs, which its encryption is bound to.
function tokenPlace(id: string, column: "access_token" | "refresh_token"): string {
  return `subscription_credentials:${id}:${column}`;
}

function flowPlace(token: string): string {
  return `subscription_oauth_sessions:${token}:flow_json`;
}

function credentialFromRow(row: CredentialRow): SubscriptionCredential {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    label: row.label,
    accountEmail: row.account_email,
    accountId: row.account_id,
    owner: row.owner,
    private: row.private === 1,
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
    modelHolds: parseModelHolds(row.model_holds),
    position: row.position,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at),
  };
}

function windowsJson(usage: SubscriptionUsage): string {
  return JSON.stringify(usage.windows.map((window) => ({ ...window, resetsAt: window.resetsAt.getTime() })));
}

function modelHoldsJson(holds: SubscriptionModelHold[]): string | null {
  if (holds.length === 0) return null;
  return JSON.stringify(holds.map((hold) => ({ ...hold, until: hold.until.getTime() })));
}

function parseModelHolds(value: string | null): SubscriptionModelHold[] {
  if (value === null) return [];
  return (JSON.parse(value) as Array<{ model: string; until: number; reason: string }>)
    .map((hold) => ({ ...hold, until: new Date(hold.until) }));
}

// Rows recorded before windows were stored have none.
function parseWindows(value: string | null): SubscriptionUsage["windows"] {
  if (value === null) return [];
  return (JSON.parse(value) as Array<Omit<SubscriptionUsage["windows"][number], "resetsAt"> & { resetsAt: number }>)
    .map((window) => ({ ...window, resetsAt: new Date(window.resetsAt) }));
}
