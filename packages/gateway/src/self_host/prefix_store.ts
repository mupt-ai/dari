/**
 * SQLite storage for per-turn conversation prefix state: the entries that
 * resolve returns as prefix hits (cache warmth, conversation identity, the
 * previous routing decision) and the prefetched lease stamped onto them.
 *
 * Rows hold hashes, identifiers, and token counts. Under ZDR the free-text
 * fields (`reason`, pending-lease reason and selector output) are dropped
 * before they are written.
 *
 * Freshness only advances: every write is guarded by `updated_at`, so
 * duplicate or out-of-order applications of the same turn are no-ops.
 * Timestamps are stored as epoch milliseconds.
 */
import type { Database } from "bun:sqlite";
import type { ReasoningEffort, RouterPrefixHit } from "@mupt-ai/dari-router/policy-engine";

import type { PendingLeaseWrite, PrefixStateWrite } from "../platform/platform.js";
import { ROUTING_PREFIX_HASHES_MAX_COUNT } from "../platform/routing_contract.js";

// Resolve returns entries up to this age so a continuation after a pause still
// recovers its conversation id and previous decision; the runtime itself
// downgrades hits past the provider cache-warmth window to identity-only.
const CONVERSATION_LOOKBACK_MS = 30 * 60_000;
// Rows older than this are deleted. Must stay above the lookback.
const RETENTION_MS = 60 * 60_000;
const CONVERSATION_ID_MAX_CHARS = 64;
const MODEL_NAME_MAX_CHARS = 240;
const REASON_MAX_CHARS = 2000;
const REASONING_BUCKET_MAX_CHARS = 32;
// A 512-token thinking trace is ~3k chars; the cap only guards against a
// runaway completion being fanned across every recent row.
const PENDING_LEASE_OUTPUT_TEXT_MAX_CHARS = 20_000;

type EntryRow = {
  prefix_hash: string;
  loose_prefix_hash: string | null;
  router_id: string;
  organization_id: string | null;
  conversation_id: string;
  model: string;
  provider: string | null;
  next_model: string | null;
  next_reasoning_effort: string | null;
  message_depth: number;
  provider_block_depth: number | null;
  prompt_anchor_depth: number | null;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  prompt_tokens: number;
  benchmark_replay_depth: number | null;
  tool_choice_fp: string;
  response_format_fp: string;
  reasoning_bucket: string | null;
  lease_turns_remaining: number | null;
  pending_lease_model: string | null;
  pending_lease_reasoning_effort: string | null;
  pending_lease_turns: number | null;
  pending_lease_reason: string | null;
  pending_lease_output_text: string | null;
  pending_lease_decided_at_depth: number | null;
  reason: string | null;
  updated_at: number;
};

// Pending-lease columns are owned by writePendingLease: re-applying a turn
// must not wipe a stamp that landed in between, so the upsert leaves them alone
// (the fence column is only ever raised).
const ENTRY_COLUMNS = [
  "prefix_hash", "loose_prefix_hash", "router_id", "organization_id", "conversation_id",
  "model", "provider", "next_model", "next_reasoning_effort", "message_depth",
  "provider_block_depth", "prompt_anchor_depth", "input_tokens", "cache_read_tokens",
  "cache_write_tokens", "prompt_tokens", "benchmark_replay_depth", "tool_choice_fp",
  "response_format_fp", "reasoning_bucket", "lease_turns_remaining", "reason", "updated_at",
] as const;
const PENDING_COLUMNS = [
  "pending_lease_model", "pending_lease_reasoning_effort", "pending_lease_turns",
  "pending_lease_reason", "pending_lease_output_text", "pending_lease_decided_at_depth",
] as const;
const UPSERT_SQL = `INSERT INTO routing_prefix_entries (${[...ENTRY_COLUMNS, ...PENDING_COLUMNS].join(", ")})
  VALUES (${[...ENTRY_COLUMNS, ...PENDING_COLUMNS].map((column) => `$${column}`).join(", ")})
  ON CONFLICT (prefix_hash) DO UPDATE SET
    ${ENTRY_COLUMNS.filter((column) => column !== "prefix_hash").map((column) => `${column} = excluded.${column}`).join(",\n    ")},
    pending_lease_decided_at_depth = max(
      coalesce(routing_prefix_entries.pending_lease_decided_at_depth, 0),
      excluded.pending_lease_decided_at_depth
    )
  WHERE routing_prefix_entries.updated_at < excluded.updated_at`;

export class PrefixStore {
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS routing_prefix_entries (
      prefix_hash TEXT PRIMARY KEY,
      loose_prefix_hash TEXT,
      router_id TEXT NOT NULL,
      organization_id TEXT,
      conversation_id TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT,
      next_model TEXT,
      next_reasoning_effort TEXT,
      message_depth INTEGER NOT NULL,
      provider_block_depth INTEGER,
      prompt_anchor_depth INTEGER,
      input_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      benchmark_replay_depth INTEGER,
      tool_choice_fp TEXT NOT NULL,
      response_format_fp TEXT NOT NULL,
      reasoning_bucket TEXT,
      lease_turns_remaining INTEGER,
      pending_lease_model TEXT,
      pending_lease_reasoning_effort TEXT,
      pending_lease_turns INTEGER,
      pending_lease_reason TEXT,
      pending_lease_output_text TEXT,
      pending_lease_decided_at_depth INTEGER,
      reason TEXT,
      updated_at INTEGER NOT NULL
    )`);
    db.run("CREATE INDEX IF NOT EXISTS ix_routing_prefix_entries_updated_at ON routing_prefix_entries (updated_at)");
    db.run("CREATE INDEX IF NOT EXISTS ix_routing_prefix_entries_router_id ON routing_prefix_entries (router_id)");
    db.run("CREATE INDEX IF NOT EXISTS ix_routing_prefix_entries_conversation_id ON routing_prefix_entries (conversation_id)");
    db.run("CREATE INDEX IF NOT EXISTS ix_routing_prefix_entries_loose_prefix_hash ON routing_prefix_entries (loose_prefix_hash)");
  }

  /**
   * Apply one turn's prefix entry and/or refresh the entry whose cache it
   * read. Freshness is stamped with the request's `received_at` (provider
   * caches are read at the start of the serving request), never write time.
   * Returns false, writing nothing, when the entry violates a constraint.
   */
  write(write: PrefixStateWrite, now: Date = new Date()): boolean {
    const cacheClock = Date.parse(write.received_at);
    if (!Number.isFinite(cacheClock)) throw new Error("received_at must be an ISO timestamp.");
    const apply = this.db.transaction(() => {
      const entry = write.prefix_entry;
      if (entry !== null) {
        this.db.query(UPSERT_SQL).run(entryValues(write, entry, cacheClock));
      }
      if (write.touched_prefix_hash !== null) {
        this.db
          .query("UPDATE routing_prefix_entries SET updated_at = ? WHERE prefix_hash = ? AND updated_at < ?")
          .run(cacheClock, write.touched_prefix_hash, cacheClock);
      }
      // Deterministic sweep; expired rows are already invisible to hits().
      this.db.query("DELETE FROM routing_prefix_entries WHERE updated_at < ?").run(now.getTime() - RETENTION_MS);
    });
    try {
      apply();
    } catch (error) {
      if (isConstraintError(error)) return false;
      throw error;
    }
    return true;
  }

  /**
   * Stamp (or clear, with a null lease) the conversation's prefetched lease
   * on every recent row: the prefetch lands asynchronously, and the expiry
   * turn's lookup must find it on whichever row is deepest by then. Writes
   * decided shallower than the last applied one are stale and skipped.
   * `zdr` is the router's setting. Returns the number of rows updated.
   */
  writePendingLease(write: PendingLeaseWrite, zdr: boolean, now: Date = new Date()): number {
    const lease = write.pending_lease;
    const result = this.db
      .query(`UPDATE routing_prefix_entries SET
          pending_lease_model = $model,
          pending_lease_reasoning_effort = $effort,
          pending_lease_turns = $turns,
          pending_lease_reason = $reason,
          pending_lease_output_text = $output,
          pending_lease_decided_at_depth = $depth
        WHERE router_id = $router AND conversation_id = $conversation AND updated_at > $cutoff
          AND (pending_lease_decided_at_depth IS NULL OR pending_lease_decided_at_depth <= $depth)`)
      .run({
        $model: lease?.model ?? null,
        $effort: lease?.reasoning_effort ?? null,
        $turns: lease?.turns ?? null,
        $reason: zdr ? null : lease?.reason ?? null,
        $output: zdr ? null : clip(lease?.output_text, PENDING_LEASE_OUTPUT_TEXT_MAX_CHARS),
        $depth: write.decided_at_depth,
        $router: write.router_id,
        $conversation: write.conversation_id,
        $cutoff: now.getTime() - CONVERSATION_LOOKBACK_MS,
      });
    return result.changes;
  }

  /**
   * Recent entries of the router matching `prefixHashes` on either hash tier,
   * then (for lease recovery) recent entries of `conversationId`. Each lookup
   * is newest-first, deepest-first within a timestamp, and capped; duplicates
   * keep their first position.
   */
  hits(
    args: { routerId: string; prefixHashes: readonly string[]; conversationId?: string },
    now: Date = new Date(),
  ): RouterPrefixHit[] {
    const hashes = args.prefixHashes.slice(-ROUTING_PREFIX_HASHES_MAX_COUNT);
    const cutoff = now.getTime() - CONVERSATION_LOOKBACK_MS;
    const recent = (filter: string, params: readonly string[]): EntryRow[] =>
      this.db
        .query<EntryRow, (string | number)[]>(
          `SELECT * FROM routing_prefix_entries
            WHERE router_id = ? AND updated_at > ? AND (${filter})
            ORDER BY updated_at DESC, message_depth DESC
            LIMIT ${ROUTING_PREFIX_HASHES_MAX_COUNT}`,
        )
        .all(args.routerId, cutoff, ...params);
    const rows: EntryRow[] = [];
    if (hashes.length > 0) {
      const placeholders = hashes.map(() => "?").join(", ");
      rows.push(...recent(`prefix_hash IN (${placeholders}) OR loose_prefix_hash IN (${placeholders})`, [...hashes, ...hashes]));
    }
    if (args.conversationId) rows.push(...recent("conversation_id = ?", [args.conversationId]));
    const unique = new Map<string, EntryRow>();
    for (const row of rows) if (!unique.has(row.prefix_hash)) unique.set(row.prefix_hash, row);
    return [...unique.values()].map(toHit);
  }
}

function entryValues(write: PrefixStateWrite, entry: Record<string, unknown>, cacheClock: number) {
  const text = (key: string, maxChars?: number): string | null => {
    const value = entry[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw new Error(`prefix_entry.${key} must be a string.`);
    return maxChars === undefined ? value : clip(value, maxChars);
  };
  const int = (key: string): number | null => {
    const value = entry[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Error(`prefix_entry.${key} must be an integer.`);
    }
    return value;
  };
  return {
    $prefix_hash: text("prefix_hash"),
    $loose_prefix_hash: text("loose_prefix_hash"),
    $router_id: write.router_id,
    $organization_id: write.organization_id,
    $conversation_id: text("conversation_id", CONVERSATION_ID_MAX_CHARS),
    $model: text("model", MODEL_NAME_MAX_CHARS),
    $provider: text("provider", MODEL_NAME_MAX_CHARS),
    $next_model: text("next_model", MODEL_NAME_MAX_CHARS),
    $next_reasoning_effort: text("next_reasoning_effort"),
    $message_depth: int("message_depth"),
    $provider_block_depth: int("provider_block_depth"),
    $prompt_anchor_depth: int("prompt_anchor_depth"),
    $input_tokens: int("input_tokens"),
    $cache_read_tokens: int("cache_read_tokens"),
    $cache_write_tokens: int("cache_write_tokens"),
    $prompt_tokens: int("prompt_tokens"),
    $benchmark_replay_depth: int("benchmark_replay_depth"),
    $tool_choice_fp: text("tool_choice_fp"),
    $response_format_fp: text("response_format_fp"),
    $reasoning_bucket: text("reasoning_bucket", REASONING_BUCKET_MAX_CHARS),
    $lease_turns_remaining: int("lease_turns_remaining"),
    $reason: write.zdr ? null : text("reason", REASON_MAX_CHARS),
    $updated_at: cacheClock,
    $pending_lease_model: text("pending_lease_model"),
    $pending_lease_reasoning_effort: text("pending_lease_reasoning_effort"),
    $pending_lease_turns: int("pending_lease_turns"),
    $pending_lease_reason: write.zdr ? null : text("pending_lease_reason"),
    $pending_lease_output_text: write.zdr ? null : text("pending_lease_output_text", PENDING_LEASE_OUTPUT_TEXT_MAX_CHARS),
    // Every row carries a fence at its own conversation depth so a slow
    // prefetch decided earlier cannot stamp rows appended after a newer write.
    $pending_lease_decided_at_depth: int("lease_depth"),
  };
}

// Stripped, truncated, and null when blank.
function clip(value: string | null | undefined, maxChars: number): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxChars) : null;
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && "code" in error && String(error.code).startsWith("SQLITE_CONSTRAINT");
}

function toHit(row: EntryRow): RouterPrefixHit {
  return {
    hash: row.prefix_hash,
    loose_hash: row.loose_prefix_hash,
    conversation_id: row.conversation_id,
    model: row.model,
    provider: row.provider,
    next_model: row.next_model,
    next_reasoning_effort: row.next_reasoning_effort as ReasoningEffort | null,
    message_depth: row.message_depth,
    provider_block_depth: row.provider_block_depth,
    prompt_anchor_depth: row.prompt_anchor_depth,
    prompt_tokens: row.prompt_tokens,
    benchmark_replay_depth: row.benchmark_replay_depth,
    input_tokens: row.input_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_write_tokens: row.cache_write_tokens,
    tool_choice_fp: row.tool_choice_fp,
    response_format_fp: row.response_format_fp,
    reasoning_bucket: row.reasoning_bucket,
    lease_turns_remaining: row.lease_turns_remaining,
    pending_lease_model: row.pending_lease_model,
    pending_lease_reasoning_effort: row.pending_lease_reasoning_effort as ReasoningEffort | null,
    pending_lease_turns: row.pending_lease_turns,
    pending_lease_reason: row.pending_lease_reason,
    pending_lease_output_text: row.pending_lease_output_text,
    reason: row.reason,
    updated_at: new Date(row.updated_at).toISOString(),
  };
}
