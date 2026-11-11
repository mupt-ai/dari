import { expect, test } from "bun:test";

import { codexUsageFromReport, readCodexUsage } from "./codex_usage.js";

const NOW = new Date("2026-11-10T12:00:00Z");
const NOW_SECONDS = NOW.getTime() / 1000;

test("reads the most used Codex window with a future reset", () => {
  expect(codexUsageFromReport({
    rate_limit: {
      primary_window: { used_percent: 77, reset_at: NOW_SECONDS + 3600 },
      secondary_window: { used_percent: 41.5, reset_at: NOW_SECONDS + 86_400 },
    },
  }, NOW)).toEqual({ utilization: 0.77, resetsAt: new Date((NOW_SECONDS + 3600) * 1000) });
  expect(codexUsageFromReport({
    rate_limit: { primary_window: { used_percent: 99, reset_at: NOW_SECONDS - 60 } },
  }, NOW)).toBeNull();
  expect(codexUsageFromReport({}, NOW)).toBeNull();
});

test("asks the ChatGPT backend at most once a minute per subscription, as the account", async () => {
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } })).toString("base64url");
  const token = `header.${claims}.signature`;
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), headers: init?.headers as Record<string, string> });
    return Response.json({ rate_limit: { primary_window: { used_percent: 10, reset_at: NOW_SECONDS + 3600 } } });
  }) as typeof globalThis.fetch;
  const read = (now: number) => readCodexUsage({ credentialId: "cred_codex_throttle", accessToken: token, now, fetch });

  expect(await read(NOW.getTime())).toEqual({ utilization: 0.1, resetsAt: new Date((NOW_SECONDS + 3600) * 1000) });
  expect(await read(NOW.getTime() + 30_000)).toBeNull();
  expect(await read(NOW.getTime() + 61_000)).not.toBeNull();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({
    url: "https://chatgpt.com/backend-api/wham/usage",
    headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": "acct_1" },
  });
});
