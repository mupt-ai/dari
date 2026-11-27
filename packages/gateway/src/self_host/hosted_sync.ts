import type { Database } from "bun:sqlite";

import type { HostedConnection } from "./connected.js";
import {
  activeModelHolds,
  isHeld,
  SUBSCRIPTION_PROVIDERS,
  type ConnectedAccount,
  type SubscriptionCredential,
  type SubscriptionProvider,
  type SubscriptionStore,
} from "./subscriptions/index.js";

// Hosted Dari's per-call limit, and a size that stays well under its body cap.
const MAX_BATCH_ROWS = 16;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;
// A row past this sheds its request and response bodies, as hosted ingest does.
const MAX_ROW_BYTES = 4 * 1024 * 1024;
const PLANS_DEBOUNCE_MS = 1_000;
// Usage and last use change on every turn; they reach hosted at most this often.
const USAGE_INTERVAL_MS = 60_000;
// Plans are reported at least this often, so hosted can tell a computer that
// is gone (its plans stop counting as connected after a day) from a quiet one.
const HEARTBEAT_MS = 60 * 60_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 15 * 60_000;
const DRAIN_INTERVAL_MS = 2_000;

type OutboxRow = { id: number; row_json: string };

/**
 * What a gateway connected to hosted Dari tells it: its plans (metadata, never
 * tokens) as one snapshot `PUT /v1/gateway/subscriptions` replaces, and the
 * requests it served, for Activity, `POST /v1/gateway/requests`. Snapshots go
 * a moment after a plan changes and at most once a minute for usage; request
 * rows wait in a SQLite outbox, sent in batches with backoff until hosted
 * takes them. Private plans are never reported.
 */
export class HostedSync {
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotDueAt = Infinity;
  private snapshotFailures = 0;
  // Snapshots go one at a time, so an older one never lands after a newer one.
  private snapshots: Promise<void> = Promise.resolve();
  private lastSnapshotAt = 0;
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

  /** Report the plans now and send waiting requests, then keep at it. */
  start(): void {
    this.scheduleSnapshot(0);
    this.drainTimer = setInterval(() => void this.drain(), DRAIN_INTERVAL_MS);
    this.drainTimer.unref?.();
    void this.drain();
  }

  stop(): void {
    if (this.snapshotTimer !== null) clearTimeout(this.snapshotTimer);
    if (this.drainTimer !== null) clearInterval(this.drainTimer);
    this.snapshotTimer = null;
    this.drainTimer = null;
  }

  /** A plan was connected, removed, renamed, moved, held, or released. */
  plansChanged(): void {
    this.scheduleSnapshot(PLANS_DEBOUNCE_MS);
  }

  /** A plan reported usage or served a turn. */
  usageChanged(): void {
    this.scheduleSnapshot(Math.max(PLANS_DEBOUNCE_MS, this.lastSnapshotAt + USAGE_INTERVAL_MS - this.now()));
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

  /** The plans hosted Dari shows for this gateway. */
  snapshot(): Record<string, unknown> {
    const now = new Date(this.now());
    return {
      gateway_id: this.hosted.gatewayId,
      gateway_name: this.hosted.gatewayName,
      subscriptions: this.subscriptions.list().filter((plan) => !plan.private).map((plan) => planReport(plan, now)),
    };
  }

  // Keeps the earliest of the snapshots asked for.
  private scheduleSnapshot(delayMs: number): void {
    const dueAt = this.now() + delayMs;
    if (this.snapshotTimer !== null && this.snapshotDueAt <= dueAt) return;
    if (this.snapshotTimer !== null) clearTimeout(this.snapshotTimer);
    this.snapshotDueAt = dueAt;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.snapshotDueAt = Infinity;
      this.snapshots = this.snapshots.then(() => this.putSnapshot());
    }, delayMs);
    this.snapshotTimer.unref?.();
  }

  private async putSnapshot(): Promise<void> {
    this.lastSnapshotAt = this.now();
    try {
      const response = await this.call("PUT", "/v1/gateway/subscriptions", this.snapshot());
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const body = await response.json() as { on_dari?: unknown };
      this.snapshotFailures = 0;
      this.scheduleSnapshot(HEARTBEAT_MS);
      this.dropPlansOnDari(body.on_dari);
    } catch (error) {
      this.snapshotFailures += 1;
      console.error("hosted plan sync failed", error instanceof Error ? error.message : String(error));
      this.scheduleSnapshot(backoff(this.snapshotFailures));
    }
  }

  // Hosted Dari names the reported plans whose account was since connected on
  // Dari. Dari's plan serves this computer too, so the copy here goes, and
  // disconnecting it reports the plans again.
  private dropPlansOnDari(localIds: unknown): void {
    if (!Array.isArray(localIds)) return;
    for (const id of localIds) {
      const plan = typeof id === "string" ? this.subscriptions.get(id) : null;
      if (plan === null || plan.owner !== null || plan.private) continue;
      this.subscriptions.disconnect(plan.name);
      console.error(`${plan.name} is now connected on Dari; removed it from this computer`);
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
 * account: `GET /v1/gateway/accounts` returns each one's provider, account
 * identity, and name, never a token. Other computers may hold the same
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
    if (!SUBSCRIPTION_PROVIDERS.includes(entry.provider as SubscriptionProvider)) {
      throw new Error(`hosted accounts response names an unknown provider ${JSON.stringify(entry.provider)}`);
    }
    let accountId: string | null = null;
    if (typeof entry.account_id === "string") accountId = entry.account_id;
    let accountEmail: string | null = null;
    if (typeof entry.account_email === "string") accountEmail = entry.account_email;
    let name: string | null = null;
    if (typeof entry.name === "string") name = entry.name;
    accounts.push({ provider: entry.provider as SubscriptionProvider, accountId, accountEmail, place: "dari", name });
  }
  return accounts;
}

function backoff(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
}

// One plan as `PUT /v1/gateway/subscriptions` takes it. Usage uses the keys
// and formats hosted subscriptions keep in their metadata.
function planReport(plan: SubscriptionCredential, now: Date): Record<string, unknown> {
  const held = isHeld(plan, now);
  const usage = plan.usage;
  return {
    local_id: plan.id,
    provider: plan.provider,
    label: plan.label,
    account_email: plan.accountEmail,
    account_id: plan.accountId,
    plan: null,
    connected_at: plan.createdAt.toISOString(),
    last_used_at: plan.lastUsedAt?.toISOString() ?? null,
    unavailable_until: held ? plan.unavailableUntil!.toISOString() : null,
    unavailable_reason: held ? plan.unavailableReason : null,
    model_holds: Object.fromEntries(activeModelHolds(plan, now).map((hold) => [
      hold.model,
      { until: hold.until.toISOString(), reason: hold.reason },
    ])),
    usage: usage === null ? {} : {
      usage_utilization: usage.utilization.toFixed(4),
      usage_resets_at: usage.resetsAt.toISOString(),
      usage_windows: JSON.stringify(usage.windows.map((window) => ({
        ...(window.modelFamily === undefined ? {} : { model_family: window.modelFamily }),
        minutes: window.minutes,
        utilization: Math.round(window.utilization * 10_000) / 10_000,
        resets_at: window.resetsAt.toISOString(),
      }))),
      usage_observed_at: usage.observedAt.toISOString(),
    },
  };
}
