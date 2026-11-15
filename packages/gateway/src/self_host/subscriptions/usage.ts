import { openCodeGoUsageFromReport } from "../../providers/subscription_limits.js";
import { refreshedAccessToken } from "./access.js";
import type { OAuthFetch } from "./oauth.js";
import type { SubscriptionCredential, SubscriptionStore } from "./store.js";

/**
 * Claude Code, ChatGPT, and Muse Code report usage on the responses the
 * gateway serves. OpenCode Go does not: it reports it from a usage endpoint
 * that takes the plan's workspace, which the accounts view reads again when
 * the last reading is stale.
 */
// A read, failed or not, is not repeated within this interval.
const READ_INTERVAL_MS = 60_000;
const READ_TIMEOUT_MS = 8_000;
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

// Reads that recorded nothing (failed, or no running window), so such a plan is
// not re-read on every listing. A recorded reading stamps the credential
// itself, which a reconnect clears.
const unrecordedAt = new Map<string, number>();

/** Read every stale OpenCode Go plan again; a failed read keeps the last one. */
export async function refreshStaleUsage(
  store: SubscriptionStore,
  options: { fetch: OAuthFetch; now?: Date },
): Promise<void> {
  const now = options.now ?? new Date();
  const due = (at: number | undefined) => now.getTime() - (at ?? 0) >= READ_INTERVAL_MS;
  const stale = store.list("opencode_go").filter((credential) =>
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
  options: { fetch: OAuthFetch; now: Date },
): Promise<void> {
  const token = await refreshedAccessToken(store, credential, options);
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
  const usage = openCodeGoUsageFromReport(await response.json(), options.now);
  if (usage === null) return;
  unrecordedAt.delete(credential.id);
  store.recordUsage(credential.id, usage, options.now);
}
