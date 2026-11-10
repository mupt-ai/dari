const pendingTelemetry = new Set<Promise<unknown>>();

export function trackBackgroundTelemetry(task: Promise<unknown>): void {
  pendingTelemetry.add(task);
  void task.then(
    () => pendingTelemetry.delete(task),
    () => pendingTelemetry.delete(task),
  );
}

export async function drainBackgroundTelemetry(): Promise<void> {
  while (pendingTelemetry.size > 0) {
    await Promise.allSettled([...pendingTelemetry]);
  }
}

/**
 * Drain until every tracked task settles or the timeout passes. Tasks tracked
 * while draining are included. Returns how many tasks were still pending.
 */
export async function drainBackgroundTelemetryFor(
  timeoutMs: number,
): Promise<number> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve();
    }, Math.max(0, timeoutMs));
  });
  try {
    while (pendingTelemetry.size > 0 && !expired) {
      await Promise.race([Promise.allSettled([...pendingTelemetry]), deadline]);
    }
  } finally {
    clearTimeout(timer);
  }
  return pendingTelemetry.size;
}
