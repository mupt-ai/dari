import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { SubscriptionStore } from "./store.js";
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
