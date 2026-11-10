/**
 * Personal subscriptions for a self-hosted, single-tenant gateway: Claude Code
 * (Max/Pro) and ChatGPT (Codex) plans connected over OAuth and used in place
 * of API keys.
 *
 * - `oauth.ts`: the providers' OAuth protocols (Claude Code PKCE with a
 *   pasted `code#state`, ChatGPT device code) and token refresh.
 * - `store.ts`: SQLite storage. Tokens are plaintext in the gateway's own
 *   database file; protect that file like a secret.
 * - `access.ts`: `freshAccessToken` refreshes a token expiring within five
 *   minutes before handing it out, one refresh per credential at a time.
 * - `http.ts`: `handleSubscriptionRequest` serves the credential endpoints the
 *   Dari CLI uses to connect, list, rename, release, and disconnect
 *   subscriptions. The caller authenticates the request first.
 *
 * Routing picks `store.activeCredential(provider)`: the subscription in use
 * while it serves, then the next one in connection order that is not held. When a provider reports a usage limit,
 * `store.markUnavailable` holds that subscription until its reset and says
 * whether another one can serve the retry.
 */
export { freshAccessToken } from "./access.js";
export { handleSubscriptionRequest, type SubscriptionHttpDeps } from "./http.js";
export {
  CODEX_APPROVAL_PENDING,
  SUBSCRIPTION_PROVIDERS,
  SubscriptionOAuthInputError,
  SubscriptionOAuthProviderError,
  completeOAuth,
  parseAuthorizationResponse,
  refreshOAuth,
  startOAuth,
  type OAuthAuthorization,
  type OAuthFetch,
  type OAuthOptions,
  type OAuthTokens,
  type SubscriptionProvider,
} from "./oauth.js";
export {
  SubscriptionStore,
  isHeld,
  type PendingOAuthSession,
  type SubscriptionCredential,
} from "./store.js";
