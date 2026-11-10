import type { BedrockOptions } from "@mupt-ai/pi-ai/api/bedrock-converse-stream";
import { isReasoningEffort, isRecord, type ReasoningEffort } from "@mupt-ai/dari-router/policy-engine";
import type { InteractionRequest, InteractionResponseFormat, InteractionToolChoice } from "../interaction/types.js";
import { requiredCapabilitiesFor } from "../interaction/capabilities.js";
import { toolWireName, toolsByWireName } from "../interaction/tool_identity.js";
import { gatewayFor, payloadWithGatewayFields } from "../models/gateways.js";
import { offRequiresWireNone } from "../models/runtime_overrides.js";
import { effectiveReasoningForModel, validateReasoningEffortForModel } from "./reasoning.js";
import { isBedrockApi, isOpenAIResponsesApi } from "./model_capabilities.js";
import type { ResolvedProviderAuth } from "../types.js";
import type { ProviderFetch } from "./response_capture.js";
import { forwardsAnthropicSafeguards, payloadWithSafeguards } from "./anthropic_safeguards.js";

type PiOptionsSupport = {
  getSupportedThinkingLevels?: (model: Record<string, unknown>) => string[];
};

type Payload = Record<string, unknown>;
// A patch returns the next payload, or undefined to leave it unchanged.
type PayloadPatch = (payload: Payload) => unknown;
type Model = Record<string, unknown>;
type ImageDetail = "auto" | "low" | "high" | "original";

const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01";
const ANTHROPIC_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";
// Anthropic rejects newer models from older Claude Code versions, so forward
// the client's own user agent and keep this fallback current for other clients.
const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.280";
const IMAGE_DETAILS: readonly unknown[] = ["auto", "low", "high", "original"];

const isAnthropic = (api: unknown) => api === "anthropic-messages";
const isCompletions = (api: unknown) => api === "openai-completions";
// Responses payloads Pi builds from the public OpenAI/Azure APIs (not Codex).
const isResponses = (api: unknown) => api === "openai-responses" || api === "azure-openai-responses";
const isOpenAI = (api: unknown) => isResponses(api) || isCompletions(api);
const isGoogle = (api: unknown) => api === "google-generative-ai" || api === "google-vertex";

export function buildOptions(
  request: InteractionRequest,
  auth: ResolvedProviderAuth | string,
  selectedModel: string,
  model: Model,
  pi: PiOptionsSupport,
  sessionId?: string,
  selectedReasoningEffort?: ReasoningEffort,
  timeoutMs = 1800_000,
  signal?: AbortSignal,
  fetch?: ProviderFetch,
): Record<string, unknown> {
  const api = model.api;
  const providerAuth: ResolvedProviderAuth = typeof auth === "string" ? { type: "bearer", apiKey: auth } : auth;
  const { generation, toolChoice, parallelToolCalls, responseFormat } = request;
  const headers: Record<string, string> = {};
  const bearerHeader = sendsBearerToMessages(providerAuth, model);
  if (bearerHeader) headers.authorization = `Bearer ${providerAuth.apiKey}`;
  const options: Record<string, unknown> = {
    ...(bearerHeader ? {} : authenticationOptions(providerAuth, api)),
    maxRetries: 0,
    timeoutMs,
    signal,
    fetch,
    metadata: { ...request.metadata, ...(request.user ? { user: request.user } : {}) },
    // Feeds OpenAI prompt_cache_key + session-affinity headers inside pi-ai;
    // ignored by providers without session-based caching.
    sessionId: sessionId || undefined,
  };
  const patches: PayloadPatch[] = [];

  if (isClaudeCodeOAuth(providerAuth, api)) {
    headers["user-agent"] = request.claudeCodeUserAgent ?? CLAUDE_CODE_USER_AGENT;
  }
  if (model.provider === "meta" && request.museCodeClientId !== undefined) {
    headers["x-client-id"] = request.museCodeClientId;
  }
  // Pi's Anthropic transport honors compat.supportsTemperature; the OpenAI
  // transports forward temperature regardless, so drop it here for models
  // that reject it instead of failing the whole request.
  if (!(isRecord(model.compat) && model.compat.supportsTemperature === false)) {
    options.temperature = generation.temperature;
  }
  options.maxTokens = generation.maxOutputTokens;
  if (generation.topP !== undefined || generation.stop !== undefined) {
    patches.push((payload) => payloadWithSamplingControls(payload, request, api));
  }

  if (isAnthropic(api)) {
    const budgetTokens = request.reasoning?.budgetTokens;
    if (request.reasoning?.enabled === false) {
      patches.push((payload) => ({ ...payload, thinking: { type: "disabled" } }));
    } else if (budgetTokens !== undefined) {
      patches.push((payload) => ({
        ...payload,
        thinking: { ...asRecord(payload.thinking), type: "enabled", budget_tokens: budgetTokens },
      }));
    }
    patches.push(payloadWithoutThinkingBlockBinding);
  }

  const gatewayFields = gatewayFor(model.provider)?.requestFields({ zdr: model.zeroDataRetention === true });
  if (gatewayFields !== undefined && Object.keys(gatewayFields).length > 0) {
    patches.push((payload) => payloadWithGatewayFields(payload, gatewayFields));
  }
  const safeguards = request.anthropicSafeguards;
  if (safeguards !== undefined && forwardsAnthropicSafeguards(request, model)) {
    patches.push((payload) => payloadWithSafeguards(payload, safeguards));
  }

  if (isOpenAIResponsesApi(api) && requiredCapabilitiesFor(request).includes("openai_hosted_web_search")) {
    options.emitProviderEvents = true;
    const hosted = request.tools.flatMap((tool) => tool.kind === "hosted" ? [{ ...tool.config }] : []);
    if (hosted.length > 0) {
      patches.push((payload) => ({ ...payload, tools: [...asArray(payload.tools), ...hosted] }));
    }
  }
  if (isOpenAI(api)) {
    const details = imageDetailQueues(request);
    if (details.size > 0) patches.push((payload) => payloadWithImageDetails(payload, details));
  }

  if (toolChoice !== undefined) {
    // Bedrock builds its Converse toolConfig from options.toolChoice before
    // onPayload runs, so the choice must ride on options, not a payload patch.
    if (isBedrockApi(api)) options.toolChoice = bedrockToolChoice(toolChoice);
    else patches.push((payload) => ({ ...payload, tool_choice: providerToolChoice(toolChoice, api) }));
  }
  if (request.tools.some((tool) => tool.kind === "function" && (tool.strict !== undefined || isAnthropic(api)))) {
    patches.push((payload) => payloadWithStrictTools(payload, request, api));
  }
  if (responseFormat !== undefined) {
    options.responseFormat = piResponseFormat(responseFormat);
    // Pi keeps responseFormat in options but does not serialize it in simple
    // OpenAI adapters, so patch the provider payload at the boundary.
    patches.push((payload) => payloadWithResponseFormat(payload, responseFormat, api));
  }
  if (parallelToolCalls !== undefined) {
    patches.push((payload) => payloadWithParallelToolCalls(payload, parallelToolCalls, api));
  }

  if (model.fastMode === true) {
    if (model.provider === "openai" && isOpenAI(api) && api !== "azure-openai-responses") {
      // Pi's simple Responses adapter drops serviceTier while lowering its
      // options, so patch the payload too; the option still feeds usage pricing.
      if (api === "openai-responses") options.serviceTier = "priority";
      patches.push((payload) => ({ ...payload, service_tier: "priority" }));
    } else if (model.provider === "anthropic" && isAnthropic(api)) {
      headers["anthropic-beta"] = ANTHROPIC_FAST_MODE_BETA;
      patches.push((payload) => ({ ...payload, speed: "fast" }));
    }
  }

  const reasoning = providerReasoning(request, selectedModel, model, pi, selectedReasoningEffort);
  if (reasoning !== undefined && reasoning !== "off") {
    options.reasoning = reasoning;
  } else if (reasoning === "off" && isCompletions(api) && offRequiresWireNone(selectedModel)) {
    patches.push((payload) => payloadWithReasoningNone(payload, model));
  }
  if (isOpenAIResponsesApi(api)) patches.push(payloadWithDetailedReasoningSummary);

  // Some clients send the default tool_choice even after omitting tools for
  // a turn. OpenAI rejects every tool_choice value when the lowered payload
  // has no tools, so enforce that provider invariant after all tool patches.
  if ((toolChoice !== undefined || parallelToolCalls !== undefined) && !isBedrockApi(api)) {
    patches.push(payloadWithoutOrphanedToolChoice);
  }

  if (Object.keys(headers).length > 0) options.headers = headers;
  if (patches.length > 0) options.onPayload = (payload: unknown) => applyPayloadPatches(payload, patches);
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
}

export function supportedThinkingLevels(model: Model, pi: PiOptionsSupport): string[] {
  const levels = Array.isArray(model.supportedThinkingLevels)
    ? model.supportedThinkingLevels
    : pi.getSupportedThinkingLevels?.(model);
  return Array.isArray(levels) ? levels.filter((level) => typeof level === "string") : ["off"];
}

function providerReasoning(
  request: InteractionRequest,
  selectedModel: string,
  model: Model,
  pi: PiOptionsSupport,
  selectedReasoningEffort: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  const supportedLevels = supportedThinkingLevels(model, pi);
  const defaultReasoningEffort = isReasoningEffort(model.defaultThinkingLevel) ? model.defaultThinkingLevel : undefined;
  const effective = effectiveReasoningForModel({
    request,
    selectedModel,
    supportedLevels,
    selectedReasoningEffort,
    defaultReasoningEffort,
  });
  const baseEffort = request.reasoning?.baseEffort;
  if (baseEffort !== undefined) validateReasoningEffortForModel(baseEffort, selectedModel, supportedLevels);
  return request.reasoning?.hasConfigurationUpdate ? baseEffort ?? defaultReasoningEffort : effective;
}

function authenticationOptions(auth: ResolvedProviderAuth, api: unknown): BedrockOptions | Record<string, unknown> {
  if (auth.type === "bearer") return { apiKey: auth.apiKey };
  if (!isBedrockApi(api)) throw new Error("AWS SigV4 authentication requires the Bedrock API.");
  return {
    env: {
      AWS_ACCESS_KEY_ID: auth.access_key_id,
      AWS_SECRET_ACCESS_KEY: auth.secret_access_key,
      AWS_SESSION_TOKEN: auth.session_token ?? "",
      AWS_REGION: auth.region,
      AWS_DEFAULT_REGION: auth.region,
      AWS_BEARER_TOKEN_BEDROCK: "",
      AWS_PROFILE: "",
    },
  };
}

// Anthropic Messages endpoints outside Anthropic that take the key as a bearer
// token (Claude Code's ANTHROPIC_AUTH_TOKEN) and reject x-api-key.
const BEARER_MESSAGES_PROVIDERS: ReadonlySet<unknown> = new Set(["meta"]);

function sendsBearerToMessages(
  auth: ResolvedProviderAuth,
  model: Model,
): auth is Extract<ResolvedProviderAuth, { type: "bearer" }> {
  return auth.type === "bearer" && isAnthropic(model.api) && BEARER_MESSAGES_PROVIDERS.has(model.provider);
}

function isClaudeCodeOAuth(auth: ResolvedProviderAuth, api: unknown): boolean {
  return auth.type === "bearer" && isAnthropic(api) && auth.apiKey.includes("sk-ant-oat");
}

// Chains patches, preserving the "undefined means unchanged" contract for the
// combined result.
function applyPayloadPatches(payload: unknown, patches: PayloadPatch[]): unknown {
  if (!isRecord(payload)) return undefined;
  let current = payload;
  let changed = false;
  for (const patch of patches) {
    const next = patch(current);
    if (isRecord(next)) {
      current = next;
      changed = true;
    }
  }
  return changed ? current : undefined;
}

function asRecord(value: unknown): Payload {
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function payloadWithSamplingControls(payload: Payload, request: InteractionRequest, api: unknown): Payload {
  const { topP, stop } = request.generation;
  const camelCase = isGoogle(api) || isBedrockApi(api);
  const controls: Payload = {};
  // Anthropic rejects top_p with thinking; keep the hosted path aligned with
  // the router's unsupported Anthropic top_p control.
  if (topP !== undefined && !isAnthropic(api)) controls[camelCase ? "topP" : "top_p"] = topP;
  if (stop !== undefined && !isOpenAIResponsesApi(api)) {
    const key = camelCase ? "stopSequences" : isAnthropic(api) ? "stop_sequences" : "stop";
    controls[key] = isCompletions(api) || typeof stop !== "string" ? stop : [stop];
  }
  if (isGoogle(api)) return { ...payload, config: { ...asRecord(payload.config), ...controls } };
  if (isBedrockApi(api)) return { ...payload, inferenceConfig: { ...asRecord(payload.inferenceConfig), ...controls } };
  return { ...payload, ...controls };
}

// Pi sends `thinking.block_binding: {prefix_mismatch_behavior: "drop_block"}`
// plus the binding-controls beta on mid-conversation-effort models (Fable 5.1,
// Opus 5). That opts every request into the preserved-thinking prefix check:
// when a replayed thinking block's recorded prefix no longer matches (client
// re-render, retry, or provider refusal in the loop), the API silently drops
// the block, which mutates the prompt bytes from that block onward and
// re-writes the rest of the conversation at cache-write prices. On
// organizations not yet enforced (created before 2026-08-31), opting out keeps
// the prefix stable and the cache warm; the API records the mismatch without
// acting on it.
function payloadWithoutThinkingBlockBinding(payload: Payload): Payload | undefined {
  const thinking = payload.thinking;
  if (!isRecord(thinking) || !isRecord(thinking.block_binding)) return undefined;
  const { block_binding: _, ...rest } = thinking;
  const betas = Array.isArray(payload.betas)
    ? payload.betas.filter((beta) => beta !== ANTHROPIC_BINDING_CONTROLS_BETA)
    : payload.betas;
  return { ...payload, thinking: rest, betas };
}

// These models need explicit "none" rather than the provider default.
// Gateways use nested reasoning; direct providers use reasoning_effort.
function payloadWithReasoningNone(payload: Payload, model: Model): Payload {
  if (!gatewayFor(model.provider)) return { ...payload, reasoning_effort: "none" };
  const { reasoning_effort: _, ...rest } = payload;
  return { ...rest, reasoning: { ...asRecord(payload.reasoning), effort: "none" } };
}

// Pi's default "auto" summary leaves many reasoning items empty (93% on the
// ChatGPT Codex backend). Readable summaries are the only reasoning a later
// turn on another provider can replay, so ask for detailed ones.
function payloadWithDetailedReasoningSummary(payload: Payload): Payload | undefined {
  if (!isRecord(payload.reasoning) || payload.reasoning.summary === undefined) return undefined;
  return { ...payload, reasoning: { ...payload.reasoning, summary: "detailed" } };
}

function piResponseFormat(format: InteractionResponseFormat): Payload {
  if (format.type !== "json_schema") return format;
  const { type: _, ...jsonSchema } = format;
  return { type: "json_schema", jsonSchema };
}

function payloadWithResponseFormat(payload: Payload, format: InteractionResponseFormat, api: unknown): unknown {
  if (format.type === "text") return undefined;
  if (isAnthropic(api)) {
    const schema = format.type === "json_schema" ? format.schema : { type: "object" };
    return { ...payload, output_config: { ...asRecord(payload.output_config), format: { type: "json_schema", schema } } };
  }
  if (format.type === "json_object") {
    if (isResponses(api)) return { ...payload, text: { ...asRecord(payload.text), format } };
    if (isCompletions(api)) return { ...payload, response_format: format };
    return undefined;
  }
  const { type: _, ...jsonSchema } = format;
  if (isResponses(api)) return { ...payload, text: { ...asRecord(payload.text), format: { ...jsonSchema, type: "json_schema" } } };
  if (isCompletions(api)) return { ...payload, response_format: { type: "json_schema", json_schema: jsonSchema } };
  return undefined;
}

function bedrockToolChoice(choice: InteractionToolChoice): unknown {
  if (typeof choice === "string") return choice;
  if (choice.kind === "hosted") return undefined;
  return { type: "function", function: { name: toolWireName(choice.namespace, choice.name) } };
}

function providerToolChoice(choice: InteractionToolChoice, api: unknown): unknown {
  if (typeof choice === "string") {
    if (isAnthropic(api)) return { type: choice === "required" ? "any" : choice };
    return choice === "any" ? "required" : choice;
  }
  if (choice.kind === "hosted") return { type: choice.type };
  const name = toolWireName(choice.namespace, choice.name);
  if (isAnthropic(api)) return { type: "tool", name };
  // Pi currently declares both interaction tool kinds as JSON function tools.
  if (isResponses(api)) return { type: "function", name };
  return { type: "function", function: { name } };
}

function payloadWithoutOrphanedToolChoice(payload: Payload): Payload | undefined {
  if (!("tool_choice" in payload) || asArray(payload.tools).length > 0) return undefined;
  const { tool_choice: _, ...rest } = payload;
  return rest;
}

function payloadWithStrictTools(payload: Payload, request: Pick<InteractionRequest, "tools">, api: unknown): unknown {
  if (!Array.isArray(payload.tools) || !(isOpenAI(api) || isAnthropic(api))) return undefined;
  const definitions = toolsByWireName(request.tools);
  const functionTool = (name: unknown) => {
    const tool = typeof name === "string" ? definitions.get(name) : undefined;
    return tool?.kind === "function" ? tool : undefined;
  };
  const tools = payload.tools.map((entry) => {
    if (!isRecord(entry)) return entry;
    if (isAnthropic(api)) {
      const tool = functionTool(entry.name);
      if (!tool) return entry;
      // defer_loading is intentionally not restored from the definition: Pi
      // decides placement (deferred batch vs force-loaded immediate), and
      // re-adding it here would recreate the cache_control/defer_loading
      // combination Anthropic rejects. The entry spread preserves Pi's choice.
      return {
        ...entry,
        ...(tool.parameters !== undefined ? { input_schema: tool.parameters } : {}),
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      };
    }
    if (isCompletions(api) && isRecord(entry.function)) {
      const strict = functionTool(entry.function.name)?.strict;
      return strict === undefined ? entry : { ...entry, function: { ...entry.function, strict } };
    }
    const strict = functionTool(entry.name)?.strict;
    return strict === undefined ? entry : { ...entry, strict };
  });
  return { ...payload, tools };
}

function payloadWithParallelToolCalls(payload: Payload, enabled: boolean, api: unknown): unknown {
  if (isOpenAI(api)) return { ...payload, parallel_tool_calls: enabled };
  if (!isAnthropic(api) || enabled) return undefined;
  const current = asRecord(payload.tool_choice);
  if (current.type === "none") return undefined;
  return { ...payload, tool_choice: { type: "auto", ...current, disable_parallel_tool_use: true } };
}

// Fills `detail` on Responses (`input_image`) and Chat (`image_url`) parts,
// matching request images to payload images by URL in order.
function payloadWithImageDetails(payload: Payload, details: Map<string, ImageDetail[]>): unknown {
  const queues = new Map([...details].map(([url, queue]) => [url, [...queue]]));
  let changed = false;
  const patch = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(patch);
    if (!isRecord(value)) return value;
    const node = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, patch(entry)]));
    if (node.type === "input_image" && typeof node.image_url === "string") {
      const detail = queues.get(node.image_url)?.shift();
      if (detail === undefined) return node;
      changed = true;
      return { ...node, detail };
    }
    if (node.type === "image_url" && isRecord(node.image_url) && typeof node.image_url.url === "string") {
      const detail = queues.get(node.image_url.url)?.shift();
      if (detail === undefined) return node;
      changed = true;
      return { ...node, image_url: { ...node.image_url, detail } };
    }
    return node;
  };
  const patched = patch(payload);
  return changed ? patched : undefined;
}

function imageDetailQueues(request: InteractionRequest): Map<string, ImageDetail[]> {
  const details = new Map<string, ImageDetail[]>();
  for (const item of request.items) {
    const content = item.type === "message" ? item.content : item.type === "tool_result" ? item.output : undefined;
    for (const part of asArray(content)) {
      if (!isRecord(part) || part.type !== "image" || typeof part.url !== "string") continue;
      if (!IMAGE_DETAILS.includes(part.detail)) continue;
      details.set(part.url, [...(details.get(part.url) ?? []), part.detail as ImageDetail]);
    }
  }
  return details;
}
