import { boundedIdentity } from "../runtime/harness_identity/ids.js";
import type { HarnessConversationIdentity } from "../runtime/harness_identity/conversation.js";
import type { Harness } from "./index.js";

export const museCode = {
  id: "muse_code",
  headers: ["x-client-id", "x-tbh-thread-id"],
  // A Muse Code plan serves only Muse Code.
  ownPlanOnly: true,
} as const satisfies Harness;

// Muse Code names its surface (TUI, `muse exec`, desktop, `muse serve`) in
// x-client-id on every model request.
const MUSE_CODE_CLIENT_IDS = new Set(["tbh:tui", "tbh:exec", "tbh:desktop", "tbh:serve"]);

/** Muse Code's x-client-id when the request comes from Muse Code. */
export function museCodeClientId(headers: Headers): string | undefined {
  const clientId = headers.get("x-client-id")?.trim().toLowerCase();
  return clientId !== undefined && MUSE_CODE_CLIENT_IDS.has(clientId) ? clientId : undefined;
}

// Muse Code sends its thread on every Responses request. The main agent's
// thread is its session, and each subagent has its own thread, so each keeps
// its own conversation and lease.
export function museCodeConversationIdentity(
  headers: Headers,
): HarnessConversationIdentity | undefined {
  const threadId = boundedIdentity(headers.get("x-tbh-thread-id"), "x-tbh-thread-id");
  return threadId === undefined ? undefined : { kind: "muse_code_thread", value: threadId };
}
