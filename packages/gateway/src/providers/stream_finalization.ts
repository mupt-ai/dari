import type {
  ModelPricing,
  RoutingDecision,
} from "@mupt-ai/dari-router/policy-engine";

import type { InteractionRequest, ProviderIdentity } from "../interaction/types.js";
import {
  captureOperationalError,
  type OperationalErrorCode,
} from "../observability/errors.js";
import type { ProviderStreamOutcome } from "../runtime/provider_stream_outcome.js";
import type { RoutedProtocol } from "../runtime/routed_protocol.js";
import {
  reportedExecution,
  type FrozenProviderTerminal,
  type ProviderAttemptRecord,
  type ReportableProviderOutcome,
  type RoutedRuntimeReporter,
} from "../runtime/runtime_reporter.js";
import type { ProviderKeySource } from "../types.js";
import {
  reportRoutingUsage,
  type RoutingUsageContext,
} from "../telemetry/usage.js";
import { customerCanceledProviderMessage } from "../runtime/customer_disconnect.js";
import {
  estimatedCancelUsage,
  partialInteractionOutput,
  type DeliveredOutput,
  type PromptTokenEstimate,
} from "./cancel_estimate.js";

// Structurally a subset of ProviderExecution. The narrowing is deliberate: it
// keeps apiKey and auth out of the finalizer.
type StreamExecutionFacts = {
  provider: string;
  model: string;
  providerKeySource: ProviderKeySource;
  conversationId: string;
  usageContext: RoutingUsageContext | undefined;
  pricing: ModelPricing | null;
  promptEstimate: PromptTokenEstimate | undefined;
};

type CreateStreamFinalizerArgs = {
  requestId: string;
  interaction: InteractionRequest;
  decision: RoutingDecision;
  execution: StreamExecutionFacts;
  reporter: RoutedRuntimeReporter;
  protocol: RoutedProtocol;
  providerLatencyMs: () => number;
  attempt: number;
  reportBarrier?: Promise<unknown>;
  delivered: () => DeliveredOutput;
  source: ProviderIdentity;
  startedAtMs: number;
  cancelBarrierCapMs?: number;
};

/**
 * A client cancel runs its finalization in the background, where a slow
 * selector would only delay the record and, at shutdown, eat the drain budget.
 * The record still gets the selector's run when it arrives within the cap;
 * otherwise it is written without it. The response-owned path is not capped.
 */
export const CANCEL_REPORT_BARRIER_CAP_MS = 2_000;

export type StreamFinalizer = {
  beforeResponseClose(outcome: ProviderStreamOutcome): Promise<void>;
  afterResponseDetached(outcome: ProviderStreamOutcome): Promise<void>;
};

export function createStreamFinalizer(
  args: CreateStreamFinalizerArgs,
): StreamFinalizer {
  let frozen: FrozenStreamTerminal | undefined;
  let responseOwnedCompleted = false;

  async function finalize(
    outcome: ProviderStreamOutcome,
    path: "response_owned" | "detached",
  ): Promise<void> {
    frozen ??= freezeStreamTerminal(args, outcome, path);
    // Normal close calls onFinal after the response-owned barrier has already
    // succeeded. A cancellation racing that barrier reaches this branch first
    // and settles the same immutable payload.
    if (path === "detached" && responseOwnedCompleted) return;
    await frozen.reporting;
    // The response terminator waits for the fast prefix-state write. A client
    // cancellation has nothing left to hold, so its onFinal path skips this.
    if (path === "response_owned") {
      await args.reporter.waitForPrefixEntryWrite();
      responseOwnedCompleted = true;
    }
  }

  return {
    beforeResponseClose: (outcome) => finalize(outcome, "response_owned"),
    afterResponseDetached: (outcome) => finalize(outcome, "detached"),
  };
}

type FrozenStreamTerminal = {
  terminal: FrozenProviderTerminal;
  reporting: Promise<void>;
};

function freezeStreamTerminal(
  args: CreateStreamFinalizerArgs,
  outcome: ProviderStreamOutcome,
  path: "response_owned" | "detached",
): FrozenStreamTerminal {
  const report = buildStreamTerminalReport(args, outcome);
  args.reporter.recordProviderAttempt(report.attempt);
  const terminal = args.reporter.freezeProviderTerminal(report.providerOutcome);
  return {
    terminal,
    reporting: reportTerminalOnce(args, report, terminal, path),
  };
}

async function reportTerminalOnce(
  args: CreateStreamFinalizerArgs,
  report: StreamTerminalReport,
  terminal: FrozenProviderTerminal,
  path: "response_owned" | "detached",
): Promise<void> {
  const capture = (error: unknown, code: OperationalErrorCode): void =>
    captureOperationalError(error, {
      code,
      requestId: args.requestId,
      routerId: args.execution.usageContext?.routerId,
    });
  try {
    await (path === "response_owned"
      ? args.reportBarrier
      : Promise.race([
          args.reportBarrier,
          new Promise((resolve) => setTimeout(resolve, args.cancelBarrierCapMs ?? CANCEL_REPORT_BARRIER_CAP_MS)),
        ]));
  } catch (error) {
    capture(error, "routing_report_barrier_failed");
  }
  try {
    terminal.report();
    if (report.reportManagedUsage && args.execution.usageContext) {
      await reportRoutingUsage(
        args.execution.usageContext,
        report.providerMessage,
      );
    }
  } catch (error) {
    capture(error, "stream_report_finalization_failed");
  }
}

type StreamTerminalReport = {
  attempt: ProviderAttemptRecord;
  providerOutcome: ReportableProviderOutcome;
  providerMessage: Record<string, unknown>;
  reportManagedUsage: boolean;
};

function buildStreamTerminalReport(
  args: CreateStreamFinalizerArgs,
  outcome: ProviderStreamOutcome,
): StreamTerminalReport {
  const execution = reportedExecution(args.execution);
  const attemptBase = {
    model: args.decision.selectedModel,
    reasoning_effort: args.decision.reasoningEffort,
    attempt: args.attempt,
    execution,
  } as const;
  if (outcome.status === "completed") {
    const responseBody = args.protocol.responseBody({
      id: args.requestId,
      model: args.execution.model,
      output: outcome.output,
      modelCost: args.reporter.modelCost({
        ...attemptBase,
        outcome: "completed",
        message: outcome.message,
        billingOutcome: "completed",
      }),
      request: args.interaction,
      routing: args.decision,
      conversationId: args.execution.conversationId,
    });
    return {
      attempt: {
        ...attemptBase,
        outcome: "completed",
        message: outcome.message,
        billingOutcome: "completed",
      },
      providerOutcome: {
        status: "completed",
        output: outcome.output,
        message: outcome.message,
        responseBody,
        providerLatencyMs: args.providerLatencyMs(),
        execution,
      },
      providerMessage: outcome.message,
      reportManagedUsage: true,
    };
  }

  if (outcome.status === "provider_error") {
    return {
      attempt: {
        ...attemptBase,
        outcome: "terminal_error",
        message: outcome.message,
        billingOutcome: "provider_failed",
      },
      providerOutcome: {
        status: "provider_error",
        message: outcome.message,
        providerLatencyMs: args.providerLatencyMs(),
        execution,
      },
      providerMessage: outcome.message,
      reportManagedUsage: false,
    };
  }

  // The client left before the provider finished. The provider call was
  // aborted at that moment, so bill the prompt plus what was delivered.
  const delivered = args.delivered();
  const usage = estimatedCancelUsage({
    pricing: args.execution.pricing,
    promptEstimate: args.execution.promptEstimate,
    delivered,
  });
  const providerMessage = customerCanceledProviderMessage(usage);
  return {
    attempt: {
      ...attemptBase,
      outcome: "canceled",
      message: providerMessage,
      billingOutcome: "customer_canceled",
    },
    providerOutcome: {
      status: "customer_canceled",
      message: providerMessage,
      responseBody: outcome.responseBody,
      providerLatencyMs: args.providerLatencyMs(),
      execution,
      partialOutput: partialInteractionOutput({
        delivered,
        usage,
        source: args.source,
        createdAtMs: args.startedAtMs,
      }),
    },
    providerMessage,
    reportManagedUsage: true,
  };
}
