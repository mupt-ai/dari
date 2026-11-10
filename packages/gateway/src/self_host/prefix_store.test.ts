import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { PendingLeaseWrite, PrefixStateWrite } from "../platform/platform.js";
import { PrefixStore } from "./prefix_store.js";

const ROUTER = "router-1";
const T0 = new Date("2026-10-20T12:00:00.000Z");

function hash(label: string): string {
  return new Bun.CryptoHasher("sha256").update(label).digest("hex");
}

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prefix_hash: hash("a"),
    loose_prefix_hash: hash("a-loose"),
    conversation_id: "conv-1",
    model: "anthropic/claude-sonnet-4.5",
    provider: "anthropic",
    next_model: "openai/gpt-5",
    next_reasoning_effort: "medium",
    message_depth: 4,
    lease_depth: 4,
    provider_block_depth: 4,
    prompt_anchor_depth: 3,
    input_tokens: 100,
    cache_read_tokens: 900,
    cache_write_tokens: 0,
    prompt_tokens: 1000,
    benchmark_replay_depth: 3,
    tool_choice_fp: "tc",
    response_format_fp: "rf",
    reasoning_bucket: "off",
    lease_turns_remaining: 2,
    reason: "cheap enough",
    ...overrides,
  };
}

function stateWrite(overrides: Partial<PrefixStateWrite> = {}): PrefixStateWrite {
  return {
    organization_id: "org-1",
    router_id: ROUTER,
    received_at: T0.toISOString(),
    zdr: false,
    prefix_entry: entry(),
    touched_prefix_hash: null,
    ...overrides,
  };
}

function leaseWrite(depth: number, model: string | null): PendingLeaseWrite {
  return {
    router_id: ROUTER,
    conversation_id: "conv-1",
    decided_at_depth: depth,
    pending_lease: model === null
      ? null
      : { model, reasoning_effort: "high", turns: 3, reason: "prefetched", output_text: " thinking " },
  };
}

function hits(store: PrefixStore, prefixHashes: string[], now = at(1), conversationId?: string) {
  return store.hits({ routerId: ROUTER, prefixHashes, conversationId }, now);
}

describe("PrefixStore", () => {
  test("round-trips a written entry into a hit", () => {
    const store = new PrefixStore(new Database(":memory:"));
    expect(store.write(stateWrite(), at(0))).toBe(true);

    expect(hits(store, [hash("a")])).toEqual([{
      hash: hash("a"),
      loose_hash: hash("a-loose"),
      conversation_id: "conv-1",
      model: "anthropic/claude-sonnet-4.5",
      provider: "anthropic",
      next_model: "openai/gpt-5",
      next_reasoning_effort: "medium",
      message_depth: 4,
      provider_block_depth: 4,
      prompt_anchor_depth: 3,
      prompt_tokens: 1000,
      benchmark_replay_depth: 3,
      input_tokens: 100,
      cache_read_tokens: 900,
      cache_write_tokens: 0,
      tool_choice_fp: "tc",
      response_format_fp: "rf",
      reasoning_bucket: "off",
      lease_turns_remaining: 2,
      pending_lease_model: null,
      pending_lease_reasoning_effort: null,
      pending_lease_turns: null,
      pending_lease_reason: null,
      pending_lease_output_text: null,
      reason: "cheap enough",
      updated_at: T0.toISOString(),
    }]);
    expect(store.hits({ routerId: "other-router", prefixHashes: [hash("a")] }, at(1))).toEqual([]);
    expect(hits(store, [hash("a")], at(31))).toEqual([]);
  });

  test("matches the loose hash tier", () => {
    const store = new PrefixStore(new Database(":memory:"));
    store.write(stateWrite(), at(0));
    expect(hits(store, [hash("a-loose")]).map((hit) => hit.hash)).toEqual([hash("a")]);
    expect(hits(store, [hash("unknown")])).toEqual([]);
  });

  test("orders hits newest first, then deepest first", () => {
    const store = new PrefixStore(new Database(":memory:"));
    store.write(stateWrite({ prefix_entry: entry({ prefix_hash: hash("shallow"), message_depth: 2 }) }), at(0));
    store.write(stateWrite({ prefix_entry: entry({ prefix_hash: hash("deep"), message_depth: 6 }) }), at(0));
    store.write(stateWrite({
      received_at: at(0.5).toISOString(),
      prefix_entry: entry({ prefix_hash: hash("newer"), message_depth: 1 }),
    }), at(1));
    expect(hits(store, [hash("shallow"), hash("deep"), hash("newer")]).map((hit) => hit.hash))
      .toEqual([hash("newer"), hash("deep"), hash("shallow")]);
  });

  test("freshness only advances on upsert and touch", () => {
    const store = new PrefixStore(new Database(":memory:"));
    store.write(stateWrite(), at(0));
    store.write(stateWrite({ received_at: at(10).toISOString(), prefix_entry: null, touched_prefix_hash: hash("a") }), at(10));
    expect(hits(store, [hash("a")], at(35))[0]?.updated_at).toBe(at(10).toISOString());

    // A delayed re-application of the earlier turn neither backdates nor overwrites.
    store.write(stateWrite({ prefix_entry: entry({ model: "stale/model" }) }), at(11));
    store.write(stateWrite({ received_at: at(5).toISOString(), prefix_entry: null, touched_prefix_hash: hash("a") }), at(11));
    const [hit] = hits(store, [hash("a")], at(11));
    expect(hit?.updated_at).toBe(at(10).toISOString());
    expect(hit?.model).toBe("anthropic/claude-sonnet-4.5");

    // A newer application of the same hash replaces the entry's fields.
    store.write(stateWrite({ received_at: at(12).toISOString(), prefix_entry: entry({ model: "new/model" }) }), at(12));
    expect(hits(store, [hash("a")], at(12))[0]?.model).toBe("new/model");
  });

  test("pending lease stamps, clears, and fences stale writes by depth", () => {
    const store = new PrefixStore(new Database(":memory:"));
    store.write(stateWrite(), at(0));
    store.write(stateWrite({ prefix_entry: entry({ prefix_hash: hash("b"), message_depth: 6, lease_depth: 6 }) }), at(0));

    // Decided shallower than the deepest row's own fence: only the row at depth 4 takes it.
    expect(store.writePendingLease(leaseWrite(5, "openai/gpt-5"), false, at(1))).toBe(1);
    expect(store.writePendingLease(leaseWrite(6, "openai/gpt-5"), false, at(1))).toBe(2);
    const stamped = hits(store, [hash("a"), hash("b")]);
    expect(stamped.map((hit) => hit.pending_lease_model)).toEqual(["openai/gpt-5", "openai/gpt-5"]);
    expect(stamped[0]).toMatchObject({
      pending_lease_reasoning_effort: "high",
      pending_lease_turns: 3,
      pending_lease_reason: "prefetched",
      pending_lease_output_text: "thinking",
    });

    expect(store.writePendingLease(leaseWrite(8, null), false, at(1))).toBe(2);
    // A slow prefetch decided before the clear is fenced out.
    expect(store.writePendingLease(leaseWrite(7, "openai/gpt-5"), false, at(1))).toBe(0);
    expect(hits(store, [hash("a"), hash("b")]).map((hit) => hit.pending_lease_model)).toEqual([null, null]);

    // Re-applying the turn neither wipes pending state nor lowers the fence.
    store.writePendingLease(leaseWrite(9, "google/gemini-3-pro"), false, at(1));
    store.write(stateWrite({ received_at: at(2).toISOString() }), at(2));
    expect(hits(store, [hash("a")], at(2))[0]?.pending_lease_model).toBe("google/gemini-3-pro");
    expect(store.writePendingLease(leaseWrite(8, null), false, at(2))).toBe(0);

    // Rows past the conversation lookback are not stamped.
    expect(store.writePendingLease(leaseWrite(10, null), false, at(40))).toBe(0);
  });

  test("conversation-scoped lookup appends the conversation's other rows", () => {
    const store = new PrefixStore(new Database(":memory:"));
    store.write(stateWrite(), at(0));
    store.write(stateWrite({
      received_at: at(0.5).toISOString(),
      prefix_entry: entry({ prefix_hash: hash("b"), loose_prefix_hash: null, message_depth: 6 }),
    }), at(1));
    store.write(stateWrite({ prefix_entry: entry({ prefix_hash: hash("other"), conversation_id: "conv-2" }) }), at(0));

    expect(hits(store, [hash("a")], at(1), "conv-1").map((hit) => hit.hash)).toEqual([hash("a"), hash("b")]);
    expect(hits(store, [], at(1), "conv-1").map((hit) => hit.hash)).toEqual([hash("b"), hash("a")]);
    expect(hits(store, [])).toEqual([]);
  });

  test("ZDR drops free text and constraint violations report not applied", () => {
    const store = new PrefixStore(new Database(":memory:"));
    store.write(stateWrite({
      zdr: true,
      prefix_entry: entry({ pending_lease_reason: "why", pending_lease_output_text: "trace" }),
    }), at(0));
    store.writePendingLease(leaseWrite(4, "openai/gpt-5"), true, at(1));
    expect(hits(store, [hash("a")])[0]).toMatchObject({
      reason: null,
      pending_lease_model: "openai/gpt-5",
      pending_lease_reason: null,
      pending_lease_output_text: null,
    });

    expect(store.write(stateWrite({
      prefix_entry: entry({ prefix_hash: hash("blank"), conversation_id: "  " }),
      touched_prefix_hash: hash("a"),
      received_at: at(5).toISOString(),
    }), at(5))).toBe(false);
    expect(hits(store, [hash("blank")], at(5))).toEqual([]);
    // The rejected write's touch rolled back with it.
    expect(hits(store, [hash("a")], at(5))[0]?.updated_at).toBe(T0.toISOString());
  });

  test("expired rows are swept on write", () => {
    const db = new Database(":memory:");
    const store = new PrefixStore(db);
    store.write(stateWrite(), at(0));
    store.write(stateWrite({ received_at: at(61).toISOString(), prefix_entry: entry({ prefix_hash: hash("b") }) }), at(61));
    expect(db.query("SELECT prefix_hash FROM routing_prefix_entries").all()).toEqual([{ prefix_hash: hash("b") }]);
    // Reopening keeps the schema and rows.
    expect(new PrefixStore(db).hits({ routerId: ROUTER, prefixHashes: [hash("b")] }, at(61))).toHaveLength(1);
  });
});
