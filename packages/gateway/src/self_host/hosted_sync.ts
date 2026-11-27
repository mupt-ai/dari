import type { Database } from "bun:sqlite";

import type { HostedConnection } from "./connected.js";
import {
  SUBSCRIPTION_PROVIDERS,
  type ConnectedAccount,
  type SubscriptionProvider,
  type SubscriptionStore,
} from "./subscriptions/index.js";

// Hosted Dari's per-call limit, and a size that stays well under its body cap.
const MAX_BATCH_ROWS = 16;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;
// A row past this sheds its request and response bodies, as hosted ingest does.
const MAX_ROW_BYTES = 4 * 1024 * 1024;
// How often this computer's plans are checked against the accounts on Dari.
const ACCOUNTS_CHECK_MS = 60 * 60_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 15 * 60_000;
const DRAIN_INTERVAL_MS = 2_000;

type OutboxRow = { id: number; row_json: string };

/**
 * What a gateway connected to hosted Dari tells it: the requests it served,
 * for Activity, `POST /v1/gateway/requests`. Rows wait in a SQLite outbox,
 * sent in batches with backoff until hosted takes them. Requests a private
 * plan served are never queued. This computer's plans themselves never leave
 * it; it only reads the accounts on Dari (`GET /v1/gateway/accounts`), to drop
 * a plan whose account was since connected there.
 */
export class HostedSync {
  private accountsTimer: ReturnType<typeof setTimeout> | null = null;
  private accountsFailures = 0;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private draining: Promise<void> | null = null;
  private drainFailures = 0;
  private drainPausedUntil = 0;

  constructor(
    private readonly db: Database,
    private readonly subscriptions: SubscriptionStore,
    private readonly hosted: HostedConnection,
    private readonly fetch: typeof globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {
    db.run(`CREATE TABLE IF NOT EXISTS hosted_request_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      row_json TEXT NOT NULL,
      queued_at INTEGER NOT NULL
    )`);
  }

  /** Check the accounts on Dari and send waiting requests now, then keep at it. */
  start(): void {
    this.scheduleAccountsCheck(0);
    this.drainTimer = setInterval(() => void this.drain(), DRAIN_INTERVAL_MS);
    this.drainTimer.unref?.();
    void this.drain();
  }

  stop(): void {
    if (this.accountsTimer !== null) clearTimeout(this.accountsTimer);
    if (this.drainTimer !== null) clearInterval(this.drainTimer);
    this.accountsTimer = null;
    this.drainTimer = null;
  }

  /** Queue a served request's log row for hosted Activity. */
  enqueue(row: Record<string, unknown>): void {
    let json = JSON.stringify(row);
    if (json.length > MAX_ROW_BYTES) {
      json = JSON.stringify({
        ...row,
        client_request_json: null,
        client_request_format: null,
        client_response_json: null,
      });
    }
    this.db.run("INSERT INTO hosted_request_outbox (row_json, queued_at) VALUES (?, ?)", [json, this.now()]);
  }

  private scheduleAccountsCheck(delayMs: number): void {
    this.accountsTimer = setTimeout(() => void this.checkAccounts(), delayMs);
    this.accountsTimer.unref?.();
  }

  // A plan here whose account was connected on Dari after it was connected
  // here: Dari's plan serves this computer too, so the copy here goes. Only
  // the account id matches, never the email alone: one email can hold several
  // ChatGPT workspaces or Claude organizations.
  private async checkAccounts(): Promise<void> {
    try {
      const onDari = await readHostedAccounts(this.hosted, this.fetch);
      this.accountsFailures = 0;
      for (const plan of this.subscriptions.list()) {
        if (plan.owner !== null || plan.accountId === null) continue;
        const moved = onDari.some((account) => account.provider === plan.provider
          && account.accountId === plan.accountId
          && account.connectedAt !== undefined && account.connectedAt > plan.createdAt);
        if (!moved) continue;
        this.subscriptions.disconnect(plan.name);
        console.error(`${plan.name} is now connected on Dari; removed it from this computer`);
      }
      this.scheduleAccountsCheck(ACCOUNTS_CHECK_MS);
    } catch (error) {
      this.accountsFailures += 1;
      console.error("hosted accounts check failed", error instanceof Error ? error.message : String(error));
      this.scheduleAccountsCheck(backoff(this.accountsFailures));
    }
  }

  /** Send the queued request rows a batch at a time, unless hosted failed lately. */
  drain(): Promise<void> {
    this.draining ??= this.drainDue().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async drainDue(): Promise<void> {
    while (this.now() >= this.drainPausedUntil) {
      const due = this.db
        .query<OutboxRow, [number]>("SELECT id, row_json FROM hosted_request_outbox ORDER BY id LIMIT ?")
        .all(MAX_BATCH_ROWS);
      const batch: OutboxRow[] = [];
      let bytes = 0;
      for (const row of due) {
        if (batch.length > 0 && bytes + row.row_json.length > MAX_BATCH_BYTES) break;
        batch.push(row);
        bytes += row.row_json.length;
      }
      if (batch.length === 0) return;
      // Rows are stored as JSON already; spliced in, they are not parsed again.
      const body = `{"gateway_id":${JSON.stringify(this.hosted.gatewayId)},"requests":[${
        batch.map((row) => `{"row":${row.row_json}}`).join(",")
      }]}`;
      let status: number;
      try {
        const response = await this.call("POST", "/v1/gateway/requests", body);
        status = response.status;
        if (response.ok) {
          const result = await response.json() as { rejected?: Array<{ request_id: string | null; error: string }> };
          if (result.rejected?.length) console.error("hosted Activity refused requests", JSON.stringify(result.rejected));
        } else {
          console.error("hosted Activity sync failed", `HTTP ${status}: ${(await response.text()).slice(0, 300)}`);
        }
      } catch (error) {
        status = 0;
        console.error("hosted Activity sync failed", error instanceof Error ? error.message : String(error));
      }
      // Taken, or refused for good (a malformed or oversized batch): sent.
      if ((status >= 200 && status < 300) || status === 400 || status === 413) {
        this.db.run(`DELETE FROM hosted_request_outbox WHERE id IN (${batch.map(() => "?").join(",")})`, batch.map((row) => row.id));
        this.drainFailures = 0;
        continue;
      }
      // Anything else may pass later: the rows wait, and so does every send.
      this.drainFailures += 1;
      this.drainPausedUntil = this.now() + backoff(this.drainFailures);
    }
  }

  private call(method: string, path: string, body: unknown): Promise<Response> {
    return this.fetch(`${this.hosted.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.hosted.apiKey}`, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  }
}

/**
 * The user's plans on hosted Dari, for the check before a sign-in connects an
 * account and for dropping a plan here that moved there: `GET
 * /v1/gateway/accounts` returns each one's provider, account identity, name,
 * and when it was connected, never a token. Other computers may hold the same
 * account, so only Dari's plans count.
 */
export async function readHostedAccounts(
  hosted: HostedConnection,
  fetchImpl: typeof globalThis.fetch,
): Promise<ConnectedAccount[]> {
  const response = await fetchImpl(
    // Hosted Dari before this release requires gateway_id; it leaves this
    // gateway's own plans out.
    `${hosted.url}/v1/gateway/accounts?gateway_id=${encodeURIComponent(hosted.gatewayId)}`,
    {
      headers: { authorization: `Bearer ${hosted.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json() as { accounts?: unknown };
  if (!Array.isArray(body.accounts)) throw new Error("hosted accounts response has no accounts list");
  const accounts: ConnectedAccount[] = [];
  for (const entry of body.accounts as Array<Record<string, unknown>>) {
    // Hosted Dari before this release also listed other computers' plans.
    if (entry.where !== "dari") continue;
    // A provider this gateway does not know holds no account of a plan here.
    if (!SUBSCRIPTION_PROVIDERS.includes(entry.provider as SubscriptionProvider)) continue;
    let accountId: string | null = null;
    if (typeof entry.account_id === "string") accountId = entry.account_id;
    let accountEmail: string | null = null;
    if (typeof entry.account_email === "string") accountEmail = entry.account_email;
    let name: string | null = null;
    if (typeof entry.name === "string") name = entry.name;
    const connectedAt = typeof entry.connected_at === "string" ? new Date(entry.connected_at) : undefined;
    accounts.push({
      provider: entry.provider as SubscriptionProvider,
      accountId,
      accountEmail,
      place: "dari",
      name,
      ...(connectedAt === undefined || Number.isNaN(connectedAt.getTime()) ? {} : { connectedAt }),
    });
  }
  return accounts;
}

function backoff(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
}
