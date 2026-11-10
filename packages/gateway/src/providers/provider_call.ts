import {
  isRecord,
  type CandidateCostEstimate,
  type ModelPricing,
  type PricingLookup,
  type Provider,
  type ReasoningEffort,
  type RoutingDecision,
} from "@mupt-ai/dari-router/policy-engine";

import { executionProviderForModel, keySourceForModel } from "../models/execution_provider.js";
import { HttpError } from "../http/errors.js";
import type { RequestTags } from "../platform/platform.js";
import type { InteractionRequest, ProviderIdentity } from "../interaction/types.js";
import {
  CustomerDisconnectedError,
  createProviderAttemptAbort,
  type ProviderAttemptAbort,
} from "../runtime/customer_disconnect.js";
import {
  isProviderFailureMessage,
  providerFailureFromCaught,
  providerFailureFromEvent,
} from "../runtime/provider_stream_outcome.js";
import { providerAuthForSelectedModel } from "../strategies/routing.js";
import { scrubSecretValues } from "../telemetry/scrub.js";
import {
  usageContextFor,
  type RoutingUsageContext,
} from "../telemetry/usage.js";
import type {
  ProviderAuth,
  ProviderKeySource,
  ResolvedRouter,
  ResolvedRouterModelConfig,
  ServedDecision,
} from "../types.js";
import { awsRoleCredentials } from "./aws_assume_role.js";
import {
  attachProviderResponseCapture,
  createProviderResponseCapture,
  type ProviderFetch,
  type ProviderResponseCapture,
} from "./response_capture.js";
import {
  completeInteractionModel,
  streamInteractionModel,
  type ProviderEndpoint,
  type ProviderEventStream,
} from "./pi.js";
import { promptTokenEstimateFor, type PromptTokenEstimate } from "./cancel_estimate.js";

type ProviderCallConfig = {
  model: string;
  apiKey: string;
  auth: ProviderAuth;
  pricing: ModelPricing | null;
  config: ResolvedRouterModelConfig | undefined;
  conversationId: string;
  sessionId: string;
  reasoningEffort: ReasoningEffort;
  promptEstimate: PromptTokenEstimate | undefined;
  // A platform-supplied endpoint replacing the model's configured one.
  endpoint?: ProviderEndpoint;
};

export type ProviderExecution = ProviderCallConfig & {
  provider: Provider;
  providerKeySource: ProviderKeySource;
  // The user whose personal subscription serves this call, and which of their
  // subscriptions it is; undefined for router-owned keys.
  subscriptionUserId?: string;
  subscriptionCredentialId?: string;
  usageContext: RoutingUsageContext | undefined;
  headers: Record<string, string>;
};

export type CompletedProviderCall = {
  message: Record<string, unknown>;
  source: ProviderIdentity;
  providerLatencyMs: number;
  providerStartedAt: Date;
};

export type StartedCompletion = {
  promise: Promise<CompletedProviderCall>;
  customerAbort: ProviderAttemptAbort;
  // Present only for subscription-served calls, whose rejected responses the
  // runtime must classify (usage limits) from raw status, headers, and body.
  responseCapture?: ProviderResponseCapture;
};

export type StartedStream = {
  providerStream: ProviderEventStream;
  providerStartedMs: number;
  customerAbort: ProviderAttemptAbort;
  responseCapture?: ProviderResponseCapture;
};

export function prepareProviderExecution(args: {
  decision: ServedDecision;
  credentials: ResolvedRouter;
  billable: boolean;
  routerId: string;
  pricing: PricingLookup;
  conversationId: string;
  promptCacheKey?: string;
  costEstimates?: readonly CandidateCostEstimate[];
  tags?: RequestTags;
}): ProviderExecution {
  const model = args.decision.selectedModel;
  const promptEstimate = promptTokenEstimateFor(args.costEstimates, model, args.decision.reasoningEffort);
  const limit = args.credentials.model_configs?.[model]?.standard_context_limit;
  if (args.credentials.allow_long_context !== true && limit != null && (promptEstimate === undefined || promptEstimate.promptTokens > limit)) {
    throw new HttpError(400, "The prompt exceeds this model's standard-price context range. Shorten or compact the conversation.", "context_length_exceeded");
  }
  const provider = executionProviderForModel(args.credentials, model);
  const supplied = args.credentials.provider_credentials?.[model];
  const providerKeySource = keySourceForModel(args.credentials, model);
  // A strict router serves a plan only when the platform supplied it for this
  // request, never a pooled or personal one it resolved.
  if (args.credentials.strict === true && providerKeySource === "subscription" && !supplied) {
    throw new HttpError(
      400,
      `Strict routers do not serve '${model}' from a personal subscription.`,
      "strict_subscription_refused",
      "model",
    );
  }
  const auth: ProviderAuth = supplied
    ? { type: "bearer", apiKey: supplied.apiKey.trim() }
    : providerAuthForSelectedModel({ selectedModel: model, credentials: args.credentials });
  return {
    model,
    apiKey: auth.type === "bearer" ? auth.apiKey : "",
    auth,
    pricing: args.pricing(model),
    config: args.credentials.model_configs?.[model] ? {
      ...args.credentials.model_configs[model]!,
      allow_long_context: args.credentials.allow_long_context === true,
      zdr: args.credentials.zdr === true,
    } : undefined,
    conversationId: args.conversationId,
    sessionId: args.promptCacheKey?.trim()
      ? args.promptCacheKey
      : args.conversationId,
    reasoningEffort: args.decision.reasoningEffort,
    promptEstimate,
    ...(supplied?.baseUrl || supplied?.headers
      ? { endpoint: { baseUrl: supplied.baseUrl, headers: supplied.headers } }
      : {}),
    provider,
    providerKeySource,
    // Only resolved personal subscriptions are held at their usage limit;
    // the platform manages the plans it supplies.
    ...(providerKeySource === "subscription" && !supplied && args.credentials.attributed_user_id
      ? {
          subscriptionUserId: args.credentials.attributed_user_id,
          subscriptionCredentialId: args.credentials.subscription_credential_ids?.[provider],
        }
      : {}),
    usageContext: usageContextFor({
      billable: args.billable,
      credentials: args.credentials,
      routerId: args.routerId,
      selectedModel: model,
      keySource: providerKeySource,
      tags: args.tags ?? {},
    }),
    headers: {
      "X-Dari-Selected-Model": model,
      "X-Dari-Thinking-Level": args.decision.reasoningEffort,
      "X-Dari-Provider-Key-Source": providerKeySource,
      "X-Dari-Conversation-Id": args.conversationId,
      ...(args.decision.leaseTurnsRemaining === undefined
        ? {}
        : { "X-Dari-Lease-Turns-Remaining": String(args.decision.leaseTurnsRemaining) }),
      ...(args.decision.sessionPinned === true ? { "X-Dari-Session-Pinned": "true" } : {}),
    },
  };
}

export function startProviderCompletion(args: {
  interaction: InteractionRequest;
  execution: ProviderExecution;
  clientSignal?: AbortSignal;
}): StartedCompletion {
  const customerAbort = createProviderAttemptAbort({
    clientSignal: args.clientSignal,
  });
  const responseCapture = responseCaptureFor(args.execution);
  const promise = customerAbort.aborted
    ? Promise.reject(new CustomerDisconnectedError())
    : completeProvider({
        interaction: args.interaction,
        execution: args.execution,
        signal: customerAbort.signal,
        fetch: responseCapture?.fetch,
      });
  void promise.then(
    () => customerAbort.dispose(),
    () => customerAbort.dispose(),
  );
  promise.catch(() => undefined);
  return { promise, customerAbort, responseCapture };
}

function responseCaptureFor(execution: ProviderExecution): ProviderResponseCapture | undefined {
  return execution.providerKeySource === "subscription"
    ? createProviderResponseCapture()
    : undefined;
}

export async function startProviderStream(args: {
  interaction: InteractionRequest;
  execution: ProviderExecution;
  clientSignal?: AbortSignal;
}): Promise<StartedStream> {
  const providerStartedMs = Date.now();
  const customerAbort = createProviderAttemptAbort({
    clientSignal: args.clientSignal,
  });
  if (customerAbort.aborted) {
    customerAbort.dispose();
    throw new CustomerDisconnectedError();
  }
  const responseCapture = responseCaptureFor(args.execution);
  try {
    const providerStream = await streamInteractionModel({
      model: args.execution.model,
      request: args.interaction,
      apiKey: args.execution.apiKey,
      auth: await awsRoleCredentials.resolve(args.execution.auth),
      pricing: args.execution.pricing,
      config: args.execution.config,
      sessionId: args.execution.sessionId,
      selectedReasoningEffort: args.execution.reasoningEffort,
      endpoint: args.execution.endpoint,
      signal: customerAbort.signal,
      fetch: responseCapture?.fetch,
    });
    return {
      providerStream: {
        ...providerStream,
        events: scrubProviderEvents(providerStream.events, args.execution.auth),
      },
      providerStartedMs,
      customerAbort,
      responseCapture,
    };
  } catch (error) {
    const canceled = customerAbort.aborted;
    customerAbort.dispose();
    if (canceled) throw new CustomerDisconnectedError();
    throw attachProviderResponseCapture(error, responseCapture);
  }
}

type PrimedStream =
  | { outcome: "continue"; events: AsyncIterable<Record<string, unknown>> }
  | { outcome: "error"; failure: Record<string, unknown> };

export async function primeProviderStream(
  events: AsyncIterable<Record<string, unknown>>,
  customerAbort: ProviderAttemptAbort,
): Promise<PrimedStream> {
  const iterator = events[Symbol.asyncIterator]();
  const prefix: Record<string, unknown>[] = [];
  try {
    let result = await iterator.next();
    while (!result.done) {
      if (customerAbort.aborted) throw new CustomerDisconnectedError();
      const event = result.value;
      const failure = initialStreamFailure(event);
      if (failure) {
        await closeAsyncIterator(iterator);
        return { outcome: "error", failure };
      }
      prefix.push(event);
      if (isMeaningfulStreamEvent(event)) {
        return continueWithPrefix(prefix, iterator);
      }
      result = await iterator.next();
    }
  } catch (error) {
    if (customerAbort.aborted) {
      void closeAsyncIterator(iterator);
      throw new CustomerDisconnectedError();
    }
    await closeAsyncIterator(iterator);
    throw error;
  }
  if (customerAbort.aborted) {
    void closeAsyncIterator(iterator);
    throw new CustomerDisconnectedError();
  }
  await closeAsyncIterator(iterator);
  return {
    outcome: "error",
    failure: providerFailureFromCaught(
      "Provider stream ended without a terminal event.",
    ),
  };
}

export function scrubProviderMessage(
  message: Record<string, unknown>,
  auth: ProviderAuth,
): Record<string, unknown> {
  const scrubbed = scrubSecretValues(message, providerSecrets(auth));
  if (!isRecord(scrubbed)) {
    throw new Error("Scrubbing a provider message changed its object shape.");
  }
  return scrubbed;
}

async function completeProvider(args: {
  interaction: InteractionRequest;
  execution: ProviderCallConfig;
  signal?: AbortSignal;
  fetch?: ProviderFetch;
}): Promise<CompletedProviderCall> {
  const providerStartedAt = new Date();
  const completion = await completeInteractionModel({
    model: args.execution.model,
    request: args.interaction,
    apiKey: args.execution.apiKey,
    auth: await awsRoleCredentials.resolve(args.execution.auth),
    pricing: args.execution.pricing,
    config: args.execution.config,
    sessionId: args.execution.sessionId,
    selectedReasoningEffort: args.execution.reasoningEffort,
    endpoint: args.execution.endpoint,
    signal: args.signal,
    fetch: args.fetch,
  });
  return {
    ...completion,
    message: scrubProviderMessage(completion.message, args.execution.auth),
    providerLatencyMs: Date.now() - providerStartedAt.getTime(),
    providerStartedAt,
  };
}

function initialStreamFailure(
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  if (event.type === "error") return providerFailureFromEvent(event);
  if (
    event.type === "done" &&
    isRecord(event.message) &&
    isProviderFailureMessage(event.message)
  ) {
    return event.message;
  }
  return null;
}

function isMeaningfulStreamEvent(event: Record<string, unknown>): boolean {
  if (event.type === "done") return true;
  if (event.type === "text_delta" || event.type === "thinking_delta") {
    return typeof event.delta === "string" && event.delta.length > 0;
  }
  if (
    event.type === "toolcall_start" ||
    event.type === "toolcall_delta" ||
    event.type === "toolcall_end" ||
    event.type === "server_tool_call_start" ||
    event.type === "server_tool_call_end" ||
    event.type === "tool_search_result_start" ||
    event.type === "tool_search_result_end"
  ) {
    return true;
  }
  if (event.type !== "provider_event" || !isRecord(event.event)) return false;
  const type = event.event.type;
  if (typeof type !== "string") return false;
  if (type.startsWith("response.web_search_call.")) return true;
  return type === "response.output_item.added" &&
    isRecord(event.event.item) && event.event.item.type === "web_search_call";
}

function continueWithPrefix(
  prefix: Record<string, unknown>[],
  iterator: AsyncIterator<Record<string, unknown>>,
): PrimedStream {
  return {
    outcome: "continue",
    events: {
      async *[Symbol.asyncIterator]() {
        let exhausted = false;
        try {
          yield* prefix;
          let result = await iterator.next();
          while (!result.done) {
            yield result.value;
            result = await iterator.next();
          }
          exhausted = true;
        } finally {
          if (!exhausted) await closeAsyncIterator(iterator);
        }
      },
    },
  };
}

async function closeAsyncIterator(
  iterator: AsyncIterator<Record<string, unknown>>,
): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // Cleanup must not replace the provider failure or client cancellation.
  }
}

function providerSecrets(auth: ProviderAuth): string[] {
  if (auth.type === "bearer") return [auth.apiKey];
  if (auth.type === "aws_assume_role") return awsRoleCredentials.secrets(auth);
  return [
    auth.access_key_id,
    auth.secret_access_key,
    ...(auth.session_token ? [auth.session_token] : []),
  ];
}

function scrubProviderEvents(
  events: AsyncIterable<Record<string, unknown>>,
  auth: ProviderAuth,
): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of events) {
        yield scrubProviderMessage(event, auth);
      }
    },
  };
}
