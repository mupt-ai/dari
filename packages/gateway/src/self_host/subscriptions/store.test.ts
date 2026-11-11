import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { currentUsage, SubscriptionStore } from "./store.js";
import { tokens } from "./test_support.js";

const now = new Date("2026-10-20T12:00:00Z");
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

function connected(...emails: string[]) {
  const store = new SubscriptionStore(new Database(":memory:"));
  const credentials = emails.map((email, index) =>
    store.connect(tokens({ accountEmail: email, accessToken: `access-${index}` }), null, later(index))!
  );
  return { store, credentials };
}

describe("connecting", () => {
  test("new accounts join the end of the order under the first free name", () => {
    const { store, credentials } = connected("one@example.com", "two@example.com");
    expect(credentials.map((c) => c.name)).toEqual([
      "ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN_2",
    ]);
    store.connect(tokens({ provider: "openai_codex", accountId: "acct", accountEmail: null }), null, later(5));
    expect(store.list().map((c) => [c.provider, c.name])).toEqual([
      ["anthropic_claude_code", "ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN"],
      ["anthropic_claude_code", "ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN_2"],
      ["openai_codex", "OPENAI_CODEX_OAUTH_TOKEN"],
    ]);
    // A disconnected name is free again, and its new connection goes last.
    store.disconnect("anthropic_claude_code_oauth_token");
    const revived = store.connect(tokens({ accountEmail: "three@example.com" }), null, later(6))!;
    expect(revived.name).toBe("ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN");
    expect(store.list("anthropic_claude_code").map((c) => c.accountEmail)).toEqual([
      "two@example.com",
      "three@example.com",
    ]);
  });

  test("the same account email replaces its subscription and keeps its hold", () => {
    const { store, credentials } = connected("one@example.com");
    store.markUnavailable(credentials[0]!.id, later(60), "usage_limit", now);
    const replaced = store.connect(tokens({ accessToken: "fresh" }), null, later(1))!;
    expect(replaced.id).toBe(credentials[0]!.id);
    expect(replaced.accessToken).toBe("fresh");
    expect(replaced.unavailableUntil).toEqual(later(60));
    expect(store.list()).toHaveLength(1);
  });

  test("reconnect replaces the named subscription in place", () => {
    const { store, credentials } = connected("one@example.com", "two@example.com");
    store.rename(credentials[0]!.name, "Work", now);
    store.markUnavailable(credentials[0]!.id, later(60), "usage_limit", now);
    const reconnected = store.connect(
      tokens({ accountEmail: "other@example.com", accessToken: "re" }),
      "anthropic_claude_code_oauth_token",
      later(2),
    )!;
    expect(reconnected).toMatchObject({
      id: credentials[0]!.id,
      name: credentials[0]!.name,
      label: "Work",
      position: credentials[0]!.position,
      createdAt: credentials[0]!.createdAt,
      accessToken: "re",
      accountEmail: "other@example.com",
      // Another account must not inherit the previous account's hold.
      unavailableUntil: null,
      unavailableReason: null,
    });
    expect(store.list()).toHaveLength(2);
  });

  test("reconnect to an unknown or other-provider name is not found", () => {
    const { store } = connected("one@example.com");
    expect(store.connect(tokens(), "MISSING", now)).toBeNull();
    expect(store.connect(tokens({ provider: "openai_codex" }), "ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN", now)).toBeNull();
  });

  test("tables are created idempotently", () => {
    const db = new Database(":memory:");
    new SubscriptionStore(db).connect(tokens(), null, now);
    expect(new SubscriptionStore(db).list()).toHaveLength(1);
  });
});

describe("holds", () => {
  test("a hold moves routing to the next subscription until it expires", () => {
    const { store, credentials } = connected("one@example.com", "two@example.com");
    const [first, second] = credentials as [typeof credentials[0], typeof credentials[0]];
    expect(store.activeCredential("anthropic_claude_code", now)?.id).toBe(first.id);

    expect(store.markUnavailable(first.id, later(30), "usage_limit", now)).toBe(true);
    expect(store.activeCredential("anthropic_claude_code", now)?.id).toBe(second.id);

    expect(store.markUnavailable(second.id, later(10), "usage_limit", now)).toBe(false);
    expect(store.activeCredential("anthropic_claude_code", now)).toBeNull();

    // Holds release on their own at `unavailable_until`, in connection order.
    expect(store.activeCredential("anthropic_claude_code", later(10))?.id).toBe(second.id);
    expect(store.activeCredential("anthropic_claude_code", later(30))?.id).toBe(first.id);
    expect(store.activeCredential("openai_codex", now)).toBeNull();
  });

  test("routing stays on the subscription in use after an earlier hold expires", () => {
    const { store, credentials } = connected("one@example.com", "two@example.com", "three@example.com");
    const [first, second, third] = credentials as [typeof credentials[0], typeof credentials[0], typeof credentials[0]];
    store.markUnavailable(first.id, later(30), "usage_limit", now);
    store.touch(second.id, later(1));
    expect(store.activeCredential("anthropic_claude_code", later(31))?.id).toBe(second.id);

    store.markUnavailable(second.id, later(60), "usage_limit", later(31));
    expect(store.activeCredential("anthropic_claude_code", later(31))?.id).toBe(third.id);
    store.touch(third.id, later(32));
    store.markUnavailable(third.id, later(90), "usage_limit", later(33));
    // Past the last subscription, routing wraps to the first available one.
    expect(store.activeCredential("anthropic_claude_code", later(33))?.id).toBe(first.id);
  });

  test("a hold only grows", () => {
    const { store, credentials } = connected("one@example.com");
    const id = credentials[0]!.id;
    store.markUnavailable(id, later(600), "weekly", now);
    store.markUnavailable(id, later(5), "five_hour", now);
    expect(store.get(id)).toMatchObject({ unavailableUntil: later(600), unavailableReason: "weekly" });
    // An expired hold is replaced even by an earlier reset.
    store.markUnavailable(id, later(700), "five_hour", later(650));
    expect(store.get(id)).toMatchObject({ unavailableUntil: later(700), unavailableReason: "five_hour" });
  });

  test("mark available clears the hold", () => {
    const { store, credentials } = connected("one@example.com");
    store.markUnavailable(credentials[0]!.id, later(30), "usage_limit", now);
    expect(store.markAvailable("anthropic_claude_code_oauth_token", now)).toMatchObject({
      unavailableUntil: null,
      unavailableReason: null,
    });
    expect(store.activeCredential("anthropic_claude_code", now)?.id).toBe(credentials[0]!.id);
    expect(store.markAvailable("MISSING", now)).toBeNull();
    expect(store.markUnavailable("cred_missing", later(1), "usage_limit", now)).toBe(false);
  });
});

test("rename trims, clears on empty, and caps the length", () => {
  const { store, credentials } = connected("one@example.com");
  const name = credentials[0]!.name;
  expect(store.rename(name, "  Personal  ", now)?.label).toBe("Personal");
  expect(store.rename(name, "", now)?.label).toBeNull();
  expect(() => store.rename(name, "x".repeat(121), now)).toThrow(RangeError);
  expect(store.rename("MISSING", "x", now)).toBeNull();
});

test("pending sessions round-trip and expired ones are pruned on create", () => {
  const store = new SubscriptionStore(new Database(":memory:"));
  const old = store.createSession(
    { provider: "openai_codex", flow: { device_auth_id: "d" }, credentialName: null, expiresAt: later(1) },
    now,
  );
  const fresh = store.createSession(
    { provider: "anthropic_claude_code", flow: { state: "s" }, credentialName: "NAME", expiresAt: later(20) },
    later(5),
  );
  expect(store.getSession(old.token)).toBeNull();
  expect(store.getSession(fresh.token)).toEqual(fresh);
  store.deleteSession(fresh.token);
  expect(store.getSession(fresh.token)).toBeNull();
});

describe("usage", () => {
  const CLAUDE = "anthropic_claude_code";
  const used = (utilization: number, resetsInMinutes: number) => ({
    utilization,
    resetsAt: later(resetsInMinutes),
    windows: [{ minutes: 300, utilization, resetsAt: later(resetsInMinutes) }],
  });

  test("a conversation stays on its subscription, keeping its cache, while it has headroom", () => {
    const { store, credentials: [a, b] } = connected("a@example.com", "b@example.com");
    expect(store.selectCredential(CLAUDE, "conv-1", now)?.id).toBe(a!.id);
    // Another plan now resets sooner, but moving would lose conv-1's cache.
    store.recordUsage(a!.id, used(0.5, 240), now);
    store.recordUsage(b!.id, used(0.1, 30), now);
    expect(store.selectCredential(CLAUDE, "conv-1", later(1))?.id).toBe(a!.id);
  });

  test("keeps every reported window", () => {
    const { store, credentials: [a] } = connected("a@example.com");
    const usage = {
      utilization: 0.7,
      resetsAt: later(6000),
      windows: [
        { minutes: 300, utilization: 0.2, resetsAt: later(90) },
        { minutes: 10_080, utilization: 0.7, resetsAt: later(6000) },
      ],
    };
    store.recordUsage(a!.id, usage, now);
    expect(store.list()[0]!.usage).toEqual({ ...usage, observedAt: now });
  });

  test("a short window resetting leaves the longer ones in force", () => {
    const { store, credentials: [a] } = connected("a@example.com");
    store.recordUsage(a!.id, {
      utilization: 0.9,
      resetsAt: later(30),
      windows: [
        { minutes: 300, utilization: 0.9, resetsAt: later(30) },
        { minutes: 10_080, utilization: 0.4, resetsAt: later(6000) },
      ],
    }, now);
    expect(currentUsage(store.list()[0]!, later(31))).toEqual({
      utilization: 0.4,
      resetsAt: later(6000),
      windows: [{ minutes: 10_080, utilization: 0.4, resetsAt: later(6000) }],
    });
    expect(currentUsage(store.list()[0]!, later(6001))).toBeNull();
  });

  test("a new conversation goes where quota resets soonest, so it is spent before it is lost", () => {
    const { store, credentials: [a, b, c] } = connected("a@example.com", "b@example.com", "c@example.com");
    store.recordUsage(a!.id, used(0.4, 240), now);
    store.recordUsage(b!.id, used(0.9, 20), now);
    // c has reported nothing: fresh quota is kept for later.
    expect(store.selectCredential(CLAUDE, "new", now)?.id).toBe(b!.id);
    store.recordUsage(b!.id, used(0.96, 20), now);
    expect(store.selectCredential(CLAUDE, "newer", now)?.id).toBe(a!.id);
    expect(c).toBeDefined();
  });

  test("a conversation moves at its next turn once its subscription nears the limit", () => {
    const { store, credentials: [a, b] } = connected("a@example.com", "b@example.com");
    expect(store.selectCredential(CLAUDE, "conv", now)?.id).toBe(a!.id);
    store.recordUsage(a!.id, used(0.95, 60), now);
    expect(store.selectCredential(CLAUDE, "conv", later(1))?.id).toBe(b!.id);
    // It stays on the new subscription after a's window resets.
    expect(store.selectCredential(CLAUDE, "conv", later(61))?.id).toBe(b!.id);
  });

  test("with every subscription near the limit, the least used serves", () => {
    const { store, credentials: [a, b] } = connected("a@example.com", "b@example.com");
    store.recordUsage(a!.id, used(0.99, 60), now);
    store.recordUsage(b!.id, used(0.96, 300), now);
    expect(store.selectCredential(CLAUDE, "conv", now)?.id).toBe(b!.id);
  });

  test("usage stops counting once its window resets", () => {
    const { store, credentials: [a] } = connected("a@example.com", "b@example.com");
    store.recordUsage(a!.id, used(0.99, 30), now);
    expect(store.selectCredential(CLAUDE, "conv", later(31))?.id).toBe(a!.id);
    expect(store.list(CLAUDE)[0]!.usage?.utilization).toBe(0.99);
  });

  test("held subscriptions never serve, whatever their usage", () => {
    const { store, credentials: [a, b] } = connected("a@example.com", "b@example.com");
    store.recordUsage(b!.id, used(0.1, 10), now);
    store.markUnavailable(b!.id, later(60), "usage_limit", now);
    expect(store.selectCredential(CLAUDE, "conv", now)?.id).toBe(a!.id);
  });

  test("a request without a conversation stays on the subscription used last", () => {
    const { store, credentials: [a, b] } = connected("a@example.com", "b@example.com");
    store.touch(b!.id, later(1));
    store.recordUsage(a!.id, used(0.2, 10), now);
    expect(store.selectCredential(CLAUDE, undefined, later(2))?.id).toBe(b!.id);
    expect(a).toBeDefined();
  });

  test("disconnecting a subscription moves its conversations on", () => {
    const { store, credentials: [a, b] } = connected("a@example.com", "b@example.com");
    expect(store.selectCredential(CLAUDE, "conv", now)?.id).toBe(a!.id);
    store.disconnect(a!.name);
    expect(store.selectCredential(CLAUDE, "conv", now)?.id).toBe(b!.id);
  });

  test("reconnecting another account onto a subscription starts it fresh", () => {
    const { store, credentials: [a, b] } = connected("a@example.com", "b@example.com");
    expect(store.selectCredential(CLAUDE, "conv", now)?.id).toBe(a!.id);
    store.recordUsage(a!.id, used(0.97, 60), now);
    // The same account keeps its usage.
    store.connect(tokens({ accountEmail: "a@example.com", accessToken: "a-2" }), a!.name, later(1));
    expect(store.get(a!.id)?.usage?.utilization).toBe(0.97);
    // Another account gets neither the old usage nor its conversations.
    store.connect(tokens({ accountEmail: "c@example.com", accessToken: "c" }), a!.name, later(2));
    expect(store.get(a!.id)?.usage).toBeNull();
    store.recordUsage(b!.id, used(0.5, 30), later(2));
    expect(store.selectCredential(CLAUDE, "conv", later(3))?.id).toBe(b!.id);
  });

  test("a conversation idle past a week is assigned like a new one", () => {
    const { store, credentials: [a, b] } = connected("a@example.com", "b@example.com");
    expect(store.selectCredential(CLAUDE, "recent", now)?.id).toBe(a!.id);
    expect(store.selectCredential(CLAUDE, "idle", now)?.id).toBe(a!.id);
    // Now b resets soonest, so a new conversation would start on b.
    const week = 7 * 24 * 60;
    store.recordUsage(b!.id, used(0.2, 10 * week), now);
    expect(store.selectCredential(CLAUDE, "recent", later(week - 1))?.id).toBe(a!.id);
    expect(store.selectCredential(CLAUDE, "idle", later(week + 1))?.id).toBe(b!.id);
  });

  test("a database from before usage tracking gains its columns and keeps its subscriptions", () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE subscription_credentials (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL UNIQUE, label TEXT,
      account_email TEXT, account_id TEXT, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL, unavailable_until INTEGER, unavailable_reason TEXT,
      position INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER
    )`);
    db.run(`INSERT INTO subscription_credentials (id, provider, name, access_token, refresh_token, expires_at,
      position, created_at, updated_at) VALUES ('cred_old', 'anthropic_claude_code', 'ANTHROPIC_CLAUDE_CODE_OAUTH_TOKEN',
      'access', 'refresh', ${later(600).getTime()}, 1, ${now.getTime()}, ${now.getTime()})`);
    const store = new SubscriptionStore(db);
    expect(store.list(CLAUDE).map((c) => [c.id, c.usage])).toEqual([["cred_old", null]]);
    store.recordUsage("cred_old", used(0.3, 60), now);
    expect(store.list(CLAUDE)[0]!.usage?.utilization).toBe(0.3);
  });
});
