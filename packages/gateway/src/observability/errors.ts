import { HttpError } from "../http/errors.js";
import {
  gatewayPlatform,
  type OperationalErrorContext,
  type RequestErrorContext,
} from "../platform/platform.js";

export type { OperationalErrorCode } from "../platform/platform.js";

export function captureRequestError(
  error: unknown,
  context: RequestErrorContext,
): void {
  logUnsupportedInput(error, context);
  gatewayPlatform().captureRequestError(error, context);
}

/* Platforms report only 5xx, so a client sending a block the gateway cannot
   carry would otherwise be invisible. Log the code and parameter path, never
   request content. */
function logUnsupportedInput(error: unknown, context: RequestErrorContext): void {
  if (!(error instanceof HttpError) || error.status >= 500) return;
  if (!error.code.startsWith("unsupported_") && !error.code.startsWith("no_")) return;
  console.warn(
    "routing request unsupported input",
    JSON.stringify({
      router_id: context.routerId,
      request_id: context.requestId ?? null,
      source_protocol: context.sourceProtocol,
      error_code: error.code,
      param: error.param ?? null,
      message: error.message,
    }),
  );
}

/**
 * Report failures deliberately caught outside the ingress exception path,
 * including work after a response has started and process shutdown.
 */
export function captureOperationalError(
  error: unknown,
  context: OperationalErrorContext,
): void {
  gatewayPlatform().captureOperationalError(error, context);
}
