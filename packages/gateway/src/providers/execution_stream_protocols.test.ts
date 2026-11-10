import { expect, test } from "bun:test";
import type {
  Provider,
  RoutingDecision,
} from "@mupt-ai/dari-router/policy-engine";

import type {
  InteractionRequest,
  ProviderIdentity,
} from "../interaction/types.js";
import { deferred } from "../test_support/deferred.js";
import { bindTestPlatform } from "../test_support/platform.js";
import { anthropicMessagesResponse } from "../protocol/output/anthropic_messages.js";
import { anthropicMessagesSseStream } from "../protocol/output/anthropic_messages_stream.js";
import {
  chatCompletionResponse,
  chatCompletionsSseStream,
} from "../protocol/output/chat_completions.js";
import { openAIResponsesResponse } from "../protocol/output/openai_responses.js";
import { openAIResponsesSseStream } from "../protocol/output/openai_responses_stream.js";
import type { ProviderStreamOutcome } from "../runtime/provider_stream_outcome.js";
import {
  createProviderAttemptAbort,
  type ProviderAttemptAbort,
} from "../runtime/customer_disconnect.js";
import type { RoutedProtocol } from "../runtime/routed_protocol.js";
import type {
  ReportableProviderOutcome,
  RoutedRuntimeReporter,
} from "../runtime/runtime_reporter.js";
import { drainBackgroundTelemetry } from "../telemetry/background.js";
import {
  executeStreaming,
  type ProviderChoice,
} from "./execution.js";

const protocolCases: ProtocolCase[] = [
  {
    name: "OpenAI Chat",
    model: "openai/gpt-4.1-mini",
    provider: "openai",
    source: {
      provider: "openai",
      api: "openai-responses",
      model: "gpt-4.1-mini",
    },
    request: {
      sourceProtocol: "openai_chat",
      items: [],
      tools: [],
      generation: {},
      stream: true,
    },
    responseBody: chatCompletionResponse,
    streamBody: chatCompletionsSseStream,
    terminalMarker: "data: [DONE]",
    snapshotProtocol: "openai_chat",
  },
  {
    name: "OpenAI Responses",
    model: "openai/gpt-4.1-mini",
    provider: "openai",
    source: {
      provider: "openai",
      api: "openai-responses",
      model: "gpt-4.1-mini",
    },
    request: {
      sourceProtocol: "openai_responses",
      items: [],
      tools: [],
      generation: {},
      parallelToolCalls: false,
      stream: true,
    },
    responseBody: openAIResponsesResponse,
    streamBody: openAIResponsesSseStream,
    terminalMarker: "event: response.completed",
    snapshotProtocol: "openai_responses",
  },
  {
    name: "Anthropic Messages",
    model: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    source: {
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-sonnet-4-6",
    },
    request: {
      sourceProtocol: "anthropic_messages",
      items: [],
      tools: [],
      generation: { maxOutputTokens: 1024 },
      stream: true,
    },
    responseBody: anthropicMessagesResponse,
    streamBody: anthropicMessagesSseStream,
    terminalMarker: "event: message_stop",
    snapshotProtocol: "anthropic_messages",
  },
];

for (const protocolCase of protocolCases) {
  test(`${protocolCase.name} holds its terminal event for rejected-barrier reporting and one delayed usage POST`, async () => {
    const fetchRelease = deferred<void>();
    const fetchStarted = deferred<void>();
    const fetchCalls: string[] = [];
    const restoreFetch = installManagedUsage(async (input) => {
      fetchCalls.push(String(input));
      fetchStarted.resolve();
      await fetchRelease.promise;
      return Response.json({ event_id: "cost_1" });
    });
    const callbacks = callbackCounts();
    const reporter = reporterCounts();

    try {
      const response = await executeStreaming(
        streamingArgs({
          protocolCase,
          events: duplicateCompletedEvents(protocolCase.source),
          reporter: countingReporter(reporter),
          protocol: observedProtocol(protocolCase, callbacks),
          reportBarrier: handledRejection(new Error("selector report failed")),
        }),
      );
      let bodySettled = false;
      const body = response.text().then((text) => {
        bodySettled = true;
        return text;
      });

      await fetchStarted.promise;
      await Bun.sleep(0);
      expect(bodySettled).toBe(false);
      expect(callbacks.beforeClose).toEqual(["completed"]);
      expect(callbacks.onFinal).toEqual([]);
      expect(reporter.providerAttempts).toBe(1);
      expect(reporter.providerOutcomes).toEqual(["completed"]);
      expect(fetchCalls).toHaveLength(1);

      fetchRelease.resolve();
      const text = await body;
      await drainBackgroundTelemetry();
      await Bun.sleep(0);

      expect(occurrences(text, protocolCase.terminalMarker)).toBe(1);
      expect(callbacks.beforeClose).toEqual(["completed"]);
      expect(callbacks.onFinal).toEqual(["completed"]);
      expect(reporter.servingDecisions).toBe(1);
      expect(reporter.providerAttempts).toBe(1);
      expect(reporter.providerOutcomes).toEqual(["completed"]);
      expect(reporter.prefixWaits).toBe(1);
      expect(fetchCalls).toHaveLength(1);
    } finally {
      fetchRelease.resolve();
      await drainBackgroundTelemetry();
      restoreFetch();
    }
  });

  test(`${protocolCase.name} aborts an early BYOK client cancel once and never bills it`, async () => {
    const providerRelease = deferred<void>();
    const providerWaiting = deferred<void>();
    const providerFinished = deferred<void>();
    let fetchCalls = 0;
    const restoreFetch = installManagedUsage(async () => {
      fetchCalls += 1;
      return Response.json({ event_id: "unexpected" });
    });
    const callbacks = callbackCounts();
    const reporter = reporterCounts();
    const events = (async function* () {
      try {
        providerWaiting.resolve();
        await providerRelease.promise;
        yield completedEvent(protocolCase.source);
      } finally {
        providerFinished.resolve();
      }
    })();

    try {
      const response = await executeStreaming(
        streamingArgs({
          protocolCase,
          events,
          reporter: countingReporter(reporter),
          protocol: observedProtocol(protocolCase, callbacks),
          providerKeySource: "user",
        }),
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected a streaming response body.");

      await providerWaiting.promise;
      await reader.cancel();
      await drainBackgroundTelemetry();

      expect(callbacks.beforeClose).toEqual([]);
      expect(callbacks.onFinal).toEqual(["aborted"]);
      expect(reporter.providerAttempts).toBe(1);
      expect(reporter.providerOutcomes).toEqual(["customer_canceled"]);
      expect(reporter.reportedOutcomes[0]).toMatchObject({
        status: "customer_canceled",
        message: {
          usage_estimated: true,
          usage: { input: 800, cacheRead: 200, output: 0, estimated: true },
        },
        responseBody: {
          type: "dari.stream_partial",
          protocol: protocolCase.snapshotProtocol,
        },
      });
      expect(reporter.prefixWaits).toBe(0);
      expect(fetchCalls).toBe(0);

      providerRelease.resolve();
      await providerFinished.promise;
      await Bun.sleep(0);
      expect(callbacks.beforeClose).toEqual([]);
      expect(callbacks.onFinal).toEqual(["aborted"]);
      expect(reporter.providerOutcomes).toEqual(["customer_canceled"]);
      expect(fetchCalls).toBe(0);
    } finally {
      providerRelease.resolve();
      await drainBackgroundTelemetry();
      restoreFetch();
    }
  });

  for (const providerKeySource of ["managed", "user", "subscription"] as const) {
    test(`${protocolCase.name} synchronously aborts a pending ${providerKeySource} provider read`, async () => {
      const providerWaiting = deferred<void>();
      const providerFinished = deferred<void>();
      const callbacks = callbackCounts();
      const reporter = reporterCounts();
      const customerAbort = createProviderAttemptAbort({});
      const signal = customerAbort.signal;
      const events = (async function* () {
        try {
          providerWaiting.resolve();
          await rejectOnAbort(signal);
        } finally {
          providerFinished.resolve();
        }
      })();

      const response = await executeStreaming(
        streamingArgs({
          protocolCase,
          events,
          reporter: countingReporter(reporter),
          protocol: observedProtocol(protocolCase, callbacks),
          providerKeySource,
          customerAbort,
        }),
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected a streaming response body.");

      await providerWaiting.promise;
      await reader.cancel();
      expect(signal.aborted).toBe(true);
      await providerFinished.promise;
      await drainBackgroundTelemetry();

      expect(callbacks.onFinal).toEqual(["aborted"]);
      expect(reporter.providerAttempts).toBe(1);
      expect(reporter.providerOutcomes).toEqual(["customer_canceled"]);
    });
  }

  test(`${protocolCase.name} aborts an early managed cancel and bills the prompt estimate`, async () => {
    const providerRelease = deferred<void>();
    const providerWaiting = deferred<void>();
    const providerFinished = deferred<void>();
    const usagePayloads: Record<string, unknown>[] = [];
    const restoreFetch = installManagedUsage(async (_input, init) => {
      usagePayloads.push(JSON.parse(init.body));
      return Response.json({ event_id: "cost_1" });
    });
    const callbacks = callbackCounts();
    const reporter = reporterCounts();
    const customerAbort = createProviderAttemptAbort({});
    const signal = customerAbort.signal;
    const events = (async function* () {
      try {
        providerWaiting.resolve();
        await Promise.race([providerRelease.promise, rejectOnAbort(signal)]);
        yield completedEvent(protocolCase.source);
      } finally {
        providerFinished.resolve();
      }
    })();

    try {
      const response = await executeStreaming(
        streamingArgs({
          protocolCase,
          events,
          reporter: countingReporter(reporter),
          protocol: observedProtocol(protocolCase, callbacks),
          customerAbort,
        }),
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected a streaming response body.");

      await providerWaiting.promise;
      await reader.cancel();
      expect(signal.aborted).toBe(true);
      await providerFinished.promise;
      await drainBackgroundTelemetry();

      expect(callbacks.beforeClose).toEqual([]);
      expect(callbacks.onFinal).toEqual(["aborted"]);
      expect(reporter.providerAttempts).toBe(1);
      expect(reporter.providerOutcomes).toEqual(["customer_canceled"]);
      expect(reporter.reportedOutcomes[0]).toMatchObject({
        status: "customer_canceled",
        message: {
          usage_estimated: true,
          usage: { input: 800, cacheRead: 200, output: 0, estimated: true },
        },
        partialOutput: null,
      });
      const reported = reporter.reportedOutcomes[0];
      if (reported.status !== "customer_canceled") throw new Error("Expected a cancel outcome.");
      const usage = reported.message?.usage as { cost: { total: number } };
      expect(usage.cost.total).toBeCloseTo(ESTIMATED_PROMPT_COST, 12);
      expect(reporter.prefixWaits).toBe(0);
      expect(usagePayloads).toHaveLength(1);
      expect(usagePayloads[0]).toMatchObject({
        usage_estimated: true,
        input_tokens: 800,
        cached_input_tokens: 200,
        output_tokens: 0,
      });
    } finally {
      providerRelease.resolve();
      await drainBackgroundTelemetry();
      restoreFetch();
    }
  });

  test(`${protocolCase.name} bills delivered text on a mid-stream cancel and keeps the partial for the prefix`, async () => {
    const providerWaiting = deferred<void>();
    const providerFinished = deferred<void>();
    const usagePayloads: Record<string, unknown>[] = [];
    const restoreFetch = installManagedUsage(async (_input, init) => {
      usagePayloads.push(JSON.parse(init.body));
      return Response.json({ event_id: "cost_1" });
    });
    const callbacks = callbackCounts();
    const reporter = reporterCounts();
    const customerAbort = createProviderAttemptAbort({});
    const signal = customerAbort.signal;
    const deliveredText = "x".repeat(480);
    const events = (async function* () {
      try {
        yield { type: "start", partial: { role: "assistant", content: [] } };
        yield { type: "text_start", contentIndex: 0, partial: { content: [{ type: "text", text: "" }] } };
        yield {
          type: "text_delta",
          contentIndex: 0,
          delta: deliveredText,
          partial: { content: [{ type: "text", text: deliveredText }] },
        };
        providerWaiting.resolve();
        await rejectOnAbort(signal);
      } finally {
        providerFinished.resolve();
      }
    })();

    try {
      const response = await executeStreaming(
        streamingArgs({
          protocolCase,
          events,
          reporter: countingReporter(reporter),
          protocol: observedProtocol(protocolCase, callbacks),
          customerAbort,
        }),
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected a streaming response body.");

      await providerWaiting.promise;
      await reader.read();
      await reader.cancel();
      await providerFinished.promise;
      await drainBackgroundTelemetry();

      expect(callbacks.onFinal).toEqual(["aborted"]);
      expect(reporter.providerOutcomes).toEqual(["customer_canceled"]);
      expect(reporter.reportedOutcomes[0]).toMatchObject({
        status: "customer_canceled",
        message: { usage: { input: 800, cacheRead: 200, output: 100, estimated: true } },
        partialOutput: {
          stopReason: "aborted",
          items: [{ type: "message", role: "assistant", content: [{ type: "text", text: deliveredText }] }],
        },
      });
      expect(usagePayloads[0]).toMatchObject({ usage_estimated: true, output_tokens: 100 });
    } finally {
      await drainBackgroundTelemetry();
      restoreFetch();
    }
  });

  test(`${protocolCase.name} coalesces beforeClose with a cancel after provider completion`, async () => {
    const fetchRelease = deferred<void>();
    const fetchStarted = deferred<void>();
    let fetchCalls = 0;
    const restoreFetch = installManagedUsage(async () => {
      fetchCalls += 1;
      fetchStarted.resolve();
      await fetchRelease.promise;
      return Response.json({ event_id: "cost_1" });
    });
    const callbacks = callbackCounts();
    const reporter = reporterCounts();

    try {
      const response = await executeStreaming(
        streamingArgs({
          protocolCase,
          events: duplicateCompletedEvents(protocolCase.source),
          reporter: countingReporter(reporter),
          protocol: observedProtocol(protocolCase, callbacks),
        }),
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected a streaming response body.");

      await fetchStarted.promise;
      expect(callbacks.beforeClose).toEqual(["completed"]);
      expect(callbacks.onFinal).toEqual([]);
      await reader.cancel();
      expect(callbacks.onFinal).toEqual(["completed"]);

      let drained = false;
      const draining = drainBackgroundTelemetry().then(() => {
        drained = true;
      });
      await Bun.sleep(0);
      expect(drained).toBe(false);

      fetchRelease.resolve();
      await draining;
      await Bun.sleep(0);

      expect(callbacks.beforeClose).toEqual(["completed"]);
      expect(callbacks.onFinal).toEqual(["completed"]);
      expect(reporter.providerAttempts).toBe(1);
      expect(reporter.providerOutcomes).toEqual(["completed"]);
      expect(reporter.prefixWaits).toBe(1);
      expect(fetchCalls).toBe(1);
    } finally {
      fetchRelease.resolve();
      await drainBackgroundTelemetry();
      restoreFetch();
    }
  });

  test(`${protocolCase.name} still closes exactly once when the managed usage POST rejects`, async () => {
    let fetchCalls = 0;
    const restoreFetch = installManagedUsage(async () => {
      fetchCalls += 1;
      throw new Error("platform unavailable");
    });
    const originalConsoleError = console.error;
    const loggedErrors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args);
    };
    const callbacks = callbackCounts();
    const reporter = reporterCounts();

    try {
      const response = await executeStreaming(
        streamingArgs({
          protocolCase,
          events: duplicateCompletedEvents(protocolCase.source),
          reporter: countingReporter(reporter),
          protocol: observedProtocol(protocolCase, callbacks),
        }),
      );
      const text = await response.text();
      await drainBackgroundTelemetry();
      await Bun.sleep(0);

      expect(occurrences(text, protocolCase.terminalMarker)).toBe(1);
      expect(callbacks.beforeClose).toEqual(["completed"]);
      expect(callbacks.onFinal).toEqual(["completed"]);
      expect(reporter.providerAttempts).toBe(1);
      expect(reporter.providerOutcomes).toEqual(["completed"]);
      expect(reporter.prefixWaits).toBe(1);
      expect(fetchCalls).toBe(1);
      expect(
        loggedErrors.filter(
          ([message]) => message === "Routing usage not recorded.",
        ),
      ).toHaveLength(1);
    } finally {
      await drainBackgroundTelemetry();
      console.error = originalConsoleError;
      restoreFetch();
    }
  });
}

type ProtocolCase = {
  name: string;
  model: string;
  provider: Provider;
  source: ProviderIdentity;
  request: InteractionRequest;
  responseBody: RoutedProtocol["responseBody"];
  streamBody: RoutedProtocol["streamBody"];
  terminalMarker: string;
  snapshotProtocol: string;
};

type CallbackCounts = {
  beforeClose: ProviderStreamOutcome["status"][];
  onFinal: ProviderStreamOutcome["status"][];
};

type ReporterCounts = {
  servingDecisions: number;
  providerAttempts: number;
  providerOutcomes: ReportableProviderOutcome["status"][];
  reportedOutcomes: ReportableProviderOutcome[];
  prefixWaits: number;
};

function callbackCounts(): CallbackCounts {
  return { beforeClose: [], onFinal: [] };
}

function reporterCounts(): ReporterCounts {
  return {
    servingDecisions: 0,
    providerAttempts: 0,
    providerOutcomes: [],
    reportedOutcomes: [],
    prefixWaits: 0,
  };
}

function observedProtocol(
  protocolCase: ProtocolCase,
  counts: CallbackCounts,
): RoutedProtocol {
  return {
    responseBody: protocolCase.responseBody,
    streamBody: (args) =>
      protocolCase.streamBody({
        ...args,
        beforeClose: (outcome) => {
          counts.beforeClose.push(outcome.status);
          return args.beforeClose?.(outcome);
        },
        onFinal: (outcome) => {
          counts.onFinal.push(outcome.status);
          args.onFinal?.(outcome);
        },
      }),
  };
}

function countingReporter(counts: ReporterCounts): RoutedRuntimeReporter {
  return {
    attachSelectorRun() {},
    attachSpeculativeSelectorRun() {},
    attachDecision() {},
    attachServingDecision() {
      counts.servingDecisions += 1;
    },
    modelCost() { return null; },
    recordProviderAttempt() {
      counts.providerAttempts += 1;
    },
    attachDecisionDetails() {},
    attachAdoptedSelectorOutput() {},
    async waitForPrefixEntryWrite() {
      counts.prefixWaits += 1;
    },
    freezeProviderTerminal(outcome) {
      return {
        report() {
          counts.providerOutcomes.push(outcome.status);
          counts.reportedOutcomes.push(outcome);
        },
      };
    },
    freezeFailure() {
      return {
        report() {},
      };
    },
    reportSelectorFailure() {},
  };
}

function streamingArgs(args: {
  protocolCase: ProtocolCase;
  events: AsyncIterable<Record<string, unknown>>;
  reporter: RoutedRuntimeReporter;
  protocol: RoutedProtocol;
  reportBarrier?: Promise<unknown>;
  providerKeySource?: "managed" | "user" | "subscription";
  customerAbort?: ProviderAttemptAbort;
}): Parameters<typeof executeStreaming>[0] {
  return {
    requestId: `req_${args.protocolCase.request.sourceProtocol}`,
    interaction: args.protocolCase.request,
    choice: providerChoice(args.protocolCase, args.providerKeySource ?? "managed"),
    reporter: args.reporter,
    protocol: args.protocol,
    startedStream: {
      providerStartedMs: Date.now(),
      providerStream: {
        events: args.events,
        source: args.protocolCase.source,
      },
      customerAbort: args.customerAbort ?? createProviderAttemptAbort({}),
    },
    attempt: 1,
    failedSetupLatencyMs: 0,
    reportBarrier: args.reportBarrier,
  };
}

// Per-million-token prices and a prompt estimate that make cancel estimates
// non-zero: 800 fresh + 200 cached prompt tokens cost $0.00082.
const TEST_PRICING = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
const TEST_PROMPT_ESTIMATE = { promptTokens: 1000, warmTokens: 200 };
const ESTIMATED_PROMPT_COST = 800 * 1e-6 + 200 * 0.1e-6;

function providerChoice(
  protocolCase: ProtocolCase,
  providerKeySource: "managed" | "user" | "subscription",
): ProviderChoice {
  const decision: RoutingDecision = {
    selectedModel: protocolCase.model,
    reasoningEffort: "off",
    reason: "test",
  };
  return {
    decision,
    execution: {
      provider: protocolCase.provider,
      providerKeySource,
      model: protocolCase.model,
      apiKey: "test-key",
      auth: { type: "bearer", apiKey: "test-key" },
      pricing: TEST_PRICING,
      config: undefined,
      conversationId: "conv_1",
      sessionId: "conv_1",
      reasoningEffort: "off",
      promptEstimate: TEST_PROMPT_ESTIMATE,
      usageContext: providerKeySource === "managed"
        ? {
            organizationId: "org_1",
            routerId: "rtr_1",
            provider: protocolCase.provider,
            model: protocolCase.model,
            tags: {},
            startedAt: new Date("2026-08-31T00:00:00Z"),
          }
        : undefined,
      headers: {},
    },
  };
}

async function* duplicateCompletedEvents(
  source: ProviderIdentity,
): AsyncIterable<Record<string, unknown>> {
  yield completedEvent(source);
  yield completedEvent(source, "duplicate_response");
}

function completedEvent(
  source: ProviderIdentity,
  responseId = "provider_response",
): Record<string, unknown> {
  return {
    type: "done",
    message: {
      responseId,
      timestamp: 1_750_000_000_000,
      stopReason: "stop",
      usage: {
        input: 4,
        output: 2,
        cacheRead: 1,
        cacheWrite: 0,
        totalTokens: 7,
        cost: {
          input: 0.0004,
          output: 0.0002,
          cacheRead: 0.0001,
          cacheWrite: 0,
          total: 0.0007,
        },
      },
      content: [
        {
          type: "text",
          text: "complete",
          source,
        },
      ],
    },
  };
}

// Managed usage reaches the platform's recordUsage; the implementation sees
// it as the request the hosted platform would send.
function installManagedUsage(
  implementation: (input: string, init: { body: string }) => Promise<Response>,
): () => void {
  bindTestPlatform({
    async recordUsage(usage) {
      const response = await implementation("recordUsage", { body: JSON.stringify(usage) });
      if (!response.ok) throw new Error(`usage rejected with HTTP ${response.status}`);
    },
  });
  return () => bindTestPlatform();
}

// The runtime marks the selection promise handled before handing it to the
// execution layer as a barrier; mirror that so a rejected barrier stays a
// finalization concern instead of an unhandled rejection.
function handledRejection(error: Error): Promise<unknown> {
  const barrier = Promise.reject(error);
  barrier.catch(() => undefined);
  return barrier;
}


function rejectOnAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function occurrences(value: string, target: string): number {
  return value.split(target).length - 1;
}

