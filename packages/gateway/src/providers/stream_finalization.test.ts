import { describe, expect, test } from "bun:test";

import type { RoutingDecision } from "@mupt-ai/dari-router/policy-engine";

import type { InteractionRequest } from "../interaction/types.js";
import type { RoutedProtocol } from "../runtime/routed_protocol.js";
import {
  createExperimentRoutedRuntimeReporter,
  type ReportableProviderOutcome,
} from "../runtime/runtime_reporter.js";
import { NO_DELIVERED_OUTPUT } from "./cancel_estimate.js";
import { createStreamFinalizer } from "./stream_finalization.js";

const ABORTED = { status: "aborted", message: null, responseBody: {} } as const;

function finalizerWith(args: {
  reportBarrier: Promise<unknown>;
  cancelBarrierCapMs: number;
}) {
  const reported: ReportableProviderOutcome["status"][] = [];
  let prefixWaits = 0;
  const reporter = {
    ...createExperimentRoutedRuntimeReporter(),
    freezeProviderTerminal(outcome: ReportableProviderOutcome) {
      return {
        async persist() {},
        report() {
          reported.push(outcome.status);
        },
      };
    },
    async waitForPrefixEntryWrite() {
      prefixWaits += 1;
    },
  };
  const finalizer = createStreamFinalizer({
    requestId: "req_test",
    interaction: {} as InteractionRequest,
    decision: {} as RoutingDecision,
    execution: {
      provider: "openai",
      model: "test/model",
      providerKeySource: "managed",
      conversationId: "conv_test",
      usageContext: undefined,
      pricing: null,
      promptEstimate: undefined,
    },
    reporter,
    protocol: {} as RoutedProtocol,
    providerLatencyMs: () => 1,
    attempt: 1,
    reportBarrier: args.reportBarrier,
    delivered: () => NO_DELIVERED_OUTPUT,
    source: { provider: "openai", api: "openai-responses", model: "test/model" },
    startedAtMs: Date.now(),
    cancelBarrierCapMs: args.cancelBarrierCapMs,
  });
  return { finalizer, reported, prefixWaits: () => prefixWaits };
}

describe("stream finalizer report barrier", () => {
  test("a detached cancel stops waiting for the selector at the cap", async () => {
    const neverSettles = new Promise<never>(() => {});
    const { finalizer, reported, prefixWaits } = finalizerWith({
      reportBarrier: neverSettles,
      cancelBarrierCapMs: 20,
    });

    const startedAt = performance.now();
    await finalizer.afterResponseDetached(ABORTED);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(reported).toEqual(["customer_canceled"]);
    expect(prefixWaits()).toBe(0);
  });

  test("the response-owned close keeps waiting for the selector", async () => {
    let releaseBarrier = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const { finalizer, reported, prefixWaits } = finalizerWith({
      reportBarrier: barrier,
      cancelBarrierCapMs: 20,
    });

    const finalization = finalizer.beforeResponseClose(ABORTED);
    await Bun.sleep(60);
    expect(reported).toEqual([]);

    releaseBarrier();
    await finalization;
    expect(reported).toEqual(["customer_canceled"]);
    expect(prefixWaits()).toBe(1);
  });
});
