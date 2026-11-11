import { CODEX_USAGE_WINDOWS, type SubscriptionUsage, subscriptionUsageFromWindows } from "./subscription_limits.js";

// Codex calls run over a WebSocket that bypasses fetch, so a ChatGPT plan's
// usage never reaches the gateway as response headers. The ChatGPT backend's
// usage report (the endpoint behind the Codex CLI's /status) has the same
// windows; read it after a served call, at most once a minute per subscription.
const CODEX_USAGE_INTERVAL_MS = 60_000;
const CODEX_USAGE_TIMEOUT_MS = 8_000;
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const ACCOUNT_CLAIM = "https://api.openai.com/auth";

const readAt = new Map<string, number>();

export async function readCodexUsage(args: {
  credentialId: string;
  accessToken: string;
  baseUrl?: string;
  now?: number;
  fetch?: typeof fetch;
}): Promise<SubscriptionUsage | null> {
  const now = args.now ?? Date.now();
  const last = readAt.get(args.credentialId);
  if (last !== undefined && now - last < CODEX_USAGE_INTERVAL_MS) return null;
  readAt.set(args.credentialId, now);

  const accountId = codexAccountId(args.accessToken);
  const response = await (args.fetch ?? globalThis.fetch)(
    `${(args.baseUrl ?? DEFAULT_CODEX_BASE_URL).replace(/\/$/, "")}/wham/usage`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${args.accessToken}`,
        ...(accountId === null ? {} : { "ChatGPT-Account-Id": accountId }),
      },
      signal: AbortSignal.timeout(CODEX_USAGE_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error(`Codex usage report failed with status ${response.status}.`);
  return codexUsageFromReport(await response.json(), new Date(now));
}

/** Every Codex window with a future reset, or null when the report has none. */
export function codexUsageFromReport(report: unknown, now: Date): SubscriptionUsage | null {
  const rateLimit = isRecord(report) && isRecord(report.rate_limit) ? report.rate_limit : {};
  return subscriptionUsageFromWindows(CODEX_USAGE_WINDOWS.map(([name, minutes]) => {
    const window = isRecord(rateLimit[`${name}_window`]) ? rateLimit[`${name}_window`] as Record<string, unknown> : {};
    const { used_percent: used, reset_at: resetAt, limit_window_seconds: seconds } = window;
    return {
      minutes: typeof seconds === "number" && seconds > 0 ? Math.round(seconds / 60) : minutes,
      used: typeof used === "number" ? used / 100 : NaN,
      resetsAt: typeof resetAt === "number" ? new Date(resetAt * 1000) : null,
    };
  }), now);
}

function codexAccountId(token: string): string | null {
  const [, payload] = token.split(".");
  if (payload === undefined) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const auth = isRecord(claims) ? claims[ACCOUNT_CLAIM] : undefined;
    const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
    return typeof accountId === "string" && accountId ? accountId : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
