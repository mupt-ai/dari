import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { HttpError } from "../http/errors.js";
import { LINK_ACCESS_TOKEN_TTL_MS, LINK_REFRESH_RACE_MS, LinkStore } from "./link_store.js";

const REDIRECT_URI = "https://app.example/callback";

function linked(confidential = false) {
  const store = new LinkStore(new Database(":memory:"));
  const app = store.registerApp("Notes App", [REDIRECT_URI], confidential);
  const client = { clientId: app.clientId, ...(app.clientSecret ? { clientSecret: app.clientSecret } : {}) };
  const start = new Date("2026-11-13T00:00:00Z");
  const code = store.approve({ clientId: app.clientId, redirectUri: REDIRECT_URI, codeChallenge: "c", credentialIds: ["sub_1"] }, start);
  const tokens = store.exchangeCode({ ...client, code, redirectUri: REDIRECT_URI, codeChallenge: "c" }, start);
  return { store, client, tokens, start };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof HttpError ? error.code : "thrown";
  }
  return "ok";
}

const after = (start: Date, ms: number) => new Date(start.getTime() + ms);

test("a rotated refresh token is a race within a minute and a leak after it", () => {
  const { store, client, tokens, start } = linked();
  const rotated = store.refresh({ ...client, refreshToken: tokens.refreshToken }, start);

  const soon = after(start, LINK_REFRESH_RACE_MS);
  expect(codeOf(() => store.refresh({ ...client, refreshToken: tokens.refreshToken }, soon))).toBe("refresh_race");
  expect(store.authenticate(rotated.accessToken, soon)?.status).toBe("active");

  const later = after(start, LINK_REFRESH_RACE_MS + 1);
  expect(codeOf(() => store.refresh({ ...client, refreshToken: tokens.refreshToken }, later))).toBe("invalid_grant");
  expect(store.authenticate(rotated.accessToken, later)).toMatchObject({ status: "revoked", revokedBy: "reuse_detected" });
  expect(codeOf(() => store.refresh({ ...client, refreshToken: rotated.refreshToken }, later))).toBe("invalid_grant");
});

// A thief who rotated a stolen refresh token is still caught when the app
// comes back days later, however many tokens were issued in between.
test("a rotated refresh token is still a leak days later", () => {
  const { store, client, tokens, start } = linked();
  const stolen = store.refresh({ ...client, refreshToken: tokens.refreshToken }, start);
  const days = after(start, 3 * 24 * 3_600_000);
  const kept = store.refresh({ ...client, refreshToken: stolen.refreshToken }, days);
  expect(codeOf(() => store.refresh({ ...client, refreshToken: tokens.refreshToken }, days))).toBe("invalid_grant");
  expect(store.authenticate(kept.accessToken, days)).toMatchObject({ status: "revoked", revokedBy: "reuse_detected" });
});

test("each access token lives until its own expiry, then reads as expired", () => {
  const { store, client, tokens, start } = linked();
  const halfway = after(start, LINK_ACCESS_TOKEN_TTL_MS / 2);
  const rotated = store.refresh({ ...client, refreshToken: tokens.refreshToken }, halfway);
  expect(store.authenticate(tokens.accessToken, halfway)?.status).toBe("active");

  const firstExpired = after(start, LINK_ACCESS_TOKEN_TTL_MS);
  expect(store.authenticate(tokens.accessToken, firstExpired)).toEqual({ status: "expired" });
  expect(store.authenticate(rotated.accessToken, firstExpired)?.status).toBe("active");
  // A token this store never issued is not a link token at all.
  expect(store.authenticate("dlk_at_unknown", firstExpired)).toBeNull();
  expect(store.authenticate(rotated.refreshToken, firstExpired)).toBeNull();
});

test("a child token outlives its parent access token and dies with the grant", () => {
  const { store, client, tokens, start } = linked(true);
  const child = store.exchangeToken(
    { ...client, subjectToken: tokens.accessToken, models: [{ model: "openai/gpt-5.5", thinking: "high" }, { model: "openai/gpt-5.4" }], expiresIn: 12 * 3600, tags: { run: "r1" } },
    start,
  );
  const hours = (count: number) => after(start, count * 3_600_000);
  expect(store.authenticate(tokens.accessToken, hours(2))).toEqual({ status: "expired" });
  expect(store.authenticate(child.accessToken, hours(2))).toMatchObject({
    status: "active",
    grant: {
      pins: [{ model: "openai/gpt-5.5", thinking: "high" }, { model: "openai/gpt-5.4", thinking: null }],
      tags: { run: "r1" },
    },
  });
  expect(store.authenticate(child.accessToken, hours(12))).toEqual({ status: "expired" });

  // A child cannot mint, and the wrong secret mints nothing.
  expect(codeOf(() => store.exchangeToken({ ...client, subjectToken: child.accessToken, models: [{ model: "openai/gpt-5.5" }], expiresIn: 60, tags: {} }, start)))
    .toBe("invalid_grant");
  expect(codeOf(() => store.exchangeToken({ ...client, clientSecret: "wrong", subjectToken: tokens.accessToken, models: [{ model: "openai/gpt-5.5" }], expiresIn: 60, tags: {} }, start)))
    .toBe("invalid_client");

  // Revoking a child token ends only it: a sandbox cannot end the grant.
  const second = store.exchangeToken({ ...client, subjectToken: tokens.accessToken, models: [{ model: "openai/gpt-5.5" }], expiresIn: 3600, tags: {} }, start);
  store.revokeToken({ ...client, token: second.accessToken }, start);
  expect(store.authenticate(second.accessToken, start)).toBeNull();
  expect(store.authenticate(tokens.accessToken, start)).toMatchObject({ status: "active" });

  store.revokeToken({ ...client, token: tokens.refreshToken }, hours(1));
  expect(store.authenticate(child.accessToken, hours(1))).toMatchObject({ status: "revoked", revokedBy: "app" });
  expect(codeOf(() => store.refresh({ ...client, refreshToken: tokens.refreshToken }, hours(1)))).toBe("invalid_grant");
});
