import type { RoutingDecision } from "@mupt-ai/dari-router/policy-engine";
import type { InteractionOutput } from "../interaction/types.js";
import type { SelectorRun } from "../strategies/routing.js";
import type { ProviderKeySource } from "../types.js";

export type ReportedProviderExecution = {
  provider: string;
  model: string;
  providerKeySource: ProviderKeySource;
};

export function reportedExecution(
  execution: ReportedProviderExecution,
): ReportedProviderExecution {
  return {
    provider: execution.provider,
    model: execution.model,
    providerKeySource: execution.providerKeySource,
  };
}

export type ReportableProviderOutcome =
  | {
      status: "completed";
      output: InteractionOutput;
      message: Record<string, unknown>;
      responseBody: Record<string, unknown>;
      providerLatencyMs: number;
      execution: ReportedProviderExecution;
    }
  | {
      status: "provider_error";
      message: Record<string, unknown>;
      providerLatencyMs: number;
      execution: ReportedProviderExecution;
    }
  | {
      status: "customer_canceled";
      providerLatencyMs: number;
      execution: ReportedProviderExecution;
      message: Record<string, unknown> | null;
      responseBody: Record<string, unknown> | null;
      partialOutput?: InteractionOutput | null;
    };

export type ProviderAttemptReport = {
  model: string;
  reasoning_effort: string;
  attempt: number;
  outcome: "completed" | "error" | "terminal_error" | "canceled";
};

export type ProviderAttemptRecord = ProviderAttemptReport & {
  execution: ReportedProviderExecution;
  message: Record<string, unknown>;
  billingOutcome: "completed" | "provider_failed" | "customer_canceled";
};

export type FrozenProviderTerminal = {
  report(): void;
};

export type RoutedRuntimeReporter = {
  attachSelectorRun(run: SelectorRun): void;
  attachSpeculativeSelectorRun(run: SelectorRun, servingDecision: RoutingDecision): void;
  attachDecision(decision: RoutingDecision): void;
  attachServingDecision(decision: RoutingDecision): void;
  recordProviderAttempt(attempt: ProviderAttemptRecord): void;
  modelCost(attempt?: ProviderAttemptRecord): number | null;
  attachDecisionDetails(details: Record<string, unknown>): void;
  attachAdoptedSelectorOutput(adopted: {
    outputText: string | null;
    reason: string;
    candidates: readonly { model: string; reasoningEffort: string }[];
  }): void;
  waitForPrefixEntryWrite(): Promise<void>;
  freezeProviderTerminal(args: ReportableProviderOutcome): FrozenProviderTerminal;
  freezeFailure(error: unknown): FrozenProviderTerminal;
  reportSelectorFailure(error: unknown): void;
};

export type ExperimentRoutedRuntimeReporter = RoutedRuntimeReporter & {
  decisionDetails: Record<string, unknown>;
};

export function createExperimentRoutedRuntimeReporter(): ExperimentRoutedRuntimeReporter {
  const terminal: FrozenProviderTerminal = {
    report() {},
  };
  const reporter: ExperimentRoutedRuntimeReporter = {
    decisionDetails: {},
    attachSelectorRun() {},
    attachSpeculativeSelectorRun() {},
    attachDecision() {},
    attachServingDecision() {},
    recordProviderAttempt() {},
    modelCost() { return null; },
    attachAdoptedSelectorOutput() {},
    attachDecisionDetails(details) {
      reporter.decisionDetails = { ...reporter.decisionDetails, ...details };
    },
    async waitForPrefixEntryWrite() {},
    freezeProviderTerminal() {
      return terminal;
    },
    freezeFailure() {
      return terminal;
    },
    reportSelectorFailure() {},
  };
  return reporter;
}
