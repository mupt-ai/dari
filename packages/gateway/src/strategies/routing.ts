import {
  CHARS_PER_TOKEN,
  RouterCoreError,
  buildSizedSelectorRequest,
  isRecord,
  parseSelectorDecision,
  sameRoutingCandidate,
  selectorSafeMessages,
  type CandidateCostEstimate,
  type ChatCompletionRequest,
  type ChatMessage,
  type CustomDefaultTarget,
  type CustomRouterRule,
  type CustomSelectorInput,
  type PreviousDecision,
  type ReasoningEffort,
  type ResolvedJevConfig,
  type RouterEval,
  type RoutingCandidate,
  type RoutingDecision,
  type SelectorInput,
  type SelectorLeaseHistoryEntry,
} from "@mupt-ai/dari-router/policy-engine";
import { HttpError } from "../http/errors.js";
import { executionProviderForModel } from "../models/execution_provider.js";
import { providerLabel } from "../models/provider_defaults.js";
import { internalChatCompletionsToInteraction } from "../protocol/input/chat_completions.js";
import { gatewayPlatform, type ResolveRouterRequest } from "../platform/platform.js";
import { isBedrockApi } from "../providers/model_capabilities.js";
import { completeInteractionModel, modelContextWindow } from "../providers/pi.js";
import type {
  AwsAssumeRoleProviderAuth,
  AwsSigV4ProviderAuth,
  ProviderAuth,
  ResolvedRouter,
} from "../types.js";
import type { SelectorImage } from "./selector_projection.js";

export function resolveRouter(args: ResolveRouterRequest): Promise<ResolvedRouter> {
  return gatewayPlatform().resolveRouter(args);
}

export type SelectorTrace = {
  selectorModel: string;
  candidates: RoutingCandidate[];
  selectorInput: SelectorInput | CustomSelectorInput;
  selectorRequest: ChatCompletionRequest;
  outputText: string;
  rejectedOutputTexts?: string[];
  usage: Record<string, unknown> | null;
  latencyMs: number;
};

export type SelectorRun = SelectorTrace & {
  decision: RoutingDecision;
};

export type SelectModelArgs = {
  // The configured roster before pruning; anonymous-action selectors assign
  // conversation-stable letters over it. Optional: absent, the active set is
  // treated as the roster.
  allCandidates?: RoutingCandidate[];
  messages: ChatMessage[];
  candidates: RoutingCandidate[];
  evals?: RouterEval[];
  previousDecision?: PreviousDecision;
  costEstimates?: CandidateCostEstimate[];
  customRules?: CustomRouterRule[];
  defaultTarget?: CustomDefaultTarget | null;
  sessionId?: string;
  executionProviderForModel?: (model: string) => string;
  imputeEvalScores?: boolean;
  imputationReferenceEvals?: RouterEval[];
  leaseHistory?: SelectorLeaseHistoryEntry[];
  // Absent means ENABLED — deliberate: training and experiment callers
  // predate the flag and must keep lease-context behavior. When false, the
  // selector input carries no lease_history key (byte-identical to the
  // pre-lease-context shape).
  leaseContextEnabled?: boolean;
  // Images behind the `<image N>` placeholders in `messages`. Only a backend
  // that advertises image input attaches them; every other selector ignores
  // them and routes on the placeholders alone.
  images?: SelectorImage[];
};

export type SelectorAdapterArgs = SelectModelArgs & {
  selectorModel: string;
  selectorInput: SelectorInput | CustomSelectorInput;
  selectorRequest: ChatCompletionRequest;
  startedAt: number;
};

export type SelectorAdapter = (args: SelectorAdapterArgs) => Promise<SelectorRun>;

export type SelectorBackend = {
  selectorModel: string;
  contextWindowChars: () => Promise<number>;
  prepareMessages?: (messages: ChatMessage[]) => ChatMessage[];
  select: SelectorAdapter;
  // Turn commitments this backend's deployed policy advertises; empty or
  // absent means per-turn decisions (the runtime then applies its stateless
  // hold). Async because the menu is discovered from the policy endpoint.
  negotiatedLeaseTurns?: () => Promise<readonly number[]>;
  // Whether the runtime may serve the incumbent while this backend selects.
  // Defaults to true; unavailable/configuration-error backends must disable it.
  supportsSpeculativeRouting?: boolean;
  // How many request images the deployed policy accepts per decision; 0 or
  // absent means the backend routes on text alone.
  maxImages?: () => Promise<number>;
  // Jev decides which eval cards (the organization's plus the public
  // catalog) are relevant to each request before selection. Production
  // wiring sets it on the selector chain; test backends may leave it out to see
  // the organization's cards as given.
  evalRelevance?: ResolvedJevConfig;
};

export function createLlmSelectorBackend(config: {
  model: string;
  apiKey: string;
  reasoningEffort?: ReasoningEffort;
}): SelectorBackend {
  const model = requiredSelectorConfig(config.model, "LLM selector model");
  const apiKey = requiredSelectorConfig(config.apiKey, "LLM selector API key");
  return {
    selectorModel: model,
    contextWindowChars: () => selectorContextWindowChars(model),
    select: (args) => callLlmSelector(args, apiKey, config.reasoningEffort),
  };
}

export const SELECTOR_OUTPUT_ATTEMPTS = 2;

// Exported so other selector backends can attach the raw policy completion
// to failures the same way the LLM selector does. Without this wrapping,
// selectorTraceFromError() returns null for their failures and the malformed
// completion is never reported.
export class SelectorOutputError extends HttpError {
  readonly selectorTrace: SelectorTrace;

  constructor(error: HttpError, selectorTrace: SelectorTrace) {
    super(error.status, error.message, error.code, error.param);
    this.selectorTrace = selectorTrace;
  }
}

export function selectorTraceFromError(error: unknown): SelectorTrace | null {
  return error instanceof SelectorOutputError ? error.selectorTrace : null;
}

export async function selectModel(
  args: SelectModelArgs & { selectorBackend: SelectorBackend },
): Promise<SelectorRun> {
  const { selectorBackend } = args;
  const selectorModel = selectorBackend.selectorModel;
  const startedAt = Date.now();
  const contextWindowChars = await selectorBackend.contextWindowChars();
  const safeMessages = selectorSafeMessages(args.messages);
  const leaseContextEnabled = args.leaseContextEnabled !== false;
  const { selectorInput, selectorRequest } = buildSizedSelectorRequest({
    candidates: args.candidates,
    evals: args.evals,
    previousDecision: args.previousDecision,
    costEstimates: args.costEstimates,
    customRules: args.customRules,
    defaultTarget: args.defaultTarget,
    selectorModel,
    contextWindowChars,
    messages: selectorBackend.prepareMessages?.(safeMessages) ?? safeMessages,
    ...(leaseContextEnabled ? { leaseHistory: args.leaseHistory ?? [] } : {}),
    imputeEvalScores: args.imputeEvalScores,
    imputationReferenceEvals: args.imputationReferenceEvals,
  });
  const runArgs: SelectorAdapterArgs = {
    ...args,
    selectorModel,
    selectorInput,
    selectorRequest,
    startedAt,
  };
  const run = await selectorBackend.select(runArgs);
  return validateSelectorRun(run, args);
}

async function selectorContextWindowChars(selectorModel: string): Promise<number> {
  const contextWindow = modelContextWindow(selectorModel);
  if (contextWindow === null) {
    throw new HttpError(
      500,
      `No context window is configured for selector model ${selectorModel}.`,
      "configuration_error"
    );
  }
  return contextWindow * CHARS_PER_TOKEN;
}

async function callLlmSelector(
  args: SelectorAdapterArgs,
  selectorApiKey: string,
  reasoningEffort?: ReasoningEffort,
): Promise<SelectorRun> {
  const rejectedOutputTexts: string[] = [];
  const usages: Array<Record<string, unknown> | null> = [];

  for (let attempt = 1; attempt <= SELECTOR_OUTPUT_ATTEMPTS; attempt += 1) {
    let message: Record<string, unknown>;
    try {
      const completion = await completeInteractionModel({
        model: args.selectorModel,
        request: internalChatCompletionsToInteraction(args.selectorRequest),
        apiKey: selectorApiKey,
        sessionId: args.sessionId,
        ...(reasoningEffort ? { selectedReasoningEffort: reasoningEffort } : {}),
      });
      message = completion.message;
    } catch {
      throw selectorExecutionError(args, rejectedOutputTexts, usages);
    }
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw selectorExecutionError(args, rejectedOutputTexts, usages);
    }

    const text = assistantText(message);
    usages.push(isRecord(message.usage) ? message.usage : null);
    try {
      // The managed LLM selector never negotiates leases, so drop any
      // lease_turns_remaining a non-strict provider stamps on the output.
      const { leaseTurnsRemaining: _leaseTurnsRemaining, ...decision } =
        parseSelectorDecision(text).decision;
      return {
        decision,
        selectorModel: args.selectorModel,
        candidates: args.candidates,
        selectorInput: args.selectorInput,
        selectorRequest: args.selectorRequest,
        outputText: text,
        ...(rejectedOutputTexts.length > 0
          ? { rejectedOutputTexts: [...rejectedOutputTexts] }
          : {}),
        usage: aggregateSelectorUsage(usages),
        latencyMs: Date.now() - args.startedAt,
      };
    } catch (error) {
      const mapped = selectorOutputHttpError(error);
      if (!mapped || !isMalformedSelectorOutput(mapped)) throw error;
      if (attempt < SELECTOR_OUTPUT_ATTEMPTS) {
        rejectedOutputTexts.push(text);
        continue;
      }
      throw new SelectorOutputError(mapped, {
        selectorModel: args.selectorModel,
        candidates: args.candidates,
        selectorInput: args.selectorInput,
        selectorRequest: args.selectorRequest,
        outputText: text,
        ...(rejectedOutputTexts.length > 0
          ? { rejectedOutputTexts: [...rejectedOutputTexts] }
          : {}),
        usage: aggregateSelectorUsage(usages),
        latencyMs: Date.now() - args.startedAt,
      });
    }
  }

  throw new HttpError(502, "Selector request failed.", "selector_execution_failed");
}

function validateSelectorRun(run: SelectorRun, args: SelectModelArgs): SelectorRun {
  const selected = {
    model: run.decision.selectedModel,
    reasoningEffort: run.decision.reasoningEffort,
  };
  if (!args.candidates.some((candidate) => sameRoutingCandidate(candidate, selected))) {
    throw new SelectorOutputError(
      new HttpError(
        502,
        "Selector returned a model/thinking-level pair outside this router's candidates.",
        "selector_invalid_candidate",
      ),
      run,
    );
  }
  return run;
}

function requiredSelectorConfig(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new HttpError(500, `${label} is not configured.`, "configuration_error");
  }
  return normalized;
}

export function providerAuthForSelectedModel(args: {
  selectedModel: string;
  credentials: ResolvedRouter;
}): ProviderAuth {
  const provider = executionProviderForModel(args.credentials, args.selectedModel);
  const config = args.credentials.model_configs?.[args.selectedModel];
  const structured = args.credentials.provider_auth?.[provider];
  const key = args.credentials.provider_keys[provider]?.trim();
  if (structured !== undefined) {
    if (
      key
      || (provider !== "amazon-bedrock" && !isBedrockApi(config?.api))
      || !(isAwsSigV4ProviderAuth(structured) || isAwsAssumeRoleProviderAuth(structured))
    ) {
      throw new HttpError(
        500,
        `Invalid ${providerLabel(provider)} provider authentication is configured for this router.`,
        "provider_configuration_error",
      );
    }
    return structured;
  }
  if (key) return { type: "bearer", apiKey: key };
  const source = args.credentials.provider_key_sources?.[provider] ?? "user";
  const prefix = source === "managed" ? "Dari-managed" : "stored";
  throw new HttpError(
    401,
    `No ${prefix} ${providerLabel(provider)} provider credential is configured for this router.`,
    "missing_provider_key",
  );
}

function isAwsAssumeRoleProviderAuth(
  value: unknown,
): value is AwsAssumeRoleProviderAuth {
  return (
    isRecord(value)
    && value.type === "aws_assume_role"
    && typeof value.role_arn === "string"
    && Boolean(value.role_arn.trim())
    && typeof value.external_id === "string"
    && Boolean(value.external_id.trim())
    && typeof value.region === "string"
    && Boolean(value.region.trim())
  );
}

function isAwsSigV4ProviderAuth(
  value: unknown,
): value is AwsSigV4ProviderAuth {
  return (
    isRecord(value)
    && value.type === "aws_sigv4"
    && typeof value.access_key_id === "string"
    && Boolean(value.access_key_id.trim())
    && typeof value.secret_access_key === "string"
    && Boolean(value.secret_access_key.trim())
    && typeof value.region === "string"
    && Boolean(value.region.trim())
    && (
      value.session_token == null
      || (
        typeof value.session_token === "string"
        && Boolean(value.session_token.trim())
      )
    )
  );
}

function assistantText(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => String(item.text))
    .join("");
}

function selectorOutputHttpError(error: unknown): HttpError | null {
  if (error instanceof HttpError) return error;
  if (!(error instanceof RouterCoreError) || error.kind !== "selector_output") return null;
  return new HttpError(502, error.message, error.code, error.param);
}

function isMalformedSelectorOutput(error: HttpError): boolean {
  return error.code === "selector_invalid_json" || error.code === "selector_invalid_response";
}

function selectorExecutionError(
  args: SelectorAdapterArgs,
  rejectedOutputTexts: string[],
  usages: Array<Record<string, unknown> | null>,
): HttpError {
  const error = new HttpError(502, "Selector request failed.", "selector_execution_failed");
  const lastOutput = rejectedOutputTexts.at(-1);
  if (lastOutput === undefined) return error;
  return new SelectorOutputError(error, {
    selectorModel: args.selectorModel,
    candidates: args.candidates,
    selectorInput: args.selectorInput,
    selectorRequest: args.selectorRequest,
    outputText: lastOutput,
    ...(rejectedOutputTexts.length > 1
      ? { rejectedOutputTexts: rejectedOutputTexts.slice(0, -1) }
      : {}),
    usage: aggregateSelectorUsage(usages),
    latencyMs: Date.now() - args.startedAt,
  });
}

function aggregateSelectorUsage(
  usages: Array<Record<string, unknown> | null>,
): Record<string, unknown> | null {
  const records = usages.filter((usage): usage is Record<string, unknown> => usage !== null);
  if (records.length === 0) return null;
  if (records.length === 1) return records[0];
  const aggregate: Record<string, unknown> = { ...records.at(-1) };
  for (const key of ["input", "cacheRead", "cacheWrite", "output", "totalTokens"]) {
    const total = sumFiniteField(records, key);
    if (total !== null) aggregate[key] = total;
  }
  const costs = records.flatMap((usage) => isRecord(usage.cost) ? [usage.cost] : []);
  if (costs.length > 0) {
    const aggregateCost: Record<string, unknown> = {
      ...(isRecord(aggregate.cost) ? aggregate.cost : {}),
    };
    for (const key of ["input", "cacheRead", "cacheWrite", "output", "total"]) {
      const total = sumFiniteField(costs, key);
      if (total !== null) aggregateCost[key] = total;
    }
    aggregate.cost = aggregateCost;
  }
  return aggregate;
}

function sumFiniteField(
  records: Array<Record<string, unknown>>,
  key: string,
): number | null {
  const values = records.flatMap((record) =>
    typeof record[key] === "number" && Number.isFinite(record[key])
      ? [record[key] as number]
      : [],
  );
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
}
