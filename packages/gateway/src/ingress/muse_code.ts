// Muse Code names its surface (TUI, `muse exec`, desktop, `muse serve`) in
// x-client-id on every model request.
const MUSE_CODE_CLIENT_IDS = new Set(["tbh:tui", "tbh:exec", "tbh:desktop", "tbh:serve"]);

/** Muse Code's x-client-id when the request comes from Muse Code. */
export function museCodeClientId(headers: Headers): string | undefined {
  const clientId = headers.get("x-client-id")?.trim().toLowerCase();
  return clientId !== undefined && MUSE_CODE_CLIENT_IDS.has(clientId) ? clientId : undefined;
}
