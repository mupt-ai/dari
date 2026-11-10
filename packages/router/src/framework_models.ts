import { providerForModel } from "./model_ids.js";
import { RouterFrameworkError } from "./framework_error.js";
import { isReasoningEffort } from "./types.js";
import type {
  RouterCandidate,
  RouterExecutor,
  RouterModel,
  RouterRequest,
} from "./framework_types.js";

const DEFAULT_CAPABILITIES = {
  imageInput: false,
  toolUse: false,
  structuredOutput: false,
  streaming: false,
} as const;

export function normalizeRouterModels<Metadata>(
  models: readonly RouterModel<Metadata>[],
  executors: Readonly<Record<string, RouterExecutor<Metadata>>>,
): RouterCandidate<Metadata>[] {
  if (!Array.isArray(models) || models.length === 0) {
    throw configurationError("A router requires at least one model.", "models_empty");
  }
  if (!executors || typeof executors !== "object") {
    throw configurationError("executors must be an object.", "executors_invalid");
  }

  const ids = new Set<string>();
  return models.map((model, index) => {
    if (typeof model?.id !== "string" || !model.id.trim() || model.id !== model.id.trim()) {
      throw configurationError(`models[${index}].id must be a trimmed non-empty string.`, "model_invalid");
    }
    if (ids.has(model.id)) {
      throw configurationError(`Duplicate router model '${model.id}'.`, "model_duplicate");
    }
    ids.add(model.id);
    if (
      typeof model.executor !== "string" ||
      !model.executor.trim() ||
      model.executor !== model.executor.trim() ||
      !Object.hasOwn(executors, model.executor)
    ) {
      throw configurationError(
        `Model '${model.id}' references missing executor '${String(model.executor)}'.`,
        "executor_missing",
      );
    }
    const executor = executors[model.executor];
    if (!executor || typeof executor.execute !== "function") {
      throw configurationError(
        `Executor '${model.executor}' must define an execute function.`,
        "executor_invalid",
      );
    }

    const reasoningEfforts = model.reasoningEfforts === undefined
      ? ["off" as const]
      : [...model.reasoningEfforts];
    if (
      reasoningEfforts.length === 0 ||
      reasoningEfforts.some((effort) => !isReasoningEffort(effort)) ||
      new Set(reasoningEfforts).size !== reasoningEfforts.length
    ) {
      throw configurationError(
        `Model '${model.id}' must declare unique supported reasoning efforts.`,
        "model_reasoning_invalid",
      );
    }
    const defaultReasoningEffort = model.defaultReasoningEffort ?? reasoningEfforts[0]!;
    if (!reasoningEfforts.includes(defaultReasoningEffort)) {
      throw configurationError(
        `Model '${model.id}' default reasoning effort is not supported by that model.`,
        "model_reasoning_invalid",
      );
    }

    let provider = model.provider;
    if (provider !== undefined && (
      typeof provider !== "string" || !provider.trim() || provider !== provider.trim()
    )) {
      throw configurationError(
        `Model '${model.id}' provider must be a trimmed non-empty string.`,
        "model_provider_invalid",
      );
    }
    if (provider === undefined) {
      try {
        provider = providerForModel(model.id);
      } catch (error) {
        throw configurationError(
          `Model '${model.id}' needs an explicit provider because its id has no provider prefix.`,
          "model_provider_missing",
          error,
        );
      }
    }
    if (model.providerModelId !== undefined && (
      typeof model.providerModelId !== "string"
      || !model.providerModelId.trim()
      || model.providerModelId !== model.providerModelId.trim()
    )) {
      throw configurationError(
        `Model '${model.id}' providerModelId must be a trimmed non-empty string.`,
        "model_provider_model_id_invalid",
      );
    }

    const api = model.api ?? model.executor;
    if (typeof api !== "string" || !api.trim() || api !== api.trim()) {
      throw configurationError(
        `Model '${model.id}' api must be a trimmed non-empty string.`,
        "model_api_invalid",
      );
    }
    const capabilities = { ...DEFAULT_CAPABILITIES, ...model.capabilities };
    if (Object.values(capabilities).some((value) => typeof value !== "boolean")) {
      throw configurationError(
        `Model '${model.id}' capabilities must be booleans.`,
        "model_capabilities_invalid",
      );
    }

    return {
      id: model.id,
      executor: model.executor,
      provider,
      ...(model.providerModelId === undefined ? {} : { providerModelId: model.providerModelId }),
      api,
      reasoningEfforts,
      defaultReasoningEffort,
      capabilities,
      ...(model.metadata === undefined ? {} : { metadata: model.metadata }),
    };
  });
}

export function eligibleRouterModels<Metadata>(
  request: RouterRequest,
  models: readonly RouterCandidate<Metadata>[],
): RouterCandidate<Metadata>[] {
  const requiresImage = request.items.some((item) =>
    item.type === "message"
      ? item.content.some((part) => part.type === "image")
      : item.type === "tool_result" && item.content.some((part) => part.type === "image"),
  );
  const requiresTools = request.tools.length > 0 || request.items.some((item) =>
    item.type === "tool_call" || item.type === "tool_result" || item.type === "hosted_tool_call",
  );
  const requiresStructuredOutput =
    request.responseFormat !== undefined && request.responseFormat.type !== "text";
  const requestedEffort = request.reasoning?.effort;

  const eligible = models.flatMap((model) => {
    if (requiresImage && !model.capabilities.imageInput) return [];
    if (requiresTools && !model.capabilities.toolUse) return [];
    if (requiresStructuredOutput && !model.capabilities.structuredOutput) return [];
    if (request.stream && !model.capabilities.streaming) return [];

    const efforts = requestedEffort === undefined
      ? request.reasoning?.enabled === true
        ? model.reasoningEfforts.filter((effort) => effort !== "off")
        : [...model.reasoningEfforts]
      : model.reasoningEfforts.includes(requestedEffort)
        ? [requestedEffort]
        : [];
    if (efforts.length === 0) return [];
    return [{
      ...model,
      reasoningEfforts: efforts,
      defaultReasoningEffort: efforts.includes(model.defaultReasoningEffort)
        ? model.defaultReasoningEffort
        : efforts[0]!,
    }];
  });

  if (eligible.length > 0) return eligible;
  throw new RouterFrameworkError(
    "invalid_request",
    "No configured model supports this request's protocol features and reasoning settings.",
    "no_eligible_models",
  );
}

function configurationError(
  message: string,
  code: string,
  cause?: unknown,
): RouterFrameworkError {
  return new RouterFrameworkError(
    "configuration",
    message,
    code,
    undefined,
    cause === undefined ? undefined : { cause },
  );
}
