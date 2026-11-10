import { HttpError } from "../http/errors.js";

const CUSTOMER_DISCONNECTED_MESSAGE = "Client disconnected.";

export class CustomerDisconnectedError extends HttpError {
  readonly name = "CustomerDisconnectedError";

  constructor() {
    // 499 is the conventional server-side classification for a client that
    // closed the request before a response could be delivered.
    super(499, CUSTOMER_DISCONNECTED_MESSAGE, "client_disconnected");
  }
}

export type ProviderAttemptAbort = {
  readonly signal: AbortSignal;
  readonly aborted: boolean;
  abort(): void;
  dispose(): void;
};

/**
 * Give every provider attempt its own cancellation boundary tied to the
 * client's disconnect. A cancelled request stops paying the provider at once;
 * its usage is estimated from what was delivered instead of drained.
 */
export function createProviderAttemptAbort(args: {
  clientSignal?: AbortSignal;
}): ProviderAttemptAbort {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new CustomerDisconnectedError());
    }
  };
  const clientSignal = args.clientSignal;
  if (clientSignal?.aborted) {
    abort();
  } else {
    clientSignal?.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    get aborted() {
      return controller.signal.aborted;
    },
    abort,
    dispose() {
      clientSignal?.removeEventListener("abort", abort);
    },
  };
}

export function customerCanceledProviderMessage(
  usage?: Record<string, unknown>,
  responseId?: string,
): Record<string, unknown> {
  return {
    stopReason: "aborted",
    errorMessage: CUSTOMER_DISCONNECTED_MESSAGE,
    content: [],
    ...(usage ? { usage, usage_estimated: usage.estimated === true } : {}),
    ...(responseId ? { responseId } : {}),
  };
}
