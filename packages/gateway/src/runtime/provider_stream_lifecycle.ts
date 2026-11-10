import type { ProviderStreamOutcome } from "./provider_stream_outcome.js";

type LifecycleArgs = {
  partialResponse: () => Record<string, unknown>;
  onFinal?: (outcome: ProviderStreamOutcome) => void;
  onAbort?: () => void;
  cancelSignal?: AbortSignal;
  terminalOutcome?: () => ProviderStreamOutcome | null;
};

/**
 * Owns the cancel/terminal race shared by every hosted streaming protocol.
 * A provider terminal already observed always wins. Otherwise a client cancel
 * aborts the provider and finalizes the delivered partial as aborted.
 */
export class ProviderStreamLifecycle {
  private clientCanceled = false;
  private bodyCanceled = false;
  private finalized = false;
  private detachCancelSignal: () => void = () => {};

  constructor(private readonly args: LifecycleArgs) {
    const cancelSignal = args.cancelSignal;
    if (cancelSignal !== undefined) {
      const cancelFromSignal = () => {
        this.cancel(args.terminalOutcome?.() ?? null, false);
      };
      if (cancelSignal.aborted) {
        cancelFromSignal();
      } else {
        cancelSignal.addEventListener("abort", cancelFromSignal, { once: true });
        this.detachCancelSignal = () => {
          cancelSignal.removeEventListener("abort", cancelFromSignal);
        };
      }
    }
  }

  get canWrite(): boolean {
    return !this.clientCanceled;
  }

  get shouldStopConsuming(): boolean {
    return this.clientCanceled;
  }

  cancel(
    terminalOutcome: ProviderStreamOutcome | null,
    bodyCanceled = true,
  ): void {
    if (this.clientCanceled) {
      this.bodyCanceled ||= bodyCanceled;
      return;
    }
    this.clientCanceled = true;
    this.bodyCanceled = bodyCanceled;
    if (terminalOutcome !== null) {
      this.finalize(terminalOutcome);
      return;
    }
    this.args.onAbort?.();
    this.finalize({
      status: "aborted",
      message: null,
      responseBody: this.args.partialResponse(),
    });
  }

  async finish(args: {
    outcome: ProviderStreamOutcome;
    beforeClose?: (outcome: ProviderStreamOutcome) => Promise<void> | void;
    close: () => void;
  }): Promise<void> {
    if (this.clientCanceled) {
      if (!this.bodyCanceled) {
        try {
          args.close();
        } catch {
          // Bun may also cancel the body while dispatching request abort.
        }
      }
      return;
    }

    if (!this.finalized) {
      try {
        await args.beforeClose?.(args.outcome);
      } catch (error) {
        console.error("stream finalization barrier failed", error);
      }
    }
    // The client can cancel while beforeClose is awaiting persistence. In that
    // race cancel() has already finalized the provider terminal outcome.
    if (this.finalized) return;
    args.close();
    this.finalize(args.outcome);
  }

  private finalize(outcome: ProviderStreamOutcome): void {
    if (this.finalized) return;
    this.finalized = true;
    this.detachCancelSignal();
    this.args.onFinal?.(outcome);
  }
}
