import { ProviderStreamLifecycle } from "../../runtime/provider_stream_lifecycle.js";
import {
  providerFailure,
  providerFailureFromCaught,
  providerFailureFromTerminal,
  type ProviderStreamOutcome,
} from "../../runtime/provider_stream_outcome.js";
import { DeliveredStreamSnapshot } from "./delivered_stream_snapshot.js";

export type SseStreamLifecycleArgs = {
  onFinal?: (outcome: ProviderStreamOutcome) => void;
  beforeClose?: (outcome: ProviderStreamOutcome) => Promise<void> | void;
  clientSignal?: AbortSignal;
  onAbort?: () => void;
};

export type SseStreamContext = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  snapshot: DeliveredStreamSnapshot;
  lifecycle: ProviderStreamLifecycle;
  settle(outcome: ProviderStreamOutcome): void;
  observeTerminal(message: Record<string, unknown>): void;
};

export type SseStreamHandlers = {
  consume(): Promise<void>;
  emitProviderError(message: Record<string, unknown>): void;
  close(outcome: ProviderStreamOutcome): void;
};

/**
 * The cancel/terminal skeleton every hosted SSE protocol shares. The protocol
 * owns its wire encoding and event translation; this owns the terminal race,
 * the fallback terminals, and the single finish that closes the response.
 */
export function sseStream(args: {
  protocol: string;
  lifecycle: SseStreamLifecycleArgs;
  start: (context: SseStreamContext) => SseStreamHandlers;
}): ReadableStream<Uint8Array> {
  let terminalOutcome: ProviderStreamOutcome | null = null;
  let terminalMessage: Record<string, unknown> | null = null;
  const snapshot = new DeliveredStreamSnapshot(args.protocol);
  const lifecycle = new ProviderStreamLifecycle({
    partialResponse: () => snapshot.body(),
    onFinal: args.lifecycle.onFinal,
    onAbort: args.lifecycle.onAbort,
    cancelSignal: args.lifecycle.clientSignal,
    terminalOutcome: () => terminalOutcome,
  });

  return new ReadableStream({
    cancel() {
      lifecycle.cancel(terminalOutcome);
    },
    async start(controller) {
      const handlers = args.start({
        controller,
        snapshot,
        lifecycle,
        settle: (outcome) => {
          terminalOutcome = outcome;
        },
        observeTerminal: (message) => {
          terminalMessage = message;
        },
      });
      const failTerminal = (message: Record<string, unknown>) => {
        terminalOutcome = { status: "provider_error", message };
        handlers.emitProviderError(message);
      };

      try {
        await handlers.consume();
        if (!terminalOutcome && !lifecycle.shouldStopConsuming) {
          failTerminal(
            providerFailure("Provider stream ended without a terminal event."),
          );
        }
      } catch (error) {
        if (!lifecycle.shouldStopConsuming) {
          failTerminal(
            terminalMessage
              ? providerFailureFromTerminal(error, terminalMessage)
              : providerFailureFromCaught(error),
          );
        }
      } finally {
        const outcome = terminalOutcome ?? {
          status: "aborted",
          message: null,
          responseBody: snapshot.body(),
        };
        await lifecycle.finish({
          outcome,
          beforeClose: args.lifecycle.beforeClose,
          close: () => handlers.close(outcome),
        });
      }
    },
  });
}
