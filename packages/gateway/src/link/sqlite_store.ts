/**
 * The self-hosted gateway's Dari Link storage, in SQLite: registered apps, the
 * grants users approve for them, each grant's tokens and usage, and the API
 * keys users add. A grant names the subscriptions it may use. The rules over
 * these tables are link/service.ts and link/grants.ts.
 */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { type SecretBox, openWithoutKey } from "../self_host/secret_box.js";
import type { LinkBudget, LinkUsageQuery } from "../platform/platform.js";
import type { BudgetUse } from "./budget.js";
import {
  LINK_TOKEN_RETENTION_MS,
  type LinkAppRecord,
  type LinkPin,
  type LinkRevoker,
  type LinkTokenIssue,
  type LinkTokenKind,
  type LinkTokenRecord,
  type LinkUsageRecord,
} from "./grants.js";
import type { LinkGrantRecord, LinkStore } from "./service.js";

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
  created_at: number;
  budget: string | null;
  subject: string | null;
};

/** An API key a user added on the approval page, for one model provider or gateway. */
export type LinkApiKey = { id: string; subject: string; provider: string; apiKey: string };

type KeyRow = { id: string; subject: string; provider: string; api_key: string };

// Where a stored API key belongs, which its encryption is bound to.
function keyPlace(id: string): string {
  return `link_api_keys:${id}:api_key`;
}

type TokenRow = {
  kind: LinkTokenKind;
  expires_at: number | null;
  rotated_at: number | null;
  model: string | null;
  thinking: string | null;
  pins: string | null;
  tags: string | null;
  grant_id: string;
  client_id: string;
  credential_ids: string;
  budget: string | null;
  revoked_at: number | null;
  revoked_by: string | null;
};

const TOKEN_WITH_GRANT = `SELECT link_tokens.kind, link_tokens.expires_at, link_tokens.rotated_at, link_tokens.model,
    link_tokens.thinking, link_tokens.pins, link_tokens.tags, link_grants.id AS grant_id, link_grants.client_id,
    link_grants.credential_ids, link_grants.budget, link_grants.revoked_at, link_grants.revoked_by
  FROM link_tokens JOIN link_grants ON link_grants.id = link_tokens.grant_id
  WHERE link_tokens.token_hash = ?`;

const LIVE_GRANTS = `SELECT link_grants.id, link_grants.client_id, link_grants.credential_ids, link_grants.created_at,
    link_grants.budget, link_grants.subject, link_apps.name AS app_name
  FROM link_grants JOIN link_apps ON link_apps.client_id = link_grants.client_id
  WHERE link_grants.revoked_at IS NULL`;

export class SqliteLinkStore implements LinkStore {
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

  budgetUses(grantId: string, since: number): BudgetUse[] {
    return this.db
      .query<{ received_at: number; tokens: number }, [string, number]>(
        `SELECT received_at, input_tokens + output_tokens + cache_read_tokens + cache_write_tokens AS tokens
         FROM link_usage WHERE grant_id = ? AND received_at > ?`,
      )
      .all(grantId, since)
      .map((row) => ({ at: new Date(row.received_at), tokens: row.tokens }));
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

  usageRecords(grantId: string, query: Pick<LinkUsageQuery, "since" | "until" | "requestId">): LinkUsageRecord[] {
    const rows = query.requestId !== undefined
      ? this.db
        .query<UsageRow, [string, string]>("SELECT * FROM link_usage WHERE grant_id = ? AND request_id = ?")
        .all(grantId, query.requestId)
      : this.db
        .query<UsageRow, [string, number, number]>(
          `SELECT * FROM link_usage WHERE grant_id = ? AND received_at >= ? AND received_at < ?`,
        )
        .all(grantId, query.since?.getTime() ?? 0, query.until?.getTime() ?? Number.MAX_SAFE_INTEGER);
    return rows.map((row) => ({
      status: row.status,
      model: row.model,
      thinking: row.thinking,
      tags: JSON.parse(row.tags) as Record<string, string>,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
    }));
  }

  addApp(app: LinkAppRecord, now = new Date()): void {
    this.db.run(
      "INSERT INTO link_apps (client_id, name, redirect_uris, client_secret_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      [app.clientId, app.name, JSON.stringify(app.redirectUris), app.clientSecretHash, now.getTime()],
    );
  }

  appRecord(clientId: string): LinkAppRecord | null {
    const row = this.db.query<AppRow, [string]>("SELECT * FROM link_apps WHERE client_id = ?").get(clientId);
    return row === null
      ? null
      : {
          clientId: row.client_id,
          name: row.name,
          redirectUris: JSON.parse(row.redirect_uris) as string[],
          confidential: row.client_secret_hash !== null,
          clientSecretHash: row.client_secret_hash,
        };
  }

  saveGrant(request: Parameters<LinkStore["saveGrant"]>[0]): string | null {
    const budget = request.budget.length === 0 ? null : JSON.stringify(request.budget);
    if (request.grantId !== undefined) {
      const updated = this.db.run(
        `UPDATE link_grants SET credential_ids = ?, budget = ?, code_hash = ?, code_challenge = ?, redirect_uri = ?,
           code_expires_at = ?
         WHERE id = ? AND client_id = ? AND subject = ? AND revoked_at IS NULL`,
        [
          JSON.stringify(request.credentialIds),
          budget,
          request.codeHash,
          request.codeChallenge,
          request.redirectUri,
          request.codeExpiresAt,
          request.grantId,
          request.clientId,
          request.subject,
        ],
      ).changes;
      return updated === 0 ? null : request.grantId;
    }
    const id = `lgr_${randomUUID().replaceAll("-", "")}`;
    this.db.run(
      `INSERT INTO link_grants (id, client_id, credential_ids, code_hash, code_challenge, redirect_uri,
         code_expires_at, created_at, budget, subject)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        request.clientId,
        JSON.stringify(request.credentialIds),
        request.codeHash,
        request.codeChallenge,
        request.redirectUri,
        request.codeExpiresAt,
        request.now,
        budget,
        request.subject,
      ],
    );
    return id;
  }

  updateGrant(grantId: string, change: { credentialIds?: string[]; budget?: LinkBudget[] }): boolean {
    return this.db.transaction(() => {
      const changed = this.grant(grantId) !== null;
      if (changed && change.credentialIds !== undefined) {
        this.db.run("UPDATE link_grants SET credential_ids = ? WHERE id = ?", [JSON.stringify(change.credentialIds), grantId]);
      }
      if (changed && change.budget !== undefined) {
        this.db.run("UPDATE link_grants SET budget = ? WHERE id = ?", [
          change.budget.length === 0 ? null : JSON.stringify(change.budget),
          grantId,
        ]);
      }
      return changed;
    })();
  }

  grants(subject: string | null): LinkGrantRecord[] {
    const order = " ORDER BY link_grants.created_at, link_grants.id";
    const rows = subject === null
      ? this.db.query<GrantRow & { app_name: string }, []>(LIVE_GRANTS + order).all()
      : this.db.query<GrantRow & { app_name: string }, [string]>(`${LIVE_GRANTS} AND link_grants.subject = ?${order}`).all(subject);
    return rows.map(grantRecord);
  }

  grant(grantId: string): LinkGrantRecord | null {
    const row = this.db.query<GrantRow & { app_name: string }, [string]>(`${LIVE_GRANTS} AND link_grants.id = ?`).get(grantId);
    return row === null ? null : grantRecord(row);
  }

  redeemCode(request: Parameters<LinkStore["redeemCode"]>[0]): string | null {
    return this.db.transaction(() => {
      const row = this.db
        .query<{ id: string }, [string, string, string, string, number]>(
          `SELECT id FROM link_grants WHERE code_hash = ? AND client_id = ? AND redirect_uri = ? AND code_challenge = ?
             AND code_expires_at > ? AND revoked_at IS NULL`,
        )
        .get(request.codeHash, request.clientId, request.redirectUri, request.codeChallenge, request.now);
      if (row === null) return null;
      this.db.run(
        "UPDATE link_grants SET code_hash = NULL, code_challenge = NULL, code_expires_at = NULL WHERE id = ?",
        [row.id],
      );
      this.insertTokens(row.id, request.tokens, request.now);
      return row.id;
    })();
  }

  tokenRecord(tokenHash: string): LinkTokenRecord | null {
    const row = this.db.query<TokenRow, [string]>(TOKEN_WITH_GRANT).get(tokenHash);
    return row === null
      ? null
      : {
          kind: row.kind,
          expiresAt: row.expires_at,
          rotatedAt: row.rotated_at,
          pins: childPins(row),
          tags: row.tags === null ? null : JSON.parse(row.tags) as Record<string, string>,
          grantId: row.grant_id,
          clientId: row.client_id,
          credentialIds: parseIds(row.credential_ids),
          budget: parseBudget(row.budget),
          revokedAt: row.revoked_at,
          revokedBy: row.revoked_by,
          usable: true,
        };
  }

  issueTokens(request: { grantId: string; tokens: LinkTokenIssue[]; rotate?: string; now: number }): "ok" | "race" | "revoked" {
    return this.db.transaction((): "ok" | "race" | "revoked" => {
      const live = this.db
        .query<{ id: string }, [string]>("SELECT id FROM link_grants WHERE id = ? AND revoked_at IS NULL")
        .get(request.grantId);
      if (live === null) return "revoked";
      if (request.rotate !== undefined) {
        const rotated = this.db.run(
          "UPDATE link_tokens SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL",
          [request.now, request.rotate],
        ).changes;
        if (rotated === 0) return "race";
      }
      const stale = request.now - LINK_TOKEN_RETENTION_MS;
      // Rotated refresh tokens stay while the grant lives (revoking it deletes
      // them): presenting one again is how a stolen refresh token is caught.
      this.db.run("DELETE FROM link_tokens WHERE expires_at < ? OR (rotated_at < ? AND kind != 'refresh')", [stale, stale]);
      this.insertTokens(request.grantId, request.tokens, request.now);
      return "ok";
    })();
  }

  private insertTokens(grantId: string, tokens: LinkTokenIssue[], now: number): void {
    for (const token of tokens) {
      this.db.run(
        `INSERT INTO link_tokens (token_hash, grant_id, kind, expires_at, pins, tags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          token.tokenHash,
          grantId,
          token.kind,
          token.expiresAt,
          token.pins === undefined ? null : JSON.stringify(token.pins),
          token.tags === undefined ? null : JSON.stringify(token.tags),
          now,
        ],
      );
    }
  }

  deleteToken(tokenHash: string): void {
    this.db.run("DELETE FROM link_tokens WHERE token_hash = ?", [tokenHash]);
  }

  /** The subscriptions a grant may use; empty once it is revoked. */
  credentialIds(grantId: string): ReadonlySet<string> {
    const row = this.db
      .query<GrantRow, [string]>("SELECT * FROM link_grants WHERE id = ? AND revoked_at IS NULL")
      .get(grantId);
    return new Set(row === null ? [] : parseIds(row.credential_ids));
  }

  revokeGrant(grantId: string, by: LinkRevoker, now = Date.now()): boolean {
    const result = this.db.run(
      "UPDATE link_grants SET revoked_at = ?, revoked_by = ?, code_hash = NULL WHERE id = ? AND revoked_at IS NULL",
      [now, by, grantId],
    );
    if (result.changes === 0) return false;
    this.db.run("DELETE FROM link_tokens WHERE grant_id = ? AND kind = 'refresh'", [grantId]);
    return true;
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

// A child token's models. One minted before `pins` existed kept its one model
// in `model` and `thinking`.
function childPins(row: TokenRow): LinkPin[] | null {
  if (row.kind !== "child") return null;
  if (row.pins !== null) return JSON.parse(row.pins) as LinkPin[];
  return row.model === null ? [] : [{ model: row.model, thinking: row.thinking }];
}

function grantRecord(row: GrantRow & { app_name: string }): LinkGrantRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    appName: row.app_name,
    subject: row.subject,
    credentialIds: parseIds(row.credential_ids),
    createdAt: new Date(row.created_at).toISOString(),
    budget: parseBudget(row.budget),
  };
}

function parseIds(value: string): string[] {
  return JSON.parse(value) as string[];
}

// An entry without maxTokens (a share-of-plan limit from before token caps) is no limit.
function parseBudget(value: string | null): LinkBudget[] {
  const entries = value === null ? [] : JSON.parse(value) as Array<Partial<LinkBudget>>;
  return entries.filter((entry): entry is LinkBudget => typeof entry.maxTokens === "number");
}
