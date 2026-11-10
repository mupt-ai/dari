import type { RoutingDecision } from "@mupt-ai/dari-router/policy-engine";
import type { InteractionOutput, InteractionRequest, ProviderIdentity } from "../interaction/types.js";
import type { ProviderStreamOutcome } from "./provider_stream_outcome.js";

export type RoutedCompletionResponseArgs = {
  id: string;
  model: string;
  output: InteractionOutput;
  modelCost?: number | null;
  request: InteractionRequest;
  routing: RoutingDecision;
  conversationId?: string;
};

export type RoutedCompletionStreamArgs = {
  id: string;
  model: string;
  routing: RoutingDecision;
  events: AsyncIterable<Record<string, unknown>>;
  source: ProviderIdentity;
  request: InteractionRequest;
  conversationId?: string;
  onFinal?: (outcome: ProviderStreamOutcome) => void;
  modelCost?: (message: Record<string, unknown>, failed: boolean) => number | null;
  beforeClose?: (outcome: ProviderStreamOutcome) => Promise<void> | void;
  clientSignal?: AbortSignal;
  onAbort?: () => void;
};

export type RoutedProtocol = {
  responseBody: (args: RoutedCompletionResponseArgs) => Record<string, unknown>;
  streamBody: (args: RoutedCompletionStreamArgs) => ReadableStream<Uint8Array>;
};
