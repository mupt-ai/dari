import { openCodeGoUsageFromReport, tokenPassUsageFromCredits } from "../../providers/subscription_limits.js";
import { claudeUsageFromReport, claudeUsageReport } from "../../providers/subscription_resets.js";
import { refreshedAccessToken } from "./access.js";
import type { OAuthFetch } from "./oauth.js";
import type { ProviderBaseUrls } from "./resets.js";
import type { SubscriptionCredential, SubscriptionStore } from "./store.js";

/**
 * Claude Code, ChatGPT, and Muse Code report usage on the responses the
 * gateway serves. OpenCode Go and Vercel Token Pass do not: Go reports it from
 * a usage endpoint that takes the plan's workspace, and Token Pass its
 * remaining credit from AI Gateway's credits endpoint. A Claude Code plan
 * that served nothing lately reports it from Claude Code's usage endpoint, as
 * hosted Dari reads it. The accounts view reads these again when the last
 * reading is stale.
 */
// A read, failed or not, is not repeated within this interval.
const READ_INTERVAL_MS = 60_000;
const READ_TIMEOUT_MS = 8_000;
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const TOKEN_PASS_CREDITS_URL = "https://ai-gateway.vercel.sh/v1/credits";

// Reads that recorded nothing (failed, or no running window), so such a plan is
// not re-read on every listing. A recorded reading stamps the credential
// itself, which a reconnect clears.
const unrecordedAt = new Map<string, number>();

/** Read every stale Claude Code, OpenCode Go, and Token Pass plan again; a failed read keeps the last one. */
export async function refreshStaleUsage(
  store: SubscriptionStore,
  options: { fetch: OAuthFetch; now?: Date; baseUrls?: ProviderBaseUrls },
): Promise<void> {
  const now = options.now ?? new Date();
  const due = (at: number | undefined) => now.getTime() - (at ?? 0) >= READ_INTERVAL_MS;
  const stale = [...store.list("anthropic_claude_code"), ...store.list("opencode_go"), ...store.list("vercel_token_pass")].filter((credential) =>
    due(credential.usage?.observedAt.getTime()) && due(unrecordedAt.get(credential.id))
  );
  await Promise.all(stale.map(async (credential) => {
    unrecordedAt.set(credential.id, now.getTime());
    try {
      await readUsage(store, credential, { ...options, now });
    } catch (error) {
      console.error(`subscription usage read failed for ${credential.name}:`, error instanceof Error ? error.message : error);
    }
  }));
}

async function readUsage(
  store: SubscriptionStore,
  credential: SubscriptionCredential,
  options: { fetch: OAuthFetch; now: Date; baseUrls?: ProviderBaseUrls },
): Promise<void> {
  const token = await refreshedAccessToken(store, credential, options);
  const usage = credential.provider === "anthropic_claude_code"
    ? claudeUsageFromReport(await claudeUsageReport(options.fetch, token, options.baseUrls?.claude), options.now)
    : credential.provider === "vercel_token_pass"
    ? await readTokenPassUsage(token, options)
    : await readOpenCodeGoUsage(credential, token, options);
  if (usage === null) return;
  unrecordedAt.delete(credential.id);
  store.recordUsage(credential.id, usage, options.now);
}

async function readOpenCodeGoUsage(
  credential: SubscriptionCredential,
  token: string,
  options: { fetch: OAuthFetch; now: Date },
) {
  const response = await options.fetch(OPENCODE_GO_USAGE_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "dari-gateway",
      ...(credential.accountId === null ? {} : { "x-opencode-org-id": credential.accountId }),
    },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  // Go answers 403 for a workspace without a Go plan.
  if (!response.ok) throw new Error(`OpenCode Go usage read failed with status ${response.status}.`);
  return openCodeGoUsageFromReport(await response.json(), options.now);
}

async function readTokenPassUsage(token: string, options: { fetch: OAuthFetch; now: Date }) {
  const response = await options.fetch(TOKEN_PASS_CREDITS_URL, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "User-Agent": "dari-gateway" },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Token Pass usage read failed with status ${response.status}.`);
  return tokenPassUsageFromCredits(await response.json(), options.now);
}
