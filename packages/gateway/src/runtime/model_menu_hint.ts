import { errorResponseHeaders, HttpError, normalizeError } from "../http/errors.js";
import type { ClientHarness } from "../types.js";

/* Codex fills its /model menu from the router's model list and keeps the
   copy it read: one read before the router's models changed still offers a
   model the router no longer serves. Codex shows the user this error's
   message, so for Codex the message says how to bring the menu up to date. */
export function withModelMenuHint(error: unknown, clientHarness: ClientHarness | undefined): unknown {
  if (clientHarness !== "codex") return error;
  const { status, message, code, param } = normalizeError(error);
  if (code !== "model_not_enabled") return error;
  return new HttpError(
    status,
    `${message} Codex's /model list may be out of date: run \`dari setup codex --refresh\`.`,
    code,
    param,
    errorResponseHeaders(error),
    error instanceof HttpError ? error.body : undefined,
  );
}
