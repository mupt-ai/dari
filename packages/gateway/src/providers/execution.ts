import type { RoutingDecision } from "@mupt-ai/dari-router/policy-engine";
import { HttpError } from "../http/errors.js";
import { piMessageToInteractionOutput } from "./pi_output.js";
import type { InteractionRequest } from "../interaction/types.js";
import { captureOperationalError } from "../observability/errors.js";
import {
  CustomerDisconnectedError,
  customerCanceledProviderMessage,
} from "../runtime/customer_disconnect.js";
import {
  isProviderFailureMessage,
  providerFailureFromCaught,
  providerFailureFromTerminal,
  providerFailureMessage,
} from "../runtime/provider_stream_outcome.js";
import {
  reportedExecution,
  type ReportableProviderOutcome,
  type RoutedRuntimeReporter,
} from "../runtime/runtime_reporter.js";
import type { RoutedProtocol } from "../runtime/routed_protocol.js";
import { trackBackgroundTelemetry } from "../telemetry/background.js";
import { gatewayPlatform, type SubscriptionHold } from "../platform/platform.js";
import { reportRoutingUsage } from "../telemetry/usage.js";
import {
  prepareProviderExecution,
  primeProviderStream,
  scrubProviderMessage,
  startProviderCompletion,
  startProviderStream,
  type CompletedProviderCall,
  type ProviderExecution,
  type StartedCompletion,
  type StartedStream,
} from "./provider_call.js";
import {
  runProviderAttemptPlan,
  type ProviderAttemptFailure,
  type ProviderAttemptPlanResult,
  type ProviderAttemptResult,
} from "./provider_attempt_runner.js";
import {
  estimatedCancelUsage,
  NO_DELIVERED_OUTPUT,
  observeDeliveredOutput,
} from "./cancel_estimate.js";
import { providerResponseCaptureFromError, type ProviderResponseCapture } from "./response_capture.js";
import { createStreamFinalizer } from "./stream_finalization.js";
import {
  detectSubscriptionUsageLimit,
  failureWithSubscriptionUsageLimit,
  retryAfterSeconds,
  subscriptionUsageLimitFromFailure,
  subscriptionSwitchedMessage,
  subscriptionUsageLimitMessage,
} from "./subscription_limits.js";

export type ProviderChoice = {
  decision: RoutingDecision;
  execution: ProviderExecution;
};

export type PreparedStreamExecution = {
  choice: ProviderChoice;
  started: StartedStream;
  attempt: number;
  failedSetupLatencyMs: number;
};

export type CompletedNonStreamingExecution = {
  choice: ProviderChoice;
  output: ReturnType<typeof piMessageToInteractionOutput>;
  responseBody: Record<string, unknown>;
  reportBarrierError?: unknown;
};

type CompletedNonStreamingAttempt = {
  completion: CompletedProviderCall;
};

export async function executeNonStreaming(args: {
  requestId: string;
  interaction: InteractionRequest;
  primary: ProviderChoice;
  primaryRetries: number;
  reporter: RoutedRuntimeReporter;
  protocol: RoutedProtocol;
  startedCompletion?: StartedCompletion;
  reportBarrier?: Promise<unknown>;
  clientSignal?: AbortSignal;
}): Promise<Response> {
  const result = await completeNonStreaming(args);
  if (result.reportBarrierError !== undefined) {
    captureOperationalError(result.reportBarrierError, {
      code: "routing_report_barrier_failed",
      requestId: args.requestId,
      routerId: result.choice.execution.usageContext?.routerId,
    });
  }
  return Response.json(result.responseBody, {
    headers: result.choice.execution.headers,
  });
}

export async function completeNonStreaming(args: {
  requestId: string;
  interaction: InteractionRequest;
  primary: ProviderChoice;
  primaryRetries: number;
  reporter: RoutedRuntimeReporter;
  protocol: RoutedProtocol;
  startedCompletion?: StartedCompletion;
  reportBarrier?: Promise<unknown>;
  clientSignal?: AbortSignal;
}): Promise<CompletedNonStreamingExecution> {
  const result = await completeWithRetries(args);
  args.reporter.attachServingDecision(result.choice.decision);
  if (result.kind === "customer_canceled") {
    return reportCustomerCancellation({
      requestId: args.requestId,
      reporter: args.reporter,
      choice: result.choice,
      providerLatencyMs: result.latencyMs,
      providerMessage: result.failure,
      reportBarrier: args.reportBarrier,
    });
  }
  if (result.kind === "provider_failed") {
    return throwProviderFailure({
      requestId: args.requestId,
      reporter: args.reporter,
      reportBarrier: args.reportBarrier,
      result,
    });
  }

  const {
    value: { completion },
    choice,
  } = result;
  let output: ReturnType<typeof piMessageToInteractionOutput>;
  let responseBody: Record<string, unknown>;
  try {
    output = piMessageToInteractionOutput(
      completion.message,
      completion.source,
      args.interaction,
    );
    responseBody = args.protocol.responseBody({
      id: args.requestId,
      model: choice.execution.model,
      output,
      modelCost: args.reporter.modelCost({
        model: choice.decision.selectedModel, reasoning_effort: choice.decision.reasoningEffort,
        attempt: result.attempt, outcome: "completed", billingOutcome: "completed",
        execution: reportedExecution(choice.execution), message: completion.message,
      }),
      request: args.interaction,
      routing: choice.decision,
      conversationId: choice.execution.conversationId,
    });
  } catch (error) {
    await reportTerminalProviderFailure({
      requestId: args.requestId,
      reporter: args.reporter,
      choice,
      attempt: result.attempt,
      providerLatencyMs: result.latencyMs,
      providerMessage: completion.message,
      reportBarrier: args.reportBarrier,
      error,
    });
    // reportTerminalProviderFailure always throws the original translation
    // error after settling exact billing. Keep this explicit for TypeScript's
    // definite-assignment analysis.
    throw error;
  }
  recordProviderAttempt(
    args.reporter,
    choice,
    result.attempt,
    "completed",
    "completed",
    completion.message,
  );
  const providerOutcome = {
    status: "completed",
    output,
    message: completion.message,
    responseBody,
    providerLatencyMs: result.latencyMs,
    execution: reportedExecution(choice.execution),
  } as const;
  // Provider economics are terminal now. Register them before the speculative
  // selector/report barrier so the frozen facts cannot change afterwards.
  const terminal = args.reporter.freezeProviderTerminal(providerOutcome);
  // Settle the speculative selector before reporting, mirroring the stream
  // path: the report builds the prefix entry, whose next_model must carry
  // the selector's next-turn choice (and its trace), not the speculative
  // serving pick that happened to win the provider race.
  let reportBarrierError: unknown;
  try {
    await args.reportBarrier;
  } catch (error) {
    reportBarrierError = error;
  }
  terminal.report();
  // Every turn — speculative or not — holds its response on the fast
  // prefix-state write, so an immediate continuation always resolves this
  // turn's entry. Bounded by PREFIX_STATE_WRITE_WAIT_MS.
  await args.reporter.waitForPrefixEntryWrite();
  return {
    choice,
    output,
    responseBody,
    ...(reportBarrierError === undefined ? {} : { reportBarrierError }),
  };
}

type CompletionRetryResult = ProviderAttemptPlanResult<
  ProviderChoice,
  CompletedNonStreamingAttempt
>;

async function completeWithRetries(args: {
  interaction: InteractionRequest;
  primary: ProviderChoice;
  primaryRetries: number;
  reporter: RoutedRuntimeReporter;
  startedCompletion?: StartedCompletion;
  clientSignal?: AbortSignal;
}): Promise<CompletionRetryResult> {
  return runProviderAttemptPlan({
    primary: args.primary,
    retries: args.primaryRetries,
    primaryInitial: args.startedCompletion,
    isCustomerCanceled: () => customerAbortRequested(args.clientSignal),
    canceledFailure: customerCanceledProviderMessage,
    runAttempt: ({ choice, initial }) => runCompletionAttempt({
      interaction: args.interaction,
      choice,
      reporter: args.reporter,
      startedCompletion: initial,
      clientSignal: args.clientSignal,
    }),
    recordFailedAttempt: ({ choice, attempt, result }) =>
      recordSettledFailure(args.reporter, choice, attempt, result),
  });
}

async function runCompletionAttempt(args: {
  interaction: InteractionRequest;
  choice: ProviderChoice;
  reporter: RoutedRuntimeReporter;
  startedCompletion?: StartedCompletion;
  clientSignal?: AbortSignal;
}): Promise<ProviderAttemptResult<CompletedNonStreamingAttempt>> {
  const startedAt = Date.now();
  const started = args.startedCompletion ?? startProviderCompletion({
    interaction: args.interaction,
    execution: args.choice.execution,
    clientSignal: args.clientSignal,
  });
  try {
    const completion = await started.promise;
    if (started.customerAbort.aborted) {
      return customerCanceledAttempt(
        completion.providerLatencyMs,
        args.choice.execution,
        completion.message,
      );
    }
    if (isProviderFailureMessage(completion.message)) {
      return providerFailedAttempt(
        completion.message,
        completion.providerLatencyMs,
        args.choice.execution,
        started.responseCapture,
      );
    }
    if (args.choice.execution.usageContext && hasUsage(completion.message)) {
      await reportRoutingUsage(
        {
          ...args.choice.execution.usageContext,
          startedAt: completion.providerStartedAt,
        },
        completion.message,
      );
    }
    return {
      kind: "succeeded",
      value: { completion },
      latencyMs: completion.providerLatencyMs,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (
      started.customerAbort.aborted ||
      error instanceof CustomerDisconnectedError
    ) {
      return customerCanceledAttempt(latencyMs, args.choice.execution);
    }
    return providerFailedAttempt(
      scrubProviderMessage(
        providerFailureFromCaught(error),
        args.choice.execution.auth,
      ),
      latencyMs,
      args.choice.execution,
      started.responseCapture,
    );
  }
}

async function settleTerminal(args: {
  reporter: RoutedRuntimeReporter;
  outcome: ReportableProviderOutcome;
  requestId: string;
  routerId?: string;
  reportBarrier?: Promise<unknown>;
}): Promise<void> {
  const terminal = args.reporter.freezeProviderTerminal(args.outcome);
  try {
    await args.reportBarrier;
  } catch (error) {
    captureOperationalError(error, {
      code: "routing_report_barrier_failed",
      requestId: args.requestId,
      routerId: args.routerId,
    });
  }
  terminal.report();
}

async function reportTerminalProviderFailure(args: {
  requestId: string;
  reporter: RoutedRuntimeReporter;
  choice: ProviderChoice;
  attempt: number;
  providerLatencyMs: number;
  providerMessage: Record<string, unknown>;
  reportBarrier?: Promise<unknown>;
  error: unknown;
}): Promise<never> {
  const failure = scrubProviderMessage(
    providerFailureFromTerminal(args.error, args.providerMessage),
    args.choice.execution.auth,
  );
  recordProviderAttempt(
    args.reporter,
    args.choice,
    args.attempt,
    "terminal_error",
    "provider_failed",
    failure,
  );
  await settleTerminal({
    reporter: args.reporter,
    outcome: {
      status: "provider_error",
      message: failure,
      providerLatencyMs: args.providerLatencyMs,
      execution: reportedExecution(args.choice.execution),
    },
    requestId: args.requestId,
    routerId: args.choice.execution.usageContext?.routerId,
    reportBarrier: args.reportBarrier,
  });
  throw args.error;
}

async function reportCustomerCancellation(args: {
  requestId: string;
  reporter: RoutedRuntimeReporter;
  choice: ProviderChoice;
  providerLatencyMs: number;
  providerMessage: Record<string, unknown>;
  reportBarrier?: Promise<unknown>;
}): Promise<never> {
  const usageContext = args.choice.execution.usageContext;
  if (usageContext && hasUsage(args.providerMessage)) {
    await reportRoutingUsage(usageContext, args.providerMessage);
  }
  await settleTerminal({
    reporter: args.reporter,
    outcome: {
      status: "customer_canceled",
      message: args.providerMessage,
      responseBody: null,
      providerLatencyMs: args.providerLatencyMs,
      execution: reportedExecution(args.choice.execution),
    },
    requestId: args.requestId,
    routerId: args.choice.execution.usageContext?.routerId,
    reportBarrier: args.reportBarrier,
  });
  throw new CustomerDisconnectedError();
}

async function throwProviderFailure(args: {
  requestId: string;
  reporter: RoutedRuntimeReporter;
  reportBarrier?: Promise<unknown>;
  result: {
    choice: ProviderChoice;
    failure: Record<string, unknown>;
    latencyMs: number;
  };
}): Promise<never> {
  const { result } = args;
  await settleTerminal({
    reporter: args.reporter,
    outcome: {
      status: "provider_error",
      message: result.failure,
      providerLatencyMs: result.latencyMs,
      execution: reportedExecution(result.choice.execution),
    },
    requestId: args.requestId,
    routerId: result.choice.execution.usageContext?.routerId,
    reportBarrier: args.reportBarrier,
  });
  const limit = subscriptionUsageLimitFromFailure(result.failure);
  if (limit?.switched === true) {
    // The client's retry is served by the user's next subscription.
    throw new HttpError(
      503,
      subscriptionSwitchedMessage(limit),
      "subscription_switched",
      undefined,
      { "retry-after": "1" },
    );
  }
  if (limit !== null) {
    throw new HttpError(
      429,
      subscriptionUsageLimitMessage(limit),
      "subscription_usage_limit",
      undefined,
      { "retry-after": String(retryAfterSeconds(limit)) },
    );
  }
  throw new HttpError(
    502,
    providerFailureMessage(result.failure),
    "provider_execution_failed",
  );
}

export async function prepareStreamingExecution(args: {
  requestId: string;
  interaction: InteractionRequest;
  primary: ProviderChoice;
  primaryRetries: number;
  reporter: RoutedRuntimeReporter;
  startedStream?: StartedStream;
  initialError?: unknown;
  reportBarrier?: Promise<unknown>;
  clientSignal?: AbortSignal;
}): Promise<PreparedStreamExecution> {
  const primaryInitial: InitialStreamAttempt | undefined =
    args.initialError !== undefined
      ? { kind: "error", error: args.initialError }
      : args.startedStream === undefined
        ? undefined
        : { kind: "started", started: args.startedStream };
  const result = await runProviderAttemptPlan({
    primary: args.primary,
    retries: args.primaryRetries,
    primaryInitial,
    isCustomerCanceled: () => customerAbortRequested(args.clientSignal),
    canceledFailure: customerCanceledProviderMessage,
    runAttempt: ({ choice, initial }) => runStreamSetupAttempt({
      interaction: args.interaction,
      choice,
      initial,
      clientSignal: args.clientSignal,
    }),
    recordFailedAttempt: ({ choice, attempt, result }) =>
      recordSettledFailure(args.reporter, choice, attempt, result),
  });
  args.reporter.attachServingDecision(result.choice.decision);
  if (result.kind === "customer_canceled") {
    return reportCustomerCancellation({
      requestId: args.requestId,
      reporter: args.reporter,
      choice: result.choice,
      providerLatencyMs: result.latencyMs,
      providerMessage: result.failure,
      reportBarrier: args.reportBarrier,
    });
  }
  if (result.kind === "provider_failed") {
    return throwProviderFailure({
      requestId: args.requestId,
      reporter: args.reporter,
      reportBarrier: args.reportBarrier,
      result,
    });
  }
  return {
    choice: result.choice,
    started: result.value,
    attempt: result.attempt,
    failedSetupLatencyMs: result.latencyMs,
  };
}

type InitialStreamAttempt =
  | { kind: "started"; started: StartedStream }
  | { kind: "error"; error: unknown };

async function runStreamSetupAttempt(args: {
  interaction: InteractionRequest;
  choice: ProviderChoice;
  initial: InitialStreamAttempt | undefined;
  clientSignal?: AbortSignal;
}): Promise<ProviderAttemptResult<StartedStream>> {
  const startedAt = Date.now();
  let started: StartedStream | undefined;
  try {
    if (args.initial?.kind === "error") throw args.initial.error;
    started = args.initial?.kind === "started"
      ? args.initial.started
      : await startProviderStream({
          interaction: args.interaction,
          execution: args.choice.execution,
          clientSignal: args.clientSignal,
        });
    // Prime before committing so connection failures and prompt rejections
    // stay inside the one shared retry state machine.
    const primed = await primeProviderStream(
      started.providerStream.events,
      started.customerAbort,
    );
    if (primed.outcome === "error") {
      started.customerAbort.dispose();
      return providerFailedAttempt(
        scrubProviderMessage(primed.failure, args.choice.execution.auth),
        Date.now() - startedAt,
        args.choice.execution,
        started.responseCapture,
      );
    }
    return {
      kind: "succeeded",
      value: {
        providerStartedMs: started.providerStartedMs,
        providerStream: {
          events: primed.events,
          source: started.providerStream.source,
        },
        customerAbort: started.customerAbort,
      },
      latencyMs: 0,
    };
  } catch (error) {
    const customerCanceled =
      started?.customerAbort.aborted === true ||
      error instanceof CustomerDisconnectedError;
    started?.customerAbort.dispose();
    if (customerCanceled) {
      return customerCanceledAttempt(
        Date.now() - startedAt,
        args.choice.execution,
      );
    }
    return providerFailedAttempt(
      scrubProviderMessage(
        providerFailureFromCaught(error),
        args.choice.execution.auth,
      ),
      Date.now() - startedAt,
      args.choice.execution,
      started?.responseCapture ?? providerResponseCaptureFromError(error),
    );
  }
}

export async function executeStreaming(args: {
  requestId: string;
  interaction: InteractionRequest;
  choice: ProviderChoice;
  reporter: RoutedRuntimeReporter;
  protocol: RoutedProtocol;
  startedStream: StartedStream;
  attempt: number;
  failedSetupLatencyMs: number;
  reportBarrier?: Promise<unknown>;
  clientSignal?: AbortSignal;
}): Promise<Response> {
  const { execution } = args.choice;
  const started = args.startedStream;
  args.reporter.attachServingDecision(args.choice.decision);
  const observed = observeDeliveredOutput(started.providerStream.events);
  const finalizer = createStreamFinalizer({
    requestId: args.requestId,
    interaction: args.interaction,
    decision: args.choice.decision,
    execution,
    reporter: args.reporter,
    protocol: args.protocol,
    providerLatencyMs: () =>
      args.failedSetupLatencyMs + Date.now() - started.providerStartedMs,
    attempt: args.attempt,
    reportBarrier: args.reportBarrier,
    delivered: observed.delivered,
    source: started.providerStream.source,
    startedAtMs: started.providerStartedMs,
  });
  return new Response(
    args.protocol.streamBody({
      id: args.requestId,
      model: execution.model,
      routing: args.choice.decision,
      events: observed.events,
      source: started.providerStream.source,
      request: args.interaction,
      conversationId: execution.conversationId,
      clientSignal: args.clientSignal,
      modelCost: (message, failed) => args.reporter.modelCost({
        model: args.choice.decision.selectedModel, reasoning_effort: args.choice.decision.reasoningEffort,
        attempt: args.attempt,
        outcome: failed ? "terminal_error" : "completed",
        billingOutcome: failed ? "provider_failed" : "completed",
        execution: reportedExecution(execution), message,
      }),
      onAbort: () => started.customerAbort.abort(),
      beforeClose: finalizer.beforeResponseClose,
      onFinal: (outcome) => {
        started.customerAbort.dispose();
        trackBackgroundTelemetry(finalizer.afterResponseDetached(outcome));
      },
    }),
    { headers: streamHeaders(execution) },
  );
}

function streamHeaders(execution: ProviderExecution): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    ...execution.headers,
  };
}

function customerAbortRequested(
  clientSignal: AbortSignal | undefined,
): boolean {
  // A disconnected client never starts new paid work that nobody can receive.
  return clientSignal?.aborted === true;
}

function recordProviderAttempt(
  reporter: RoutedRuntimeReporter,
  choice: ProviderChoice,
  attempt: number,
  outcome: "completed" | "error" | "terminal_error" | "canceled",
  billingOutcome: "completed" | "provider_failed" | "customer_canceled",
  message: Record<string, unknown>,
): void {
  reporter.recordProviderAttempt({
    model: choice.decision.selectedModel,
    reasoning_effort: choice.decision.reasoningEffort,
    attempt,
    outcome,
    execution: reportedExecution(choice.execution),
    message,
    billingOutcome,
  });
}

function recordSettledFailure(
  reporter: RoutedRuntimeReporter,
  choice: ProviderChoice,
  attempt: number,
  result: ProviderAttemptFailure,
): void {
  recordProviderAttempt(
    reporter,
    choice,
    attempt,
    result.kind === "customer_canceled" ? "canceled" : "error",
    result.kind,
    result.message,
  );
}

async function providerFailedAttempt(
  message: Record<string, unknown>,
  latencyMs: number,
  execution: ProviderExecution,
  responseCapture: ProviderResponseCapture | undefined,
): Promise<ProviderAttemptFailure> {
  const limit = detectSubscriptionUsageLimit({
    provider: execution.provider,
    keySource: execution.providerKeySource,
    captured: responseCapture?.last,
    failure: message,
  });
  if (limit === null) {
    return {
      kind: "provider_failed",
      message,
      latencyMs,
      retryable: !isPromptPolicyRejection(message),
    };
  }
  // Retrying an exhausted plan cannot succeed. The platform learns about it
  // before this request returns so the next resolve already serves the
  // user's next subscription, or the model's API credential when the router
  // allows subscription API fallback for it.
  const switched = execution.subscriptionUserId !== undefined
    && await holdSubscription({
      userId: execution.subscriptionUserId,
      credentialId: execution.subscriptionCredentialId,
      limit,
    });
  return {
    kind: "provider_failed",
    message: failureWithSubscriptionUsageLimit(message, { ...limit, switched }),
    latencyMs,
    retryable: false,
  };
}

// The provider call was in flight, so the prompt was paid for. A completion
// that returned before the abort was observed carries exact usage; otherwise
// the prompt is estimated and nothing was delivered. A usage object with no
// tokens at all is the SDK's placeholder for an interrupted call, not a
// measurement, so it falls back to the estimate too.
function customerCanceledAttempt(
  latencyMs: number,
  execution: ProviderExecution,
  completed?: Record<string, unknown>,
): ProviderAttemptFailure {
  const exactUsage =
    completed !== undefined && hasUsage(completed) && usageHasTokens(completed.usage)
      ? (completed.usage as Record<string, unknown>)
      : null;
  return {
    kind: "customer_canceled",
    message: customerCanceledProviderMessage(
      exactUsage ??
        estimatedCancelUsage({
          pricing: execution.pricing,
          promptEstimate: execution.promptEstimate,
          delivered: NO_DELIVERED_OUTPUT,
        }),
      typeof completed?.responseId === "string" ? completed.responseId : undefined,
    ),
    latencyMs,
    retryable: false,
  };
}

function hasUsage(message: Record<string, unknown>): boolean {
  return (
    typeof message.usage === "object" &&
    message.usage !== null &&
    !Array.isArray(message.usage)
  );
}

function usageHasTokens(usage: unknown): boolean {
  if (typeof usage !== "object" || usage === null) return false;
  const counts = usage as Record<string, unknown>;
  return ["input", "output", "cacheRead", "cacheWrite"].some((key) => {
    const value = counts[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  });
}

function isPromptPolicyRejection(message: Record<string, unknown>): boolean {
  const text = providerFailureMessage(message).toLowerCase();
  return text.includes("invalid prompt") && text.includes("usage policy");
}

// Never fails the request: the provider already refused. Resolves whether
// another subscription now serves.
async function holdSubscription(hold: SubscriptionHold): Promise<boolean> {
  try {
    return await gatewayPlatform().markSubscriptionUnavailable(hold);
  } catch (error) {
    console.error("subscription-unavailable write failed", error);
    captureOperationalError(error, { code: "subscription_unavailable_ingest_failed" });
    return false;
  }
}
