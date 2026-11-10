import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { freshAccessToken } from "./access.js";
import { SubscriptionStore } from "./store.js";
import { fakeFetch, jsonResponse, tokens } from "./test_support.js";

const now = new Date("2026-10-20T12:00:00Z");

function storeWithCredential(expiresInMinutes: number) {
  const store = new SubscriptionStore(new Database(":memory:"));
  const credential = store.connect(
    tokens({ expiresAt: new Date(now.getTime() + expiresInMinutes * 60_000) }),
    null,
    now,
  )!;
  return { store, credential };
}

test("a token outside the refresh margin is returned as stored", async () => {
  const { store, credential } = storeWithCredential(6);
  const fetch = fakeFetch([]);
  expect(await freshAccessToken(store, credential, { fetch, now })).toBe("sk-ant-oat01-access");
  expect(fetch.calls).toHaveLength(0);
  expect(store.get(credential.id)?.lastUsedAt).toEqual(now);
});

test("a token expiring within five minutes is refreshed and persisted", async () => {
  const { store, credential } = storeWithCredential(4);
  const fetch = fakeFetch([jsonResponse({ access_token: "refreshed", refresh_token: "rotated", expires_in: 3600 })]);
  expect(await freshAccessToken(store, credential, { fetch, now })).toBe("refreshed");
  expect(JSON.parse(fetch.calls[0]!.body)).toMatchObject({ grant_type: "refresh_token", refresh_token: "sk-ant-ort01-refresh" });
  expect(store.get(credential.id)).toMatchObject({
    accessToken: "refreshed",
    refreshToken: "rotated",
    expiresAt: new Date("2026-10-20T13:00:00Z"),
  });
  // The stale in-memory copy no longer triggers another refresh.
  expect(await freshAccessToken(store, credential, { fetch, now })).toBe("refreshed");
  expect(fetch.calls).toHaveLength(1);
});

test("concurrent callers share one refresh", async () => {
  const { store, credential } = storeWithCredential(-1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetch = fakeFetch([jsonResponse({ access_token: "once", expires_in: 3600 })]);
  const gated = Object.assign(async (url: string, init: RequestInit) => {
    await gate;
    return fetch(url, init);
  }, { calls: fetch.calls });
  const results = Promise.all([1, 2, 3].map(() => freshAccessToken(store, credential, { fetch: gated, now })));
  release();
  expect(await results).toEqual(["once", "once", "once"]);
  expect(fetch.calls).toHaveLength(1);
});

test("a failed refresh does not wedge later attempts", async () => {
  const { store, credential } = storeWithCredential(0);
  const fetch = fakeFetch([
    jsonResponse({ error: "invalid_grant" }, 400),
    jsonResponse({ access_token: "second", expires_in: 3600 }),
  ]);
  await expect(freshAccessToken(store, credential, { fetch, now }))
    .rejects.toThrow("Anthropic subscription token refresh failed with provider status 400.");
  expect(await freshAccessToken(store, credential, { fetch, now })).toBe("second");
});
