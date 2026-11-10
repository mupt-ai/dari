import { refreshOAuth, type OAuthFetch } from "./oauth.js";
import type { SubscriptionCredential, SubscriptionStore } from "./store.js";

const REFRESH_MARGIN_MS = 5 * 60_000;

// One refresh per credential at a time in this process. Providers rotate
// refresh tokens, so a second concurrent refresh with the old token would fail.
const inFlight = new Map<string, Promise<string>>();

/**
 * A usable access token for a subscription, refreshed and persisted first
 * when it expires within five minutes. Records the credential as used.
 */
export async function freshAccessToken(
  store: SubscriptionStore,
  credential: SubscriptionCredential,
  options: { fetch: OAuthFetch; now?: Date },
): Promise<string> {
  const now = options.now ?? new Date();
  store.touch(credential.id, now);
  if (!expiresSoon(credential, now)) return credential.accessToken;

  const pending = inFlight.get(credential.id);
  if (pending !== undefined) return pending;
  const refresh = (async () => {
    // Another caller may have refreshed since `credential` was read.
    const current = store.get(credential.id);
    if (current === null) throw new Error("Connected subscription credential is no longer available.");
    if (!expiresSoon(current, now)) return current.accessToken;
    const tokens = await refreshOAuth(current, { fetch: options.fetch, now });
    if (tokens.provider !== current.provider) {
      throw new Error("Subscription OAuth provider returned a mismatched credential.");
    }
    store.updateTokens(current.id, tokens, now);
    return tokens.accessToken;
  })().finally(() => inFlight.delete(credential.id));
  inFlight.set(credential.id, refresh);
  return refresh;
}

function expiresSoon(credential: SubscriptionCredential, now: Date): boolean {
  return credential.expiresAt.getTime() <= now.getTime() + REFRESH_MARGIN_MS;
}
