import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import { SqliteLinkStore } from "../link/sqlite_store.js";
import { SecretBox, secretBoxFromEnv } from "./secret_box.js";
import { SubscriptionStore } from "./subscriptions/index.js";
import { tokens } from "./subscriptions/test_support.js";

// Everything the database file holds, as someone who copied the file reads it.
function dump(db: Database): string {
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return JSON.stringify(tables.map((table) => db.query(`SELECT * FROM ${table.name}`).all()));
}

test("with a key, no token, pending sign-in, or API key is readable in the database file", () => {
  const db = new Database(":memory:");
  const box = new SecretBox([randomBytes(32)]);
  const subscriptions = new SubscriptionStore(db, box);
  const links = new SqliteLinkStore(db, box);
  const plan = subscriptions.connect(tokens({ accessToken: "sk-ant-oat01-secret", refreshToken: "sk-ant-ort01-secret" }), null)!;
  const session = subscriptions.createSession({
    provider: "anthropic_claude_code",
    flow: { code_verifier: "verifier-secret" },
    credentialName: null,
    owner: "lu_1",
    movingFrom: null,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const key = links.addKey("lu_1", "openrouter", "sk-or-secret");

  const stored = dump(db);
  for (const secret of ["sk-ant-oat01-secret", "sk-ant-ort01-secret", "verifier-secret", "sk-or-secret"]) {
    expect(stored).not.toContain(secret);
  }
  // The gateway itself reads them back.
  expect(subscriptions.get(plan.id)).toMatchObject({ accessToken: "sk-ant-oat01-secret", refreshToken: "sk-ant-ort01-secret" });
  expect(subscriptions.getSession(session.token)!.flow).toEqual({ code_verifier: "verifier-secret" });
  expect(links.keysWithIds(new Set([key.id]))[0]!.apiKey).toBe("sk-or-secret");
  // Refreshed tokens are sealed too.
  subscriptions.updateTokens(plan.id, tokens({ accessToken: "sk-ant-oat01-next", refreshToken: "sk-ant-ort01-next" }));
  expect(dump(db)).not.toContain("sk-ant-oat01-next");
  expect(subscriptions.get(plan.id)!.accessToken).toBe("sk-ant-oat01-next");
});

test("a sealed value opens only in the row and column it was sealed for", () => {
  const db = new Database(":memory:");
  const box = new SecretBox([randomBytes(32)]);
  const subscriptions = new SubscriptionStore(db, box);
  const mine = subscriptions.connect(tokens({ accountEmail: "me@example.com" }), null, new Date(), "lu_me")!;
  const theirs = subscriptions.connect(tokens({ accountEmail: "them@example.com", accessToken: "sk-ant-oat01-theirs" }), null, new Date(), "lu_them")!;
  // Someone who can write the database swaps another user's token into their own row.
  db.run(
    "UPDATE subscription_credentials SET access_token = (SELECT access_token FROM subscription_credentials WHERE id = ?) WHERE id = ?",
    [theirs.id, mine.id],
  );
  expect(() => subscriptions.get(mine.id)).toThrow("does not open");
  // Nor does a plaintext value written around the gateway.
  db.run("UPDATE subscription_credentials SET access_token = 'sk-ant-oat01-planted' WHERE id = ?", [mine.id]);
  expect(() => subscriptions.get(mine.id)).toThrow("not encrypted");
  // And one altered in place does not open either.
  db.run("UPDATE subscription_credentials SET access_token = access_token || 'A' WHERE id = ?", [theirs.id]);
  expect(() => subscriptions.get(theirs.id)).toThrow("does not open");
});

test("turning encryption on seals what was stored, and a new first key re-seals it", () => {
  const db = new Database(":memory:");
  const plain = new SubscriptionStore(db);
  const plan = plain.connect(tokens({ accessToken: "sk-ant-oat01-old" }), null)!;
  new SqliteLinkStore(db).addKey("lu_1", "openai", "sk-openai-old");
  expect(dump(db)).toContain("sk-ant-oat01-old");

  const first = randomBytes(32);
  const sealed = new SubscriptionStore(db, new SecretBox([first]));
  const links = new SqliteLinkStore(db, new SecretBox([first]));
  expect(dump(db)).not.toContain("sk-ant-oat01-old");
  expect(dump(db)).not.toContain("sk-openai-old");
  expect(sealed.get(plan.id)!.accessToken).toBe("sk-ant-oat01-old");
  expect(links.keys("lu_1")[0]!.apiKey).toBe("sk-openai-old");

  // Rotation: the new key first, the old one kept for one start.
  const second = randomBytes(32);
  new SubscriptionStore(db, new SecretBox([second, first]));
  expect(new SubscriptionStore(db, new SecretBox([second])).get(plan.id)!.accessToken).toBe("sk-ant-oat01-old");
  // Without the key, or with the wrong one, the gateway says so and reads nothing.
  expect(() => new SubscriptionStore(db).get(plan.id)).toThrow("DARI_GATEWAY_ENCRYPTION_KEY");
  expect(() => new SubscriptionStore(db, new SecretBox([first]))).toThrow("DARI_GATEWAY_ENCRYPTION_KEY");
});

test("the key is 32 bytes of base64, as openssl prints it", () => {
  expect(secretBoxFromEnv(undefined)).toBeNull();
  expect(secretBoxFromEnv("  ")).toBeNull();
  const key = randomBytes(32);
  for (const text of [key.toString("base64"), key.toString("base64url"), `${key.toString("base64")}, ${randomBytes(32).toString("base64")}`]) {
    const box = secretBoxFromEnv(text)!;
    expect(new SecretBox([key]).open(box.seal("value", "here"), "here")).toBe("value");
  }
  expect(() => secretBoxFromEnv("too-short")).toThrow("32-byte");
});
