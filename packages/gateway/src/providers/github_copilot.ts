import type { ProviderEndpoint } from "./pi.js";

// Copilot serves only editors that name themselves; these are VS Code's
// Copilot Chat, whose sign-in Dari runs.
export const COPILOT_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

/**
 * Where a Copilot token is served: its account's API origin, which the token
 * names as `proxy-ep=proxy.<host>` (`api.<host>` serves the models), with the
 * Copilot headers. A token that names none keeps the configured origin.
 */
export function copilotEndpoint(token: string): ProviderEndpoint {
  const proxy = /(?:^|;)proxy-ep=([^;]+)/.exec(token)?.[1];
  const host = proxy?.replace(/^proxy\./, "api.");
  return {
    ...(host && /^[a-z0-9.-]+$/i.test(host) ? { baseUrl: `https://${host}` } : {}),
    headers: { ...COPILOT_HEADERS },
  };
}
