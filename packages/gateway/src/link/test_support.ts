/* Shortcuts for tests that need an app or a grant without the pages. */

import { LINK_CLIENT_SECRET_PREFIX, LINK_CODE_PREFIX, LINK_CODE_TTL_MS, linkHash, linkSecret } from "./grants.js";
import type { SqliteLinkStore } from "./sqlite_store.js";

/** Register an app straight into the store; a confidential one gets its secret back. */
export function addTestApp(store: SqliteLinkStore, name: string, redirectUris: string[], confidential = false) {
  const clientId = `lnk_${crypto.randomUUID().replaceAll("-", "")}`;
  const clientSecret = confidential ? linkSecret(LINK_CLIENT_SECRET_PREFIX) : undefined;
  store.addApp({ clientId, name, redirectUris, confidential, clientSecretHash: clientSecret === undefined ? null : linkHash(clientSecret) });
  return { clientId, name, redirectUris, confidential, ...(clientSecret === undefined ? {} : { clientSecret }) };
}

/** Approve a grant straight into the store and return its code. */
export function approveTestGrant(
  store: SqliteLinkStore,
  request: { subject?: string; clientId: string; redirectUri: string; codeChallenge: string; credentialIds: string[] },
  now = new Date(),
): string {
  const code = linkSecret(LINK_CODE_PREFIX);
  store.saveGrant({
    subject: request.subject ?? "lu_test",
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    codeHash: linkHash(code),
    codeChallenge: request.codeChallenge,
    codeExpiresAt: now.getTime() + LINK_CODE_TTL_MS,
    credentialIds: request.credentialIds,
    budget: [],
    now: now.getTime(),
  });
  return code;
}
