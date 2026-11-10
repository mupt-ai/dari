/**
 * SQLite storage for session pins: the model and thinking level each session
 * (and each subagent) of a session-pinning router was routed to on its first
 * turn. Serving a pin refreshes it at most daily; pins unused for longer than
 * the retention window are no longer served and are deleted.
 */
import type { Database } from "bun:sqlite";

import type { SessionPin, SessionPinKey } from "../platform/platform.js";

const RETENTION_MS = 30 * 24 * 60 * 60_000;
const REFRESH_MS = 24 * 60 * 60_000;

type PinRow = { model: string; reasoning_effort: SessionPin["reasoningEffort"]; updated_at: number };

export class SessionPinStore {
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS routing_session_pins (
      router_id TEXT NOT NULL,
      pin_key TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_effort TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (router_id, pin_key)
    )`);
    db.run("CREATE INDEX IF NOT EXISTS ix_routing_session_pins_updated_at ON routing_session_pins (updated_at)");
  }

  read(key: SessionPinKey, now: Date = new Date()): SessionPin | null {
    const row = this.db
      .query<PinRow, [string, string, number]>(
        `SELECT model, reasoning_effort, updated_at FROM routing_session_pins
          WHERE router_id = ? AND pin_key = ? AND updated_at >= ?`,
      )
      .get(key.routerId, key.pinKey, now.getTime() - RETENTION_MS);
    if (row === null) return null;
    if (row.updated_at < now.getTime() - REFRESH_MS) {
      this.db
        .query("UPDATE routing_session_pins SET updated_at = ? WHERE router_id = ? AND pin_key = ?")
        .run(now.getTime(), key.routerId, key.pinKey);
    }
    return { model: row.model, reasoningEffort: row.reasoning_effort };
  }

  write(write: SessionPinKey & SessionPin, now: Date = new Date()): void {
    this.db.transaction(() => {
      this.db
        .query(`INSERT INTO routing_session_pins (router_id, pin_key, model, reasoning_effort, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (router_id, pin_key) DO UPDATE SET
            model = excluded.model,
            reasoning_effort = excluded.reasoning_effort,
            updated_at = excluded.updated_at`)
        .run(write.routerId, write.pinKey, write.model, write.reasoningEffort, now.getTime());
      this.db.query("DELETE FROM routing_session_pins WHERE updated_at < ?").run(now.getTime() - RETENTION_MS);
    })();
  }
}
