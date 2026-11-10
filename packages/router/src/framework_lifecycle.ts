import { RouterFrameworkError } from "./framework_error.js";

export function executorStartError(error: unknown, executor: string): RouterFrameworkError {
  if (error instanceof RouterFrameworkError) return error;
  return new RouterFrameworkError(
    "executor",
    errorMessage(error, `Executor '${executor}' failed to start.`),
    "executor_setup_failed",
    undefined,
    { cause: error },
  );
}

export function safeHook(run: () => void | Promise<void>): void {
  try {
    void Promise.resolve(run()).catch(() => {
      // Hooks are fire-and-forget; a rejecting hook must never affect the
      // request or stream.
    });
  } catch {
    // Hooks are fire-and-forget; a throwing hook must never affect the
    // request or stream.
  }
}

export function normalizeError(error: unknown): RouterFrameworkError {
  if (error instanceof RouterFrameworkError) return error;
  return new RouterFrameworkError(
    "configuration",
    errorMessage(error, "Internal router error."),
    "internal_error",
    undefined,
    { cause: error },
  );
}

export function completionContract(message: string): RouterFrameworkError {
  return new RouterFrameworkError("executor", message, "executor_output_invalid");
}

export function streamContract(message: string): RouterFrameworkError {
  return new RouterFrameworkError("executor", message, "stream_invalid");
}

export function cancelled(reason: unknown): RouterFrameworkError {
  return new RouterFrameworkError(
    "cancelled",
    errorMessage(reason, "Request cancelled."),
    "request_cancelled",
  );
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled(signal.reason);
}

export async function closeAsyncIterable(iterable: AsyncIterable<unknown>): Promise<void> {
  try {
    await closeAsyncIterator(iterable[Symbol.asyncIterator]());
  } catch {
    // Cleanup errors must not replace the mode mismatch.
  }
}

export async function closeAsyncIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // Cleanup errors must not replace the request or provider failure.
  }
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}
