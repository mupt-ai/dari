import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { HttpError } from "../http/errors.js";
import type { LinkLimit, LinkSubscription } from "../platform/platform.js";
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

// A platform whose one user, behind `KEY`, has a ChatGPT plan and an OpenAI key.
function platform() {
  const store = new SqliteLinkStore(new Database(":memory:"));
  const PLANS = [plan("sub_codex", "openai_codex"), plan("key_openai", "api_key", "openai")];
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
  return { store, users, codex: PLANS[0]!, link: linkPlatform(store, users) };
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
    limits: [{ credentialId: "sub_codex", maxPercent: 50 }],
  });
  expect(key.startsWith("dlk_key_")).toBe(true);
  expect(grant).toMatchObject({
    clientId: LINK_PERSONAL_CLIENT_ID,
    appName: "Cursor",
    endpoint: true,
    credentialIds: ["key_openai", "sub_codex"],
    limits: [{ credentialId: "sub_codex", maxPercent: 50 }],
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
  const create = (credentialIds: string[], limits = [] as LinkLimit[]) =>
    codeOf(() => link.createEndpoint({ apiKey: KEY, name: "Mine", credentialIds, limits }));
  expect(await create(["sub_someone_else"])).toBe("invalid_request");
  expect(await create([])).toBe("invalid_request");
  expect(await create(["sub_codex"], [{ credentialId: "key_openai", monthlyUsd: 5 }])).toBe("invalid_request");
  // A share of quota is for a plan, not a key.
  expect(await create(["key_openai"], [{ credentialId: "key_openai", maxPercent: 50 }])).toBe("invalid_request");
  expect(await codeOf(() => link.createEndpoint({ apiKey: "other", name: "Mine", credentialIds: ["sub_codex"], limits: [] })))
    .toBe("authentication_error");
});

test("a key at its monthly limit leaves the grant until the month ends", async () => {
  const { store, users, link } = platform();
  const { grant, key } = await link.createEndpoint({
    apiKey: KEY,
    name: "Cursor",
    credentialIds: ["sub_codex", "key_openai"],
    limits: [{ credentialId: "key_openai", monthlyUsd: 2 }],
  });
  const now = new Date("2026-11-20T12:00:00Z");
  // Last month's spend counts for nothing now.
  spent(store, grant.id, "key_openai", 5, new Date("2026-10-31T23:00:00Z"));
  expect((await linkTokenGrant(store, users, key, now))!.credentialIds.size).toBe(2);

  spent(store, grant.id, "key_openai", 2, new Date("2026-11-03T00:00:00Z"));
  expect([...(await linkTokenGrant(store, users, key, now))!.credentialIds]).toEqual(["sub_codex"]);

  // The new month serves both again.
  expect((await linkTokenGrant(store, users, key, new Date("2026-12-01T00:00:00Z")))!.credentialIds.size).toBe(2);

  // Raising a limit brings its key back at once.
  expect(await link.setLimits({ apiKey: KEY, grantId: grant.id, limits: [{ credentialId: "key_openai", monthlyUsd: 10 }] })).toBe(true);
  expect((await linkTokenGrant(store, users, key, now))!.credentialIds.size).toBe(2);
});

test("a plan at its share of quota leaves the grant until that window resets", async () => {
  const { store, users, codex, link } = platform();
  const { grant, key } = await link.createEndpoint({
    apiKey: KEY,
    name: "Cursor",
    credentialIds: ["sub_codex"],
    limits: [{ credentialId: "sub_codex", maxPercent: 70 }],
  });
  // The page reads standings at the real time, so windows are set from it.
  const now = new Date();
  const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();
  const fiveHours = at(2);
  const week = at(90);
  // No reported usage yet: never at the limit.
  expect((await linkTokenGrant(store, users, key, now))!.credentialIds.size).toBe(1);

  // A model's own window and a window already reset do not count.
  codex.usage = [
    { minutes: 300, utilization: 0.4, resetsAt: fiveHours },
    { minutes: 10080, utilization: 0.95, resetsAt: at(-1) },
    { modelFamily: "fable", minutes: 10080, utilization: 1, resetsAt: week },
  ];
  expect((await linkTokenGrant(store, users, key, now))!.credentialIds.size).toBe(1);

  // Usage outside the grant counts too: the rest is the user's.
  codex.usage = [{ minutes: 300, utilization: 0.72, resetsAt: fiveHours }, { minutes: 10080, utilization: 0.7, resetsAt: week }];
  const refused = await linkTokenGrant(store, users, key, now).catch((error: unknown) => error);
  expect(refused).toMatchObject({ status: 424, code: "grant_budget_exhausted" });
  const [standing] = (await link.grants(KEY)).find((entry) => entry.id === grant.id)!.spend;
  // Back once every window at the limit has reset.
  expect(standing).toMatchObject({ maxPercent: 70, usedPercent: 72, reached: true, resetsAt: week });
});
