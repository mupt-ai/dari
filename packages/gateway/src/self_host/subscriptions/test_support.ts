import type { OAuthFetch, OAuthTokens } from "./oauth.js";

export type RecordedCall = { url: string; init: RequestInit; body: string };

/** A fetch that answers from a queue and records every request. */
export function fakeFetch(responses: Array<() => Response>): OAuthFetch & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: String(init.body) });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected request to ${url}`);
    return next();
  };
  return Object.assign(fetch, { calls });
}

export function jsonResponse(body: unknown, status = 200): () => Response {
  return () => Response.json(body, { status });
}

/** An unsigned JWT; only the payload matters to the gateway. */
export function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.sig`;
}

export function codexAccessToken(accountId: string, exp?: number): string {
  return jwt({ ...(exp === undefined ? {} : { exp }), "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
}

export function tokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    provider: "anthropic_claude_code",
    accessToken: "sk-ant-oat01-access",
    refreshToken: "sk-ant-ort01-refresh",
    expiresAt: new Date("2026-10-20T13:00:00Z"),
    accountId: null,
    accountEmail: "one@example.com",
    ...overrides,
  };
}
