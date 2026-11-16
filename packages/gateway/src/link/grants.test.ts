import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { HttpError } from "../http/errors.js";
import { LINK_ACCESS_TOKEN_TTL_MS, LINK_REFRESH_RACE_MS, linkGrants } from "./grants.js";
import { SqliteLinkStore } from "./sqlite_store.js";
import { addTestApp, approveTestGrant } from "./test_support.js";

const REDIRECT_URI = "https://app.example/callback";

async function linked(confidential = false) {
  const store = new SqliteLinkStore(new Database(":memory:"));
  const link = linkGrants(store);
  const app = addTestApp(store, "Notes App", [REDIRECT_URI], confidential);
  const client = { clientId: app.clientId, ...(app.clientSecret ? { clientSecret: app.clientSecret } : {}) };
  const start = new Date("2026-11-13T00:00:00Z");
  const code = approveTestGrant(store, { clientId: app.clientId, redirectUri: REDIRECT_URI, codeChallenge: "c", credentialIds: ["sub_1"] }, start);
  const tokens = await link.exchangeCode({ ...client, code, redirectUri: REDIRECT_URI, codeChallenge: "c" }, start);
  return { store, link, client, tokens, start };
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof HttpError ? error.code : "thrown";
  }
  return "ok";
}

const after = (start: Date, ms: number) => new Date(start.getTime() + ms);

test("a rotated refresh token is a race within a minute and a leak after it", async () => {
  const { store, link, client, tokens, start } = await linked();
  const rotated = await link.refresh({ ...client, refreshToken: tokens.refreshToken }, start);

  const soon = after(start, LINK_REFRESH_RACE_MS);
  expect(await codeOf(() => link.refresh({ ...client, refreshToken: tokens.refreshToken }, soon))).toBe("refresh_race");
  expect((await link.authenticate(rotated.accessToken, soon))?.status).toBe("active");

  const later = after(start, LINK_REFRESH_RACE_MS + 1);
  expect(await codeOf(() => link.refresh({ ...client, refreshToken: tokens.refreshToken }, later))).toBe("invalid_grant");
  expect((await link.authenticate(rotated.accessToken, later))).toMatchObject({ status: "revoked", revokedBy: "reuse_detected" });
  expect(await codeOf(() => link.refresh({ ...client, refreshToken: rotated.refreshToken }, later))).toBe("invalid_grant");
});

// A thief who rotated a stolen refresh token is still caught when the app
// comes back days later, however many tokens were issued in between.
test("a rotated refresh token is still a leak days later", async () => {
  const { store, link, client, tokens, start } = await linked();
  const stolen = await link.refresh({ ...client, refreshToken: tokens.refreshToken }, start);
  const days = after(start, 3 * 24 * 3_600_000);
  const kept = await link.refresh({ ...client, refreshToken: stolen.refreshToken }, days);
  expect(await codeOf(() => link.refresh({ ...client, refreshToken: tokens.refreshToken }, days))).toBe("invalid_grant");
  expect((await link.authenticate(kept.accessToken, days))).toMatchObject({ status: "revoked", revokedBy: "reuse_detected" });
});

test("each access token lives until its own expiry, then reads as expired", async () => {
  const { store, link, client, tokens, start } = await linked();
  const halfway = after(start, LINK_ACCESS_TOKEN_TTL_MS / 2);
  const rotated = await link.refresh({ ...client, refreshToken: tokens.refreshToken }, halfway);
  expect((await link.authenticate(tokens.accessToken, halfway))?.status).toBe("active");

  const firstExpired = after(start, LINK_ACCESS_TOKEN_TTL_MS);
  expect((await link.authenticate(tokens.accessToken, firstExpired))).toEqual({ status: "expired" });
  expect((await link.authenticate(rotated.accessToken, firstExpired))?.status).toBe("active");
  // A token this store never issued is not a link token at all.
  expect((await link.authenticate("dlk_at_unknown", firstExpired))).toBeNull();
  expect((await link.authenticate(rotated.refreshToken, firstExpired))).toBeNull();
});

test("a child token outlives its parent access token and dies with the grant", async () => {
  const { store, link, client, tokens, start } = await linked(true);
  const child = await link.exchangeToken(
    { ...client, subjectToken: tokens.accessToken, models: [{ model: "openai/gpt-5.5", thinking: "high" }, { model: "openai/gpt-5.4" }], expiresIn: 12 * 3600, tags: { run: "r1" } },
    start,
  );
  const hours = (count: number) => after(start, count * 3_600_000);
  expect((await link.authenticate(tokens.accessToken, hours(2)))).toEqual({ status: "expired" });
  expect((await link.authenticate(child.accessToken, hours(2)))).toMatchObject({
    status: "active",
    grant: {
      pins: [{ model: "openai/gpt-5.5", thinking: "high" }, { model: "openai/gpt-5.4", thinking: null }],
      tags: { run: "r1" },
    },
  });
  expect((await link.authenticate(child.accessToken, hours(12)))).toEqual({ status: "expired" });

  // A child cannot mint, and the wrong secret mints nothing.
  expect(await codeOf(() => link.exchangeToken({ ...client, subjectToken: child.accessToken, models: [{ model: "openai/gpt-5.5" }], expiresIn: 60, tags: {} }, start)))
    .toBe("invalid_grant");
  expect(await codeOf(() => link.exchangeToken({ ...client, clientSecret: "wrong", subjectToken: tokens.accessToken, models: [{ model: "openai/gpt-5.5" }], expiresIn: 60, tags: {} }, start)))
    .toBe("invalid_client");

  // Revoking a child token ends only it: a sandbox cannot end the grant.
  const second = await link.exchangeToken({ ...client, subjectToken: tokens.accessToken, models: [{ model: "openai/gpt-5.5" }], expiresIn: 3600, tags: {} }, start);
  await link.revokeToken({ ...client, token: second.accessToken }, start);
  expect((await link.authenticate(second.accessToken, start))).toBeNull();
  expect((await link.authenticate(tokens.accessToken, start))).toMatchObject({ status: "active" });

  await link.revokeToken({ ...client, token: tokens.refreshToken }, hours(1));
  expect((await link.authenticate(child.accessToken, hours(1)))).toMatchObject({ status: "revoked", revokedBy: "app" });
  expect(await codeOf(() => link.refresh({ ...client, refreshToken: tokens.refreshToken }, hours(1)))).toBe("invalid_grant");
});
