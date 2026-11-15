/**
 * SQLite storage for Dari Link: registered apps, the grants users approve for
 * them, and each grant's tokens. A grant names the subscriptions it may use.
 * Every token is its own row holding only the token's SHA-256, so an access
 * token lives until its own expiry whatever is issued after it; revoking the
 * grant stops them all at once.
 *
 * - access tokens last an hour.
 * - refresh tokens do not expire. A public client's rotates on use; a
 *   confidential client, which also proves its secret, keeps its own.
 * - child tokens serve one model, for up to twelve hours, and cannot refresh
 *   or mint.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { HttpError } from "../http/errors.js";
import { type SecretBox, openWithoutKey } from "./secret_box.js";
import type {
  LinkApp,
  LinkBudget,
  LinkChildToken,
  LinkGrant,
  LinkTokens,
  LinkUsage,
  LinkUsageQuery,
  LinkUsageTotals,
} from "../platform/platform.js";
import { LINK_ACCESS_TOKEN_PREFIX, LINK_CHILD_TOKEN_PREFIX } from "../protocol/input/router_model.js";
import { type BudgetCharge, type BudgetWindow, budgetCharges } from "../runtime/link_budget.js";

export const LINK_ACCESS_TOKEN_TTL_MS = 60 * 60_000;
const LINK_CODE_TTL_MS = 10 * 60_000;
// A rotated refresh token presented again this soon lost a race with its own
// rotation (two instances, or a retry after a lost response); later, it leaked.
export const LINK_REFRESH_RACE_MS = 60_000;
// Expired tokens are kept this long so they are told apart from unknown ones.
const LINK_TOKEN_RETENTION_MS = 24 * 60 * 60_000;

// Prefixes keep link tokens apart from gateway keys and from each other.
const REFRESH_TOKEN_PREFIX = "dlk_rt_";
const CODE_PREFIX = "dlk_code_";
const CLIENT_SECRET_PREFIX = "dlk_cs_";

export type LinkRevoker = "user" | "app" | "reuse_detected";

export type ActiveLinkGrant = {
  id: string;
  clientId: string;
  credentialIds: ReadonlySet<string>;
  // Set for a child token: the models it serves, each with its pinned thinking.
  pins?: LinkPin[];
  tags?: Record<string, string>;
};

/** What a presented link token is; null when it is not one this store issued. */
export type LinkPin = { model: string; thinking: string | null };

export type LinkTokenAuth =
  | { status: "active"; grant: ActiveLinkGrant }
  | { status: "expired" }
  | { status: "revoked"; revokedBy: string | null; revokedAt: string | null };

type AppRow = {
  client_id: string;
  name: string;
  redirect_uris: string;
  client_secret_hash: string | null;
};

type GrantRow = {
  id: string;
  client_id: string;
  credential_ids: string;
  code_challenge: string | null;
  redirect_uri: string | null;
  code_expires_at: number | null;
  created_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
  budget: string | null;
};

/** An API key a user added on the approval page, for one model provider or gateway. */
export type LinkApiKey = { id: string; subject: string; provider: string; apiKey: string };

type KeyRow = { id: string; subject: string; provider: string; api_key: string };

// Where a stored API key belongs, which its encryption is bound to.
function keyPlace(id: string): string {
  return `link_api_keys:${id}:api_key`;
}

type TokenRow = {
  kind: "access" | "refresh" | "child";
  expires_at: number | null;
  rotated_at: number | null;
  model: string | null;
  thinking: string | null;
  pins: string | null;
  tags: string | null;
  grant_id: string;
  client_id: string;
  credential_ids: string;
  revoked_at: number | null;
  revoked_by: string | null;
};

const TOKEN_WITH_GRANT = `SELECT link_tokens.kind, link_tokens.expires_at, link_tokens.rotated_at, link_tokens.model,
    link_tokens.thinking, link_tokens.pins, link_tokens.tags, link_grants.id AS grant_id, link_grants.client_id,
    link_grants.credential_ids, link_grants.revoked_at, link_grants.revoked_by
  FROM link_tokens JOIN link_grants ON link_grants.id = link_tokens.grant_id
  WHERE link_tokens.token_hash = ?`;

export class LinkStore {
  constructor(private readonly db: Database, private readonly box: SecretBox | null = null) {
    db.run(`CREATE TABLE IF NOT EXISTS link_apps (
      client_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      redirect_uris TEXT NOT NULL,
      client_secret_hash TEXT,
      created_at INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS link_grants (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES link_apps (client_id),
      credential_ids TEXT NOT NULL,
      code_hash TEXT UNIQUE,
      code_challenge TEXT,
      redirect_uri TEXT,
      code_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      revoked_by TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS link_tokens (
      token_hash TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES link_grants (id),
      kind TEXT NOT NULL,
      expires_at INTEGER,
      rotated_at INTEGER,
      model TEXT,
      thinking TEXT,
      tags TEXT,
      created_at INTEGER NOT NULL
    )`);
    db.run("CREATE INDEX IF NOT EXISTS link_tokens_grant_id ON link_tokens (grant_id)");
    db.run(`CREATE TABLE IF NOT EXISTS link_usage (
      request_id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES link_grants (id),
      received_at INTEGER NOT NULL,
      model TEXT,
      thinking TEXT,
      tags TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL
    )`);
    db.run("CREATE INDEX IF NOT EXISTS link_usage_grant_received ON link_usage (grant_id, received_at)");
    // Added after link_grants shipped: a gateway database from before gains it.
    const grantColumns = db.query<{ name: string }, []>("PRAGMA table_info(link_grants)").all();
    if (!grantColumns.some((column) => column.name === "budget")) db.run("ALTER TABLE link_grants ADD COLUMN budget TEXT");
    // The user who approved the grant on the approval page.
    if (!grantColumns.some((column) => column.name === "subject")) db.run("ALTER TABLE link_grants ADD COLUMN subject TEXT");
    const tokenColumns = db.query<{ name: string }, []>("PRAGMA table_info(link_tokens)").all();
    if (!tokenColumns.some((column) => column.name === "pins")) db.run("ALTER TABLE link_tokens ADD COLUMN pins TEXT");
    const usageColumns = db.query<{ name: string }, []>("PRAGMA table_info(link_usage)").all();
    if (!usageColumns.some((column) => column.name === "status")) db.run("ALTER TABLE link_usage ADD COLUMN status TEXT");
    // API keys users added on the approval page: one per user and provider.
    db.run(`CREATE TABLE IF NOT EXISTS link_api_keys (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      provider TEXT NOT NULL,
      api_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (subject, provider)
    )`);
    // The share of each quota window of a plan a grant was charged, by the
    // window's reset (see runtime/link_budget.ts).
    db.run(`CREATE TABLE IF NOT EXISTS link_budget_use (
      grant_id TEXT NOT NULL REFERENCES link_grants (id),
      credential_id TEXT NOT NULL,
      window_minutes INTEGER NOT NULL,
      resets_at INTEGER NOT NULL,
      share REAL NOT NULL,
      PRIMARY KEY (grant_id, credential_id, window_minutes, resets_at)
    )`);
    this.encryptStored();
  }

  // Seal API keys stored before encryption was turned on, or under a key
  // that no longer encrypts.
  private encryptStored(): void {
    const box = this.box;
    if (box === null) return;
    this.db.transaction(() => {
      for (const row of this.db.query<KeyRow, []>("SELECT * FROM link_api_keys").all()) {
        if (box.current(row.api_key)) continue;
        this.db.run("UPDATE link_api_keys SET api_key = ? WHERE id = ?", [
          box.seal(box.adopt(row.api_key, keyPlace(row.id)), keyPlace(row.id)),
          row.id,
        ]);
      }
    })();
  }

  private seal(value: string, place: string): string {
    return this.box === null ? value : this.box.seal(value, place);
  }

  private key(row: KeyRow): LinkApiKey {
    const stored = row.api_key;
    return {
      id: row.id,
      subject: row.subject,
      provider: row.provider,
      apiKey: this.box === null ? openWithoutKey(stored) : this.box.open(stored, keyPlace(row.id)),
    };
  }

  /** Store a user's API key for a provider, replacing their earlier one for it. */
  addKey(subject: string, provider: string, apiKey: string, now = new Date()): LinkApiKey {
    const existing = this.keys(subject).find((key) => key.provider === provider);
    if (existing !== undefined) {
      this.db.run("UPDATE link_api_keys SET api_key = ? WHERE id = ?", [this.seal(apiKey, keyPlace(existing.id)), existing.id]);
      return { ...existing, apiKey };
    }
    const id = `key_${randomUUID().replaceAll("-", "")}`;
    this.db.run(
      "INSERT INTO link_api_keys (id, subject, provider, api_key, created_at) VALUES (?, ?, ?, ?, ?)",
      [id, subject, provider, this.seal(apiKey, keyPlace(id)), now.getTime()],
    );
    return { id, subject, provider, apiKey };
  }

  /** Delete a user's API key; false when they have none by that id. */
  removeKey(subject: string, id: string): boolean {
    return this.db.run("DELETE FROM link_api_keys WHERE id = ? AND subject = ?", [id, subject]).changes > 0;
  }

  /**
   * Take a deleted plan or key out of every live grant; a grant left with
   * nothing is revoked as the user's doing.
   */
  dropCredential(credentialId: string, now = new Date()): void {
    this.db.transaction(() => {
      const grants = this.db
        .query<Pick<GrantRow, "id" | "credential_ids">, []>("SELECT id, credential_ids FROM link_grants WHERE revoked_at IS NULL")
        .all();
      for (const grant of grants) {
        const ids = parseIds(grant.credential_ids);
        if (!ids.includes(credentialId)) continue;
        const left = ids.filter((id) => id !== credentialId);
        if (left.length === 0) this.revoke(grant.id, "user", now);
        else this.db.run("UPDATE link_grants SET credential_ids = ? WHERE id = ?", [JSON.stringify(left), grant.id]);
      }
    })();
  }

  /** The API keys a user added, oldest first. */
  keys(subject: string): LinkApiKey[] {
    return this.db
      .query<KeyRow, [string]>("SELECT * FROM link_api_keys WHERE subject = ? ORDER BY created_at, rowid")
      .all(subject)
      .map((row) => this.key(row));
  }

  /** The API keys with these ids, whoever added them. */
  keysWithIds(ids: ReadonlySet<string>): LinkApiKey[] {
    return this.db
      .query<KeyRow, []>("SELECT * FROM link_api_keys ORDER BY created_at, rowid")
      .all()
      .filter((row) => ids.has(row.id))
      .map((row) => this.key(row));
  }

  /** A grant's budget; empty when it has none or is unknown. */
  budget(grantId: string): LinkBudget[] {
    const row = this.db.query<Pick<GrantRow, "budget">, [string]>("SELECT budget FROM link_grants WHERE id = ?").get(grantId);
    return parseBudget(row?.budget ?? null);
  }

  /** Replace a live grant's budget; false when none is live by that id. */
  setBudget(grantId: string, budget: LinkBudget[]): boolean {
    return this.db.run(
      "UPDATE link_grants SET budget = ? WHERE id = ? AND revoked_at IS NULL",
      [budget.length === 0 ? null : JSON.stringify(budget), grantId],
    ).changes > 0;
  }

  /**
   * Charge a grant for the rise in a plan's windows its request reported,
   * against what the plan reported before.
   */
  chargeBudget(grantId: string, credentialId: string, previous: BudgetWindow[], current: BudgetWindow[], now = new Date()): void {
    const charges = budgetCharges(previous, current);
    if (charges.length === 0) return;
    this.db.transaction(() => {
      this.db.run("DELETE FROM link_budget_use WHERE resets_at <= ?", [now.getTime()]);
      for (const charge of charges) {
        this.db.run(
          `INSERT INTO link_budget_use (grant_id, credential_id, window_minutes, resets_at, share) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (grant_id, credential_id, window_minutes, resets_at) DO UPDATE SET share = share + excluded.share`,
          [grantId, credentialId, charge.minutes, charge.resetsAt.getTime(), charge.share],
        );
      }
    })();
  }

  /** What a grant was charged on one plan in windows that have not reset. */
  budgetCharges(grantId: string, credentialId: string, now = new Date()): BudgetCharge[] {
    return this.db
      .query<{ window_minutes: number; resets_at: number; share: number }, [string, string, number]>(
        "SELECT window_minutes, resets_at, share FROM link_budget_use WHERE grant_id = ? AND credential_id = ? AND resets_at > ?",
      )
      .all(grantId, credentialId, now.getTime())
      .map((row) => ({ minutes: row.window_minutes, resetsAt: new Date(row.resets_at), share: row.share }));
  }

  /** Record what one of a grant's requests used; a repeated request id is ignored. */
  recordUsage(entry: LinkUsageEntry): void {
    this.db.run(
      `INSERT OR IGNORE INTO link_usage (request_id, grant_id, received_at, model, thinking, tags,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.requestId,
        entry.grantId,
        entry.receivedAt.getTime(),
        entry.model,
        entry.thinking,
        JSON.stringify(entry.tags),
        entry.inputTokens,
        entry.outputTokens,
        entry.cacheReadTokens,
        entry.cacheWriteTokens,
        entry.status,
      ],
    );
  }

  /** What a grant's requests used, filtered by tags and receive time. */
  usage(grantId: string, query: Omit<LinkUsageQuery, "accessToken">): Omit<LinkUsage, "completeThrough"> {
    const rows = query.requestId !== undefined
      ? this.db
        .query<UsageRow, [string, string]>("SELECT * FROM link_usage WHERE grant_id = ? AND request_id = ?")
        .all(grantId, query.requestId)
      : this.db
        .query<UsageRow, [string, number, number]>(
          `SELECT * FROM link_usage WHERE grant_id = ? AND received_at >= ? AND received_at < ?`,
        )
        .all(grantId, query.since?.getTime() ?? 0, query.until?.getTime() ?? Number.MAX_SAFE_INTEGER);
    const filters = Object.entries(query.tags);
    return summarizeLinkUsage(
      rows
        .map((row) => ({ row, tags: JSON.parse(row.tags) as Record<string, string> }))
        .filter(({ tags }) => filters.every(([key, value]) => tags[key] === value))
        .map(({ row, tags }) => ({
          model: row.model,
          thinking: row.thinking,
          tag: query.groupByTag === undefined ? null : tags[query.groupByTag] ?? null,
          failed: row.status === "provider_error" || row.status === "selector_error",
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          cacheReadTokens: row.cache_read_tokens,
          cacheWriteTokens: row.cache_write_tokens,
        })),
      query.groupByTag !== undefined,
    );
  }

  /** Register an app; a confidential one gets a secret, returned this once. */
  registerApp(
    name: string,
    redirectUris: string[],
    confidential = false,
    now = new Date(),
  ): LinkApp & { clientSecret?: string } {
    const clientId = `lnk_${randomUUID().replaceAll("-", "")}`;
    const clientSecret = confidential ? secret(CLIENT_SECRET_PREFIX) : undefined;
    this.db.run(
      "INSERT INTO link_apps (client_id, name, redirect_uris, client_secret_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      [clientId, name, JSON.stringify(redirectUris), clientSecret === undefined ? null : hash(clientSecret), now.getTime()],
    );
    return { clientId, name, redirectUris, confidential, ...(clientSecret === undefined ? {} : { clientSecret }) };
  }

  app(clientId: string): LinkApp | null {
    const row = this.db.query<AppRow, [string]>("SELECT * FROM link_apps WHERE client_id = ?").get(clientId);
    return row === null ? null : appFromRow(row);
  }

  /**
   * Create a grant awaiting its code exchange and return the code. With
   * `grantId` (update mode), change that live grant of the app's plans and
   * budget in place instead: its tokens keep working, and the code redeems
   * for more tokens of the same grant.
   */
  approve(
    request: {
      subject?: string;
      grantId?: string;
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
      credentialIds: string[];
      budget?: LinkBudget[];
    },
    now = new Date(),
  ): string {
    const app = this.app(request.clientId);
    if (app === null || !app.redirectUris.includes(request.redirectUri)) {
      throw new HttpError(400, "Unknown app or redirect URI.", "invalid_client");
    }
    const code = secret(CODE_PREFIX);
    const budget = request.budget === undefined || request.budget.length === 0 ? null : JSON.stringify(request.budget);
    if (request.grantId !== undefined) {
      const updated = this.db.run(
        `UPDATE link_grants SET credential_ids = ?, budget = ?, code_hash = ?, code_challenge = ?, redirect_uri = ?,
           code_expires_at = ?
         WHERE id = ? AND client_id = ? AND revoked_at IS NULL`,
        [
          JSON.stringify(request.credentialIds),
          budget,
          hash(code),
          request.codeChallenge,
          request.redirectUri,
          now.getTime() + LINK_CODE_TTL_MS,
          request.grantId,
          request.clientId,
        ],
      ).changes;
      if (updated === 0) throw new HttpError(400, "That connection no longer exists.", "invalid_request");
      return code;
    }
    this.db.run(
      `INSERT INTO link_grants (id, client_id, credential_ids, code_hash, code_challenge, redirect_uri,
         code_expires_at, created_at, budget, subject)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `lgr_${randomUUID().replaceAll("-", "")}`,
        request.clientId,
        JSON.stringify(request.credentialIds),
        hash(code),
        request.codeChallenge,
        request.redirectUri,
        now.getTime() + LINK_CODE_TTL_MS,
        now.getTime(),
        budget,
        request.subject ?? null,
      ],
    );
    return code;
  }

  /** Redeem a code once: the grant's first tokens. */
  exchangeCode(
    request: { clientId: string; clientSecret?: string; code: string; redirectUri: string; codeChallenge: string },
    now = new Date(),
  ): LinkTokens {
    this.authenticateClient(request.clientId, request.clientSecret);
    return this.db.transaction(() => {
      const row = this.db
        .query<GrantRow, [string]>("SELECT * FROM link_grants WHERE code_hash = ?")
        .get(hash(request.code));
      if (
        row === null
        || row.revoked_at !== null
        || row.client_id !== request.clientId
        || row.redirect_uri !== request.redirectUri
        || row.code_expires_at === null
        || row.code_expires_at <= now.getTime()
        || row.code_challenge !== request.codeChallenge
      ) {
        throw invalidGrant("The authorization code is invalid, expired, or already used.");
      }
      this.db.run(
        "UPDATE link_grants SET code_hash = NULL, code_challenge = NULL, code_expires_at = NULL WHERE id = ?",
        [row.id],
      );
      return {
        accessToken: this.issue(row.id, "access", now, now.getTime() + LINK_ACCESS_TOKEN_TTL_MS),
        refreshToken: this.issue(row.id, "refresh", now, null),
        expiresIn: LINK_ACCESS_TOKEN_TTL_MS / 1000,
      };
    })();
  }

  /**
   * A new access token for a grant. A public client's refresh token rotates;
   * a confidential client keeps the one it presented.
   */
  refresh(
    request: { clientId: string; clientSecret?: string; refreshToken: string },
    now = new Date(),
  ): LinkTokens {
    const app = this.authenticateClient(request.clientId, request.clientSecret);
    const presented = hash(request.refreshToken);
    // The refusal is thrown after the transaction, so a revoke in it holds.
    const result = this.db.transaction((): LinkTokens | "invalid" | "race" => {
      const row = this.db.query<TokenRow, [string]>(TOKEN_WITH_GRANT).get(presented);
      if (row === null || row.kind !== "refresh" || row.client_id !== request.clientId || row.revoked_at !== null) {
        return "invalid";
      }
      if (row.rotated_at !== null) {
        if (now.getTime() - row.rotated_at <= LINK_REFRESH_RACE_MS) return "race";
        // A rotated refresh token came back long after: it leaked.
        this.revoke(row.grant_id, "reuse_detected", now);
        return "invalid";
      }
      const accessToken = this.issue(row.grant_id, "access", now, now.getTime() + LINK_ACCESS_TOKEN_TTL_MS);
      if (app.confidential) {
        return { accessToken, refreshToken: request.refreshToken, expiresIn: LINK_ACCESS_TOKEN_TTL_MS / 1000 };
      }
      this.db.run("UPDATE link_tokens SET rotated_at = ? WHERE token_hash = ?", [now.getTime(), presented]);
      return {
        accessToken,
        refreshToken: this.issue(row.grant_id, "refresh", now, null),
        expiresIn: LINK_ACCESS_TOKEN_TTL_MS / 1000,
      };
    })();
    if (result === "race") {
      throw new HttpError(
        400,
        "This refresh token was just rotated by another request. Use the tokens that request received.",
        "refresh_race",
      );
    }
    if (result === "invalid") throw invalidGrant("The refresh token is invalid or revoked.");
    return result;
  }

  /** Mint a child token from the grant's access token. */
  exchangeToken(
    request: {
      clientId: string;
      clientSecret?: string;
      subjectToken: string;
      models: Array<{ model: string; thinking?: string }>;
      expiresIn: number;
      tags: Record<string, string>;
    },
    now = new Date(),
  ): LinkChildToken {
    this.authenticateClient(request.clientId, request.clientSecret);
    const subject = this.authenticate(request.subjectToken, now);
    if (
      subject?.status !== "active"
      || subject.grant.pins !== undefined
      || subject.grant.clientId !== request.clientId
    ) {
      throw invalidGrant("subject_token must be a live access token of this client's grant.");
    }
    const accessToken = this.issue(subject.grant.id, "child", now, now.getTime() + request.expiresIn * 1000, {
      pins: JSON.stringify(request.models.map((entry): LinkPin => ({ model: entry.model, thinking: entry.thinking ?? null }))),
      tags: Object.keys(request.tags).length === 0 ? null : JSON.stringify(request.tags),
    });
    return { accessToken, expiresIn: request.expiresIn, grantId: subject.grant.id };
  }

  /** What a presented access or child token is, or null when it is neither. */
  authenticate(token: string, now = new Date()): LinkTokenAuth | null {
    if (!token.startsWith(LINK_ACCESS_TOKEN_PREFIX) && !token.startsWith(LINK_CHILD_TOKEN_PREFIX)) return null;
    const row = this.db.query<TokenRow, [string]>(TOKEN_WITH_GRANT).get(hash(token));
    if (row === null || row.kind === "refresh") return null;
    if (row.revoked_at !== null) {
      return { status: "revoked", revokedBy: row.revoked_by, revokedAt: new Date(row.revoked_at).toISOString() };
    }
    if (row.expires_at === null || row.expires_at <= now.getTime()) return { status: "expired" };
    const pins = row.kind === "child" ? childPins(row) : undefined;
    // A child token that names no model serves nothing.
    if (pins?.length === 0) return null;
    return {
      status: "active",
      grant: {
        id: row.grant_id,
        clientId: row.client_id,
        credentialIds: new Set(parseIds(row.credential_ids)),
        ...(pins === undefined ? {} : { pins }),
        ...(row.tags === null ? {} : { tags: JSON.parse(row.tags) as Record<string, string> }),
      },
    };
  }

  /** Revoke the grant any of its tokens names, when the client owns it (RFC 7009). */
  revokeToken(request: { clientId: string; clientSecret?: string; token: string }, now = new Date()): void {
    this.authenticateClient(request.clientId, request.clientSecret);
    const row = this.db.query<TokenRow, [string]>(TOKEN_WITH_GRANT).get(hash(request.token));
    if (row === null || row.client_id !== request.clientId) return;
    // A child token ends only itself: a sandbox holding one cannot end the grant.
    if (row.kind === "child") this.db.run("DELETE FROM link_tokens WHERE token_hash = ?", [hash(request.token)]);
    else this.revoke(row.grant_id, "app", now);
  }

  /** The subscriptions a grant may use; empty once it is revoked. */
  credentialIds(grantId: string): ReadonlySet<string> {
    const row = this.db
      .query<GrantRow, [string]>("SELECT * FROM link_grants WHERE id = ? AND revoked_at IS NULL")
      .get(grantId);
    return new Set(row === null ? [] : parseIds(row.credential_ids));
  }

  /** The user who approved a grant; null when it has none or is unknown. */
  subject(grantId: string): string | null {
    return this.db
      .query<{ subject: string | null }, [string]>("SELECT subject FROM link_grants WHERE id = ?")
      .get(grantId)?.subject ?? null;
  }

  /** Grants that are not revoked, oldest first. */
  grants(): LinkGrant[] {
    return this.db
      .query<GrantRow & { app_name: string }, []>(
        `SELECT link_grants.*, link_apps.name AS app_name FROM link_grants
         JOIN link_apps ON link_apps.client_id = link_grants.client_id
         WHERE link_grants.revoked_at IS NULL ORDER BY link_grants.created_at, link_grants.id`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        clientId: row.client_id,
        appName: row.app_name,
        credentialIds: parseIds(row.credential_ids),
        createdAt: new Date(row.created_at).toISOString(),
        budget: parseBudget(row.budget),
      }));
  }

  /**
   * Revoke a grant: its code and refresh tokens go, and its access and child
   * tokens stop working. False when none is active by that id.
   */
  revoke(grantId: string, by: LinkRevoker, now = new Date()): boolean {
    const result = this.db.run(
      "UPDATE link_grants SET revoked_at = ?, revoked_by = ?, code_hash = NULL WHERE id = ? AND revoked_at IS NULL",
      [now.getTime(), by, grantId],
    );
    if (result.changes === 0) return false;
    this.db.run("DELETE FROM link_tokens WHERE grant_id = ? AND kind = 'refresh'", [grantId]);
    return true;
  }

  /**
   * The app a client id names, once it has proven its secret when it has one.
   * A confidential client must send its secret; a public one must not.
   */
  private authenticateClient(clientId: string, clientSecret: string | undefined): LinkApp {
    const row = this.db.query<AppRow, [string]>("SELECT * FROM link_apps WHERE client_id = ?").get(clientId);
    const proven = row !== null && (row.client_secret_hash === null
      ? !clientSecret
      : clientSecret !== undefined && sameHash(row.client_secret_hash, hash(clientSecret)));
    if (row === null || !proven) {
      throw new HttpError(401, "Unknown client, or a missing or wrong client secret.", "invalid_client");
    }
    return appFromRow(row);
  }

  private issue(
    grantId: string,
    kind: TokenRow["kind"],
    now: Date,
    expiresAt: number | null,
    child: { pins: string; tags: string | null } | null = null,
  ): string {
    const stale = now.getTime() - LINK_TOKEN_RETENTION_MS;
    // Rotated refresh tokens stay while the grant lives (revoking it deletes
    // them): presenting one again is how a stolen refresh token is caught.
    this.db.run("DELETE FROM link_tokens WHERE expires_at < ? OR (rotated_at < ? AND kind != 'refresh')", [stale, stale]);
    const token = secret(
      kind === "access" ? LINK_ACCESS_TOKEN_PREFIX : kind === "child" ? LINK_CHILD_TOKEN_PREFIX : REFRESH_TOKEN_PREFIX,
    );
    this.db.run(
      `INSERT INTO link_tokens (token_hash, grant_id, kind, expires_at, pins, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [hash(token), grantId, kind, expiresAt, child?.pins ?? null, child?.tags ?? null, now.getTime()],
    );
    return token;
  }
}

export type LinkUsageEntry = {
  requestId: string;
  grantId: string;
  receivedAt: Date;
  model: string | null;
  thinking: string | null;
  tags: Record<string, string>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // The request's outcome, as the request record's `status`.
  status: string;
};

type UsageRow = {
  status: string | null;
  model: string | null;
  thinking: string | null;
  tags: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

type UsageCounts = Omit<LinkUsageTotals, "requests" | "errors"> & {
  model: string | null;
  thinking: string | null;
  tag: string | null;
  failed: boolean;
};

function summarizeLinkUsage(requests: UsageCounts[], groupByTag: boolean): Omit<LinkUsage, "completeThrough"> {
  const empty = (): LinkUsageTotals => ({
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  const add = (totals: LinkUsageTotals, request: UsageCounts) => {
    totals.requests += 1;
    totals.errors += request.failed ? 1 : 0;
    totals.inputTokens += request.inputTokens;
    totals.outputTokens += request.outputTokens;
    totals.cacheReadTokens += request.cacheReadTokens;
    totals.cacheWriteTokens += request.cacheWriteTokens;
  };
  const total = empty();
  const byModel = new Map<string, LinkUsage["byModel"][number]>();
  const byTag = new Map<string | null, NonNullable<LinkUsage["byTag"]>[number]>();
  for (const request of requests) {
    add(total, request);
    if (groupByTag) {
      let tagged = byTag.get(request.tag);
      if (tagged === undefined) {
        tagged = { value: request.tag, ...empty() };
        byTag.set(request.tag, tagged);
      }
      add(tagged, request);
    }
    const model = request.model ?? "unknown";
    const key = `${model}\u0000${request.thinking ?? ""}`;
    let entry = byModel.get(key);
    if (entry === undefined) {
      entry = { model, thinking: request.thinking, ...empty() };
      byModel.set(key, entry);
    }
    add(entry, request);
  }
  return {
    ...total,
    byModel: [...byModel.values()].sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model)),
    ...(groupByTag
      ? {
          byTag: [...byTag.values()].sort(
            (a, b) => b.requests - a.requests || (a.value ?? "").localeCompare(b.value ?? ""),
          ),
        }
      : {}),
  };
}

function secret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function invalidGrant(message: string): HttpError {
  return new HttpError(400, message, "invalid_grant");
}

function appFromRow(row: AppRow): LinkApp {
  return {
    clientId: row.client_id,
    name: row.name,
    redirectUris: JSON.parse(row.redirect_uris) as string[],
    confidential: row.client_secret_hash !== null,
  };
}

// A child token's models. One minted before `pins` existed kept its one model
// in `model` and `thinking`.
function childPins(row: TokenRow): LinkPin[] {
  if (row.pins !== null) return JSON.parse(row.pins) as LinkPin[];
  return row.model === null ? [] : [{ model: row.model, thinking: row.thinking }];
}

function parseIds(value: string): string[] {
  return JSON.parse(value) as string[];
}

function parseBudget(value: string | null): LinkBudget[] {
  return value === null ? [] : JSON.parse(value) as LinkBudget[];
}
