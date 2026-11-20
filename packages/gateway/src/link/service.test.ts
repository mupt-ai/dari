import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { HttpError } from "../http/errors.js";
import type { LinkSubscription } from "../platform/platform.js";
import { linkGrants } from "./grants.js";
import { LINK_PERSONAL_CLIENT_ID, type LinkUsers, linkPlatform, linkTokenGrant } from "./service.js";
import { SqliteLinkStore } from "./sqlite_store.js";

const USER = "lu_1";
const KEY = "dak_personal";

const plan = (id: string, provider: string, apiKeyProvider?: string): LinkSubscription => ({
  id,
  provider,
  ...(apiKeyProvider === undefined ? {} : { apiKeyProvider }),
  name: id,
  label: null,
  accountEmail: null,
  unavailableUntil: null,
  usage: [],
});

const PLANS = [plan("sub_codex", "openai_codex"), plan("key_openai", "api_key", "openai")];

// A platform whose one user, behind `KEY`, has a ChatGPT plan and an OpenAI key.
function platform() {
  const store = new SqliteLinkStore(new Database(":memory:"));
  const users = {
    async manager(apiKey: string) {
      if (apiKey !== KEY) throw new HttpError(401, "Missing or invalid Dari API key.", "authentication_error");
      return USER;
    },
    async plans() {
      return PLANS;
    },
    async plansWithIds(ids: readonly string[]) {
      return PLANS.filter((entry) => ids.includes(entry.id));
    },
  } as unknown as LinkUsers;
  return { store, link: linkPlatform(store, users) };
}

function spent(store: SqliteLinkStore, grantId: string, credentialId: string, costUsd: number, at: Date) {
  store.recordUsage({
    requestId: crypto.randomUUID(),
    grantId,
    receivedAt: at,
    model: "openai/gpt-6.1-sol",
    thinking: null,
    tags: {},
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    status: "completed",
    costUsd,
    credentialId,
  });
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof HttpError ? error.code : "thrown";
  }
  return "ok";
}

test("a personal endpoint is a grant of its own, called with a key that does not expire", async () => {
  const { store, link } = platform();
  const { grant, key } = await link.createEndpoint({
    apiKey: KEY,
    name: " Cursor ",
    credentialIds: ["sub_codex", "key_openai"],
    limits: [{ credentialId: "sub_codex", monthlyUsd: 50 }],
  });
  expect(key.startsWith("dlk_key_")).toBe(true);
  expect(grant).toMatchObject({
    clientId: LINK_PERSONAL_CLIENT_ID,
    appName: "Cursor",
    endpoint: true,
    credentialIds: ["key_openai", "sub_codex"],
    limits: [{ credentialId: "sub_codex", monthlyUsd: 50 }],
  });

  const years = new Date(Date.now() + 5 * 365 * 86_400_000);
  expect(await linkGrants(store).authenticate(key, years)).toMatchObject({
    status: "active",
    grant: { id: grant.id, credentialIds: new Set(["key_openai", "sub_codex"]) },
  });

  // Another key serves the same grant; the first keeps working.
  const second = await link.issueEndpointKey({ apiKey: KEY, grantId: grant.id });
  expect((await linkGrants(store).authenticate(second!))?.status).toBe("active");
  expect((await linkGrants(store).authenticate(key))?.status).toBe("active");

  // Dropping a plan drops its limit; the name changes on its own.
  expect(await link.updateEndpoint({ apiKey: KEY, grantId: grant.id, name: "Zed", credentialIds: ["key_openai"] })).toBe(true);
  expect((await link.grants(KEY))[0]).toMatchObject({ appName: "Zed", credentialIds: ["key_openai"], limits: [] });

  // Revoking it stops every key.
  expect(await link.revokeGrant({ apiKey: KEY, grantId: grant.id })).toBe(true);
  expect((await linkGrants(store).authenticate(key))?.status).toBe("revoked");
});

test("an endpoint takes only the user's own plans and keys, and limits only on them", async () => {
  const { link } = platform();
  const create = (credentialIds: string[], limits = [] as Array<{ credentialId: string; monthlyUsd: number }>) =>
    codeOf(() => link.createEndpoint({ apiKey: KEY, name: "Mine", credentialIds, limits }));
  expect(await create(["sub_someone_else"])).toBe("invalid_request");
  expect(await create([])).toBe("invalid_request");
  expect(await create(["sub_codex"], [{ credentialId: "key_openai", monthlyUsd: 5 }])).toBe("invalid_request");
  expect(await codeOf(() => link.createEndpoint({ apiKey: "other", name: "Mine", credentialIds: ["sub_codex"], limits: [] })))
    .toBe("authentication_error");
});

test("a plan or key at its monthly limit leaves the grant until the month ends", async () => {
  const { store, link } = platform();
  const { grant, key } = await link.createEndpoint({
    apiKey: KEY,
    name: "Cursor",
    credentialIds: ["sub_codex", "key_openai"],
    limits: [{ credentialId: "sub_codex", monthlyUsd: 1 }, { credentialId: "key_openai", monthlyUsd: 2 }],
  });
  const now = new Date("2026-11-20T12:00:00Z");
  // Last month's spend counts for nothing now.
  spent(store, grant.id, "sub_codex", 5, new Date("2026-10-31T23:00:00Z"));
  expect([...(await linkTokenGrant(store, key, now))!.credentialIds].sort()).toEqual(["key_openai", "sub_codex"]);

  spent(store, grant.id, "sub_codex", 1.25, new Date("2026-11-02T00:00:00Z"));
  expect([...(await linkTokenGrant(store, key, now))!.credentialIds]).toEqual(["key_openai"]);

  spent(store, grant.id, "key_openai", 2, new Date("2026-11-03T00:00:00Z"));
  const refused = await linkTokenGrant(store, key, now).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(HttpError);
  expect(refused).toMatchObject({ status: 424, code: "grant_budget_exhausted" });

  // The new month serves both again.
  const december = new Date("2026-12-01T00:00:00Z");
  expect((await linkTokenGrant(store, key, december))!.credentialIds.size).toBe(2);

  // Raising a limit brings its plan back at once.
  expect(await link.setLimits({ apiKey: KEY, grantId: grant.id, limits: [{ credentialId: "sub_codex", monthlyUsd: 10 }] })).toBe(true);
  expect([...(await linkTokenGrant(store, key, now))!.credentialIds].sort()).toEqual(["key_openai", "sub_codex"]);
});
