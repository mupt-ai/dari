import type { CandidateModelMetadata } from "./compatibility.js";
import type { PricingLookup } from "./cost.js";
import { RouterCoreError } from "./errors.js";
import { RouterFrameworkError } from "./framework_error.js";
import type {
  RouterCandidate,
  RouterContent,
  RouterRequest,
  RoutingPolicy,
  RoutingPolicyInput,
} from "./framework_types.js";
import { optionsFingerprints } from "./fingerprint.js";
import {
  finalizeRoute,
  prepareRoute,
  type PreparedRoute,
  type RouteInput,
  type RouteResult,
  type Selector,
} from "./route.js";
import type {
  ChatCompletionRequest,
  ChatMessage,
  CustomRouterConfig,
  RouterEval,
  RouterModelPrice,
  RouterPrefixHit,
} from "./types.js";

export type DariPolicyState = {
  chainsByModel?: ReadonlyMap<string, string[]>;
  prefixHits?: RouterPrefixHit[];
  looseChain?: readonly string[];
  nowMs?: number;
  toolChoiceFingerprint?: string;
  responseFormatFingerprint?: string;
};

export type DariRoutingPolicyOptions<Metadata = unknown> = {
  selector?: Selector | ((request: ChatCompletionRequest, signal: AbortSignal) => Promise<string>);
  selectorModel: string;
  selectorContextWindowChars: number;
  metadata?: (model: RouterCandidate<Metadata>) => CandidateModelMetadata;
  pricing: PricingLookup;
  averageOutputTokensByModel: NonNullable<RouteInput["averageOutputTokensByModel"]>;
  evals?: RouterEval[] | ((input: RoutingPolicyInput<Metadata>) => RouterEval[] | Promise<RouterEval[]>);
  state?: (
    input: RoutingPolicyInput<Metadata>,
  ) => DariPolicyState | Promise<DariPolicyState>;
  strategy?: "dari" | "custom";
  customConfig?: CustomRouterConfig | null;
  modelPrices?: Record<string, RouterModelPrice>;
};

type InternalDariRoutingPolicyOptions<Metadata> = Omit<
  DariRoutingPolicyOptions<Metadata>,
  "pricing" | "averageOutputTokensByModel"
> & {
  pricing?: DariRoutingPolicyOptions<Metadata>["pricing"];
  averageOutputTokensByModel?: DariRoutingPolicyOptions<Metadata>["averageOutputTokensByModel"];
};

export type DariPolicyDetails = {
  prepared: PreparedRoute;
  selectorOutput: string;
};

export function createDariRoutingPolicy<Metadata = unknown>(
  options: DariRoutingPolicyOptions<Metadata>,
): RoutingPolicy<Metadata> {
  return createDariRoutingPolicyInternal(options, true);
}

export function createDariRoutingPolicyInternal<Metadata = unknown>(
  options: InternalDariRoutingPolicyOptions<Metadata>,
  requireAccounting: boolean,
): RoutingPolicy<Metadata> {
  const selector = options.selector;
  if (selector === undefined) {
    throw new RouterFrameworkError(
      "configuration",
      "Dari routing requires a selector.",
      "selector_missing",
    );
  }
  if (requireAccounting && typeof options.pricing !== "function") {
    throw new RouterFrameworkError(
      "configuration",
      "Dari routing requires a pricing lookup supplied by the host.",
      "pricing_missing",
      "pricing",
    );
  }
  if (requireAccounting && !options.averageOutputTokensByModel) {
    throw new RouterFrameworkError(
      "configuration",
      "Dari routing requires host-observed output-token averages.",
      "output_token_estimates_missing",
      "averageOutputTokensByModel",
    );
  }
  return async (input) => {
    const chatRequest = routerRequestToChat(input.request);
    const pricingByModel = options.pricing === undefined
      ? new Map<string, NonNullable<ReturnType<PricingLookup>>>()
      : validatedPricing(input.candidates, options.pricing);
    if (options.averageOutputTokensByModel !== undefined) {
      validateOutputTokenEstimates(input.candidates, options.averageOutputTokensByModel);
    }
    const state = await options.state?.(input) ?? {};
    const evals = typeof options.evals === "function"
      ? await options.evals(input)
      : options.evals ?? [];
    const fingerprints = optionsFingerprints(chatRequest);
    const candidateModels = input.candidates.map((candidate) => candidate.id);
    const metadataByModel = new Map(
      input.candidates.map((candidate) => [
        candidate.id,
        options.metadata?.(candidate) ?? defaultDariMetadata(candidate),
      ]),
    );
    let prepared: PreparedRoute;
    try {
      prepared = prepareRoute({
        candidateModels,
        metadataLookup: (model) => metadataByModel.get(model)!,
        requiredCapabilities: [],
        ...(input.request.reasoning?.effort === undefined
          ? {}
          : { requestedReasoningEffort: input.request.reasoning.effort }),
        ...(input.request.reasoning?.enabled === undefined
          ? {}
          : { thinkingEnabled: input.request.reasoning.enabled }),
        ...(chatRequest.tool_choice === undefined ? {} : { toolChoice: chatRequest.tool_choice }),
        modelThinkingLevels: Object.fromEntries(
          input.candidates.map((candidate) => [candidate.id, [...candidate.reasoningEfforts]]),
        ),
        strategy: options.strategy ?? "dari",
        ...(options.customConfig === undefined ? {} : { customConfig: options.customConfig }),
        modelPrices: options.modelPrices ?? {},
        pricing: (model) => pricingByModel.get(model) ?? null,
        ...(options.averageOutputTokensByModel === undefined
          ? {}
          : { averageOutputTokensByModel: options.averageOutputTokensByModel }),
        messages: chatRequest.messages ?? [],
        chainsByModel: state.chainsByModel ?? new Map(
          candidateModels.map((model) => [model, []]),
        ),
        prefixHits: state.prefixHits ?? [],
        nowMs: state.nowMs ?? Date.now(),
        ...(state.looseChain === undefined ? {} : { looseChain: state.looseChain }),
        toolChoiceFp: state.toolChoiceFingerprint ?? fingerprints.tool_choice_fp,
        responseFormatFp: state.responseFormatFingerprint ?? fingerprints.response_format_fp,
        evals,
        selectorModel: options.selectorModel,
        selectorContextWindowChars: options.selectorContextWindowChars,
        // Selection fallback is deliberately not provider retry. The framework
        // dispatches one chosen candidate and leaves retries to its executor.
        modelFallbackEnabled: false,
      });
    } catch (error) {
      throw mapDariPolicyError(error);
    }
    if (prepared.selectorPreparation === null) {
      throw new RouterFrameworkError(
        "configuration",
        "Dari custom routing requires a non-empty customConfig.",
        "custom_config_missing",
      );
    }

    const selectorRequest = prepared.selectorPreparation.selectorRequest;
    let selectorOutput: string;
    try {
      selectorOutput = typeof selector === "function"
        ? await selector(selectorRequest, input.signal)
        : await selector.select(selectorRequest, input.signal);
    } catch (error) {
      throw mapSelectorError(error);
    }
    let result: RouteResult;
    try {
      result = finalizeRoute(prepared, selectorOutput);
    } catch (error) {
      throw mapDariPolicyError(error);
    }
    return {
      model: result.decision.selectedModel,
      reasoningEffort: result.decision.reasoningEffort,
      reason: result.decision.reason,
      ...(result.decision.leaseTurnsRemaining === undefined
        ? {}
        : { leaseTurnsRemaining: result.decision.leaseTurnsRemaining }),
      details: { prepared, selectorOutput } satisfies DariPolicyDetails,
    };
  };
}

function validatedPricing<Metadata>(
  candidates: readonly RouterCandidate<Metadata>[],
  pricing: PricingLookup,
): Map<string, NonNullable<ReturnType<PricingLookup>>> {
  const resolved = new Map<string, NonNullable<ReturnType<PricingLookup>>>();
  for (const candidate of candidates) {
    const price = pricing(candidate.id);
    if (
      price === null ||
      [price.input, price.output, price.cacheRead, price.cacheWrite].some((value) => !Number.isFinite(value) || value < 0) ||
      price.tiers?.some((tier) => Object.values(tier).some((value) => !Number.isFinite(value) || value < 0))
    ) {
      throw new RouterFrameworkError(
        "configuration",
        `Missing or invalid pricing for ${candidate.id}.`,
        "model_pricing_invalid",
        `pricing.${candidate.id}`,
      );
    }
    resolved.set(candidate.id, price);
  }
  return resolved;
}

function validateOutputTokenEstimates<Metadata>(
  candidates: readonly RouterCandidate<Metadata>[],
  estimates: NonNullable<RouteInput["averageOutputTokensByModel"]>,
): void {
  for (const candidate of candidates) {
    const byEffort = estimates[candidate.id];
    for (const effort of candidate.reasoningEfforts) {
      const estimate = byEffort?.[effort];
      if (estimate === undefined || !Number.isFinite(estimate) || estimate < 0) {
        throw new RouterFrameworkError(
          "configuration",
          `Missing or invalid output-token estimate for ${candidate.id}/${effort}.`,
          "output_token_estimate_invalid",
          `averageOutputTokensByModel.${candidate.id}.${effort}`,
        );
      }
    }
  }
}

function mapSelectorError(error: unknown): unknown {
  if (!(error instanceof RouterFrameworkError) || error.kind !== "executor") return error;
  return new RouterFrameworkError(
    "policy",
    error.message,
    error.code,
    error.param,
    { cause: error },
  );
}

function mapDariPolicyError(error: unknown): unknown {
  if (!(error instanceof RouterCoreError)) return error;
  const kind = error.kind === "invalid_request"
    ? "invalid_request"
    : error.kind === "configuration"
      ? "configuration"
      : "policy";
  return new RouterFrameworkError(
    kind,
    error.message,
    error.code,
    error.param,
    { cause: error },
  );
}

function defaultDariMetadata<Metadata>(
  candidate: RouterCandidate<Metadata>,
): CandidateModelMetadata {
  return {
    provider: candidate.provider,
    api: candidate.api,
    supportsImageInput: candidate.capabilities.imageInput,
    supportsHostedWebSearch: false,
    supportsReasoningConfigurationUpdate: false,
    supportsStructuredOutput: candidate.capabilities.structuredOutput,
    supportedThinkingLevels: [...candidate.reasoningEfforts],
  };
}

function routerRequestToChat(request: RouterRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];
  for (const item of request.items) {
    if (item.type === "message") {
      const content = chatContent(item.content);
      const previous = messages.at(-1);
      if (item.role === "assistant" && previous?.role === "assistant") {
        const previousContent = previous.content;
        previous.content = Array.isArray(previousContent)
          ? [...previousContent, ...content]
          : content;
      } else {
        messages.push({ role: item.role, content });
      }
      continue;
    }
    if (item.type === "reasoning") {
      const readable = [...(item.summary ?? []), ...item.content].join("\n");
      let assistant = messages.at(-1);
      if (!assistant || assistant.role !== "assistant" || hasAssistantContent(assistant)) {
        assistant = { role: "assistant", content: null };
        messages.push(assistant);
      }
      if (readable) {
        assistant.reasoning_content = appendReasoningText(assistant.reasoning_content, readable);
      }
      continue;
    }
    if (item.type === "tool_result") {
      messages.push({
        role: "tool",
        tool_call_id: item.toolCallId,
        content: chatContent(item.content),
      });
      continue;
    }

    let assistant = messages.at(-1);
    if (assistant?.role !== "assistant") {
      assistant = { role: "assistant", content: null, tool_calls: [] };
      messages.push(assistant);
    }
    assistant.tool_calls ??= [];
    if (item.type === "hosted_tool_call") {
      const payload: Record<string, unknown> = {
        ...item.payload,
        type: item.providerType,
        id: item.id,
      };
      if (item.status) payload.status = item.status;
      else delete payload.status;
      assistant.tool_calls.push({
        id: item.id,
        type: "function",
        function: { name: item.tool, arguments: JSON.stringify(payload) },
      });
      continue;
    }
    assistant.tool_calls.push({
      id: item.id,
      type: "function",
      function: {
        name: item.name,
        arguments: typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments),
      },
    });
  }

  return {
    model: request.requestedModel,
    messages,
    stream: request.stream,
    source_protocol: request.protocol === "anthropic_messages"
      ? "anthropic_messages"
      : "openai_chat",
    ...(request.cacheKey === undefined ? {} : { prompt_cache_key: request.cacheKey }),
    ...(request.generation.temperature === undefined
      ? {}
      : { temperature: request.generation.temperature }),
    ...(request.generation.topP === undefined ? {} : { top_p: request.generation.topP }),
    ...(request.generation.maxOutputTokens === undefined
      ? {}
      : { max_completion_tokens: request.generation.maxOutputTokens }),
    ...(request.generation.stop === undefined ? {} : { stop: request.generation.stop }),
    ...(request.tools.length === 0 ? {} : { tools: request.tools.map(chatTool) }),
    ...(request.toolChoice === undefined ? {} : { tool_choice: chatToolChoice(request.toolChoice) }),
    ...(request.parallelToolCalls === undefined
      ? {}
      : { parallel_tool_calls: request.parallelToolCalls }),
    ...(request.responseFormat === undefined
      ? {}
      : { response_format: chatResponseFormat(request.responseFormat) }),
    ...(request.reasoning?.effort === undefined
      ? {}
      : { reasoning_effort: request.reasoning.effort }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    ...(request.user === undefined ? {} : { user: request.user }),
  };
}

function chatContent(content: readonly RouterContent[]): Array<Record<string, unknown>> {
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : {
          type: "image_url",
          image_url: {
            url: part.url,
            ...(part.detail === undefined ? {} : { detail: part.detail }),
          },
        }
  );
}

function hasAssistantContent(message: ChatMessage): boolean {
  if (message.content !== undefined && message.content !== null) return true;
  return (message.tool_calls?.length ?? 0) > 0;
}

function appendReasoningText(existing: string | undefined, text: string): string {
  return existing ? `${existing}\n${text}` : text;
}

function chatTool(tool: RouterRequest["tools"][number]): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.inputSchema,
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    },
  };
}

function chatToolChoice(choice: NonNullable<RouterRequest["toolChoice"]>): string | Record<string, unknown> {
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

function chatResponseFormat(
  format: NonNullable<RouterRequest["responseFormat"]>,
): NonNullable<ChatCompletionRequest["response_format"]> {
  if (format.type !== "json_schema") return format;
  return {
    type: "json_schema",
    json_schema: {
      name: format.name,
      schema: format.schema,
      ...(format.description === undefined ? {} : { description: format.description }),
      ...(format.strict === undefined ? {} : { strict: format.strict }),
    },
  };
}
