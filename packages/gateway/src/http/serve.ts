import { captureOperationalError } from "../observability/errors.js";
import { drainBackgroundTelemetryFor } from "../telemetry/background.js";
import { startHttp2Server } from "./http2_server.js";

const GRACEFUL_SERVER_STOP_TIMEOUT_MS = 5_000;
const FORCE_STOP_SETTLE_TIMEOUT_MS = 250;
// Container platforms commonly send SIGKILL 10 seconds after SIGTERM. Reserve
// the final 2 seconds for closing telemetry clients and 500ms for process
// scheduling.
const SHUTDOWN_WORK_TIMEOUT_MS = 7_500;

type StoppableServer = {
  stop(force?: boolean): Promise<void>;
};

export function startServer(
  listenPort: number,
  handler: (request: Request) => Promise<Response>,
  options: { http2?: boolean; hostname?: string } = {},
) {
  if (options.http2) {
    return startHttp2Server(listenPort, handler, options.hostname);
  }

  // The selector runs before the first response byte, and routed models can
  // remain silent while reasoning. Disable Bun's default 10s idle timeout;
  // clients and infrastructure still bound total request lifetime.
  return Bun.serve({
    port: listenPort,
    hostname: options.hostname,
    fetch: handler,
    idleTimeout: 0,
  });
}

/**
 * On SIGTERM/SIGINT: stop accepting work, let active requests finish, drain
 * background reporting within the shutdown budget, run `closeClients`, exit.
 */
export function installShutdownHandlers(
  server: StoppableServer,
  closeClients: () => Promise<unknown>,
): void {
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const workDeadlineAtMs = performance.now() + SHUTDOWN_WORK_TIMEOUT_MS;
    console.info("gateway server shutting down", JSON.stringify({ signal }));
    try {
      await stopServerForShutdown(server);
    } finally {
      const remaining = await drainBackgroundTelemetryFor(
        Math.max(0, workDeadlineAtMs - performance.now()),
      );
      if (remaining > 0) {
        console.warn(
          "gateway server background drain timed out",
          JSON.stringify({ remaining_task_count: remaining }),
        );
        captureOperationalError(
          new Error(`Routing shutdown abandoned ${remaining} background task(s).`),
          { code: "background_drain_timeout" },
        );
      }
      await closeClients();
      process.exit(0);
    }
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

/**
 * stop(false) refuses new work and lets active requests finish; if that does
 * not settle in time, one stop(true) destroys what is left so stream
 * cancellation registers its finalizers before the background drain starts.
 * Both calls are bounded: a hung stop promise must not consume the shutdown
 * budget.
 */
export async function stopServerForShutdown(
  server: StoppableServer,
  gracefulTimeoutMs: number = GRACEFUL_SERVER_STOP_TIMEOUT_MS,
  forceStopSettleTimeoutMs: number = FORCE_STOP_SETTLE_TIMEOUT_MS,
): Promise<void> {
  if ((await stopWithin(server, false, gracefulTimeoutMs)) !== "timed_out") {
    return;
  }
  if ((await stopWithin(server, true, forceStopSettleTimeoutMs)) === "timed_out") {
    reportServerStopFailure(
      new Error("Routing server force-stop settlement timed out."),
    );
  }
}

function stopWithin(
  server: StoppableServer,
  force: boolean,
  timeoutMs: number,
): Promise<"stopped" | "failed" | "timed_out"> {
  return Promise.race([
    new Promise<void>((resolve) => resolve(server.stop(force))).then(
      () => "stopped" as const,
      (error: unknown) => {
        reportServerStopFailure(error);
        return "failed" as const;
      },
    ),
    Bun.sleep(timeoutMs).then(() => "timed_out" as const),
  ]);
}

function reportServerStopFailure(error: unknown): void {
  console.warn(
    "gateway server shutdown failed",
    error instanceof Error ? error.name : "UnknownError",
  );
  captureOperationalError(error, { code: "server_force_stop_failed" });
}
