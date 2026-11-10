import { createHash } from "node:crypto";

import { stableStringify } from "@mupt-ai/dari-router/policy-engine";

import { anthropicMessagesToInteraction } from "../protocol/input/anthropic_messages.js";
import { internalChatCompletionsToInteraction } from "../protocol/input/chat_completions.js";
import { anthropicContent } from "../protocol/output/anthropic_messages_output.js";
import { assistantMessagePayload } from "../protocol/output/chat_completions.js";
import { compatibleProviderContinuation } from "../interaction/provider_continuation_state.js";
import type {
  InteractionItem,
  InteractionOutput,
  InteractionRequest,
  ProviderContinuationState,
  ProviderIdentity,
} from "../interaction/types.js";
import { providerToolCallId, toolWireName } from "../interaction/tool_identity.js";
import { ROUTING_PREFIX_HASHES_MAX_COUNT } from "../platform/routing_contract.js";
import {
  appendFingerprintContentText,
  canonicalInteractionFingerprintStep,
  interactionFingerprintContent,
  interactionFingerprintHeadHash,
  interactionOptionsFingerprints,
  normalizedAssistantFingerprintContent,
  type InteractionFingerprintStep,
  type ReasoningFingerprint,
} from "./interaction_fingerprint_format.js";

const MAX_CONTINUATION_TARGETS = 16;

type FingerprintPolicy = {
  includeItemIds: boolean;
  includePhase: boolean;
  canonicalizeFunctionArguments: boolean;
  // Loose tier: exclude everything clients may legitimately drop or rewrite
  // (reasoning payloads, item ids, phases) and normalize the rest, so the
  // hash survives echo mutation. Identity-only — never used for warmth.
  loose?: boolean;
};

// The loose tier ignores reasoning and item ids, so provider identity and
// tool-call-id composition cannot influence it: one chain per request.
const LOOSE_POLICY: FingerprintPolicy = {
  includeItemIds: false,
  includePhase: false,
  canonicalizeFunctionArguments: true,
  loose: true,
};

// Salts the loose chain's seed so the two hash tiers can never collide in
// the shared prefix-entry lookup space.
const LOOSE_SEED_SALT = "fp-loose-1";
const CONVERSATION_PREFIX_VERSION = "conversation-prefix-v1";

export type InteractionPrefixContext = {
  chainByModel: ReadonlyMap<string, string[]>;
  itemIndexByHashByModel: ReadonlyMap<string, ReadonlyMap<string, number>>;
  // Client-durable chain for conversation identity, target-independent.
  looseChain: string[];
  fingerprints: { tool_choice_fp: string; response_format_fp: string };
};

/**
 * Hash variants sent during router resolution. The portable chain covers
 * providers that receive readable history only. Exact continuation-source
 * variants cover a return to the originating model. Because provider APIs
 * are unknown before resolution, Responses tool history also contributes a
 * composite call/item-ID variant for OpenAI-compatible Responses targets.
 */
export function interactionPrefixLookupHashes(routerId: string, request: InteractionRequest): string[] {
  const targets: Array<ProviderIdentity | null> = [null];
  const seen = new Set<string>();

  for (let index = request.items.length - 1; index >= 0 && seen.size < MAX_CONTINUATION_TARGETS; index -= 1) {
    const item = request.items[index];
    if (item.type !== "reasoning" || !item.continuation) continue;
    const key = identityKey(item.continuation.source);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(item.continuation.source);
  }

  const chains = targets.map((target) => interactionPrefixChain(routerId, request, target));
  if (request.sourceProtocol === "openai_responses") {
    chains.push(interactionPrefixChainFor(routerId, request, null, "openai-responses"));
  }
  chains.push(interactionLooseChain(routerId, request));
  return deepestDistinctHashes(chains, ROUTING_PREFIX_HASHES_MAX_COUNT);
}

// The loose (client-durable) chain: what the conversation looks like once
// reasoning payloads, item ids, and provider-specific canonicalization are
// stripped. Distinct seed keeps its hashes disjoint from the strict tier.
export function interactionLooseChain(routerId: string, request: InteractionRequest): string[] {
  return fingerprintChain(
    sha256(`${interactionFingerprintHeadHash(routerId, request)}\u0000${LOOSE_SEED_SALT}`),
    looseFingerprintSteps(request.sourceProtocol, request.items),
  );
}

// Stable logical-conversation discriminator. This deliberately excludes the
// cache head (instructions and tools) and hashes only the first normalized
// transcript step. Growing history and tool changes preserve identity, while
// unrelated work reusing the same harness session gets a new group.
export function interactionConversationPrefix(request: InteractionRequest): string {
  const firstStep = conversationFingerprintSteps(
    looseFingerprintSteps(
      request.sourceProtocol,
      request.items.filter((item) => !isOpenClawRuntimeContext(item)),
    ),
  ).at(0);
  return sha256(stableStringify({
    version: CONVERSATION_PREFIX_VERSION,
    firstStep: firstStep === undefined
      ? null
      : canonicalInteractionFingerprintStep(firstStep),
  }));
}

// OpenClaw appends a user message of runtime context (active exec sessions,
// subagents) to each request and drops it from later history. On a first
// turn it merges into the first transcript step, so leaving it in would give
// the first turn a different conversation than the turns after it.
const OPENCLAW_RUNTIME_CONTEXT = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";

function isOpenClawRuntimeContext(item: InteractionItem): boolean {
  return item.type === "message" && item.role === "user" && item.content.length > 0 &&
    item.content.every((part) => part.type === "text" && part.text.trimStart().startsWith(OPENCLAW_RUNTIME_CONTEXT));
}

export function interactionPrefixContext(
  routerId: string,
  request: InteractionRequest,
  targets: ReadonlyMap<string, ProviderIdentity>
): InteractionPrefixContext {
  const chainByModel = new Map<string, string[]>();
  const itemIndexByHashByModel = new Map<string, ReadonlyMap<string, number>>();
  for (const [model, target] of targets) {
    const steps = interactionPrefixStepsFor(routerId, request, target, target.api);
    chainByModel.set(model, steps.map((step) => step.hash));
    itemIndexByHashByModel.set(
      model,
      new Map(steps.map((step) => [step.hash, step.itemIndex])),
    );
  }
  return {
    chainByModel,
    itemIndexByHashByModel,
    looseChain: interactionLooseChain(routerId, request),
    fingerprints: interactionOptionsFingerprints(request),
  };
}

// Loose fingerprints share the strict grouping logic so step boundaries
// stay identical whether or not the client echoed reasoning; the policy just
// drops the volatile fields. Target-independent by construction.
function looseFingerprintSteps(
  sourceProtocol: InteractionRequest["sourceProtocol"],
  items: ReadonlyArray<InteractionItem>,
): InteractionFingerprintStep[] {
  return sourceProtocol === "openai_chat"
    ? fingerprintChatInputSteps(items, null, null, LOOSE_POLICY)
    : fingerprintSteps(items, null, null, LOOSE_POLICY);
}

export function interactionPrefixChain(
  routerId: string,
  request: InteractionRequest,
  target: ProviderIdentity | null
): string[] {
  return interactionPrefixStepsFor(routerId, request, target, target?.api ?? null)
    .map((step) => step.hash);
}

function interactionPrefixChainFor(
  routerId: string,
  request: InteractionRequest,
  target: ProviderIdentity | null,
  toolCallApi: string | null
): string[] {
  return interactionPrefixStepsFor(routerId, request, target, toolCallApi)
    .map((step) => step.hash);
}

function interactionPrefixStepsFor(
  routerId: string,
  request: InteractionRequest,
  target: ProviderIdentity | null,
  toolCallApi: string | null,
): Array<{ hash: string; itemIndex: number }> {
  let hash = interactionFingerprintHeadHash(routerId, request);
  const steps: Array<{ hash: string; itemIndex: number }> = [];
  const responses = request.sourceProtocol === "openai_responses";
  const fingerprintStepsForRequest = conversationFingerprintSteps(
    request.sourceProtocol === "openai_chat"
      ? fingerprintChatInputSteps(request.items, target, toolCallApi)
      : fingerprintSteps(request.items, target, toolCallApi, {
          includeItemIds: true,
          includePhase: responses,
          canonicalizeFunctionArguments: responses,
        }),
  );
  for (const step of fingerprintStepsForRequest) {
    hash = extendFingerprintHash(hash, step);
    steps.push({ hash, itemIndex: step.itemIndex });
  }
  return steps;
}

export function extendInteractionChain(
  lastHash: string,
  output: InteractionOutput,
  target: ProviderIdentity,
  policy: {
    includeItemIds: boolean;
    sourceProtocol: InteractionRequest["sourceProtocol"];
  }
): string[] {
  let hash = lastHash;
  const extension: string[] = [];
  const steps = fingerprintClientEchoSteps(output, target, policy);
  for (const step of steps) {
    if (step.actor === "system" || step.actor === "developer") continue;
    hash = extendFingerprintHash(hash, step);
    extension.push(hash);
  }
  return extension;
}

function fingerprintClientEchoSteps(
  output: InteractionOutput,
  target: ProviderIdentity,
  policy: {
    includeItemIds: boolean;
    sourceProtocol: InteractionRequest["sourceProtocol"];
  },
): InteractionFingerprintStep[] {
  const items = clientEchoItems(output, policy.sourceProtocol);
  if (policy.sourceProtocol === "openai_chat") {
    return fingerprintChatInputSteps(items, target, target.api);
  }
  return fingerprintSteps(items, target, target.api, {
    includeItemIds: policy.includeItemIds,
    includePhase: policy.sourceProtocol === "openai_responses",
    canonicalizeFunctionArguments: true,
  });
}

// Prefix extensions must match the assistant output as the next client request
// will carry it, not necessarily the provider's canonical output items.
function clientEchoItems(
  output: InteractionOutput,
  sourceProtocol: InteractionRequest["sourceProtocol"],
): InteractionItem[] {
  if (sourceProtocol === "openai_chat") {
    return internalChatCompletionsToInteraction({
      model: "dari/routing",
      messages: [assistantMessagePayload(output)],
    }).items;
  }
  if (sourceProtocol === "anthropic_messages") {
    return anthropicMessagesToInteraction({
      model: "dari/routing",
      max_tokens: 1,
      messages: [{ role: "assistant", content: anthropicContent(output) }],
    }).items;
  }
  return output.items;
}

// Loose-tier extension for the reply, mirroring interactionLooseChain's
// policy: what the next request's loose chain computes at this depth no
// matter which volatile fields the client's echo keeps.
export function extendInteractionLooseChain(
  lastHash: string,
  output: InteractionOutput,
  sourceProtocol: InteractionRequest["sourceProtocol"],
): string[] {
  let hash = lastHash;
  const extension: string[] = [];
  const items = clientEchoItems(output, sourceProtocol);
  for (const step of looseFingerprintSteps(sourceProtocol, items)) {
    if (step.actor === "system" || step.actor === "developer") continue;
    hash = extendFingerprintHash(hash, step);
    extension.push(hash);
  }
  return extension;
}

// Chat carries reasoning, assistant text, and tool calls in one assistant
// message. Its canonical interaction items intentionally separate those
// concerns, so prefix hashing must regroup one wire message before hashing.
function fingerprintChatInputSteps(
  items: ReadonlyArray<InteractionItem>,
  target: ProviderIdentity | null,
  toolCallApi: string | null,
  policy?: FingerprintPolicy,
): InteractionFingerprintStep[] {
  const steps: InteractionFingerprintStep[] = [];
  const toolCalls = new Map<string, string>();
  let pendingReasoning: ReasoningFingerprint[] = [];
  let pendingReasoningItemIndex = -1;

  const flushReasoning = () => {
    if (pendingReasoning.length === 0) return;
    steps.push({
      actor: "assistant",
      itemIndex: pendingReasoningItemIndex,
      content: null,
      calls: [],
      resultCallId: null,
      reasoning: pendingReasoning,
    });
    pendingReasoning = [];
    pendingReasoningItemIndex = -1;
  };

  for (const [itemIndex, item] of items.entries()) {
    if (item.type === "reasoning") {
      if (policy?.loose) continue;
      pendingReasoning.push(reasoningFingerprint(item, target, false));
      pendingReasoningItemIndex = itemIndex;
      continue;
    }
    if (item.type === "message") {
      if (item.role !== "assistant") flushReasoning();
      steps.push({
        actor: item.role,
        itemIndex,
        content: item.role === "assistant"
          ? normalizedAssistantFingerprintContent(item.content, item.contentShape)
          : interactionFingerprintContent(item.content, item.contentShape),
        calls: [],
        resultCallId: null,
        ...(item.role === "assistant" && pendingReasoning.length > 0
          ? { reasoning: pendingReasoning }
          : {}),
      });
      pendingReasoning = [];
      pendingReasoningItemIndex = -1;
      continue;
    }
    if (item.type === "reasoning_configuration") {
      // Configuration updates change execution effort without becoming part
      // of the conversational identity, just like request-level effort.
      flushReasoning();
      continue;
    }
    if (item.type === "tool_result") {
      flushReasoning();
      steps.push({
        actor: "tool",
        itemIndex,
        content: interactionFingerprintContent(item.output, item.outputShape),
        calls: [],
        resultCallId: toolCalls.get(item.callId) ?? item.callId,
      });
      continue;
    }

    flushReasoning();
    let assistant = steps.at(-1);
    if (!assistant || assistant.actor !== "assistant") {
      assistant = {
        actor: "assistant",
        content: null,
        calls: [],
        resultCallId: null,
        itemIndex,
      };
      steps.push(assistant);
    }
    assistant.itemIndex = itemIndex;
    if (item.type === "tool_call") {
      const id = appendToolCall(
        assistant,
        item,
        toolCallApi,
        false,
        policy?.canonicalizeFunctionArguments ?? false,
      );
      toolCalls.set(item.callId, id);
    } else {
      appendHostedToolCall(assistant, item);
    }
  }
  flushReasoning();
  return steps;
}

function fingerprintSteps(
  items: ReadonlyArray<InteractionItem>,
  target: ProviderIdentity | null,
  toolCallApi: string | null,
  policy: FingerprintPolicy
): InteractionFingerprintStep[] {
  const steps: InteractionFingerprintStep[] = [];
  const toolCalls = new Map<string, string>();

  for (const [itemIndex, item] of items.entries()) {
    if (item.type === "reasoning") {
      if (policy.loose) continue;
      const continuation = compatibleProviderContinuation(item.continuation, target);
      const readable = continuationReadableText(item, continuation);
      const itemFingerprint = reasoningFingerprint(item, target, policy.includeItemIds);
      const previous = steps.at(-1);
      if (
        previous?.actor === "assistant"
        && (previous.calls.length > 0 || previous.reasoning?.length)
      ) {
        previous.itemIndex = itemIndex;
        previous.content = appendFingerprintContentText(previous.content, readable);
        previous.reasoning = [...(previous.reasoning ?? []), itemFingerprint];
        continue;
      }
      steps.push({
        actor: "assistant",
        itemIndex,
        content: readable || null,
        calls: [],
        resultCallId: null,
        reasoning: [itemFingerprint],
      });
      continue;
    }
    if (item.type === "reasoning_configuration") {
      continue;
    }
    if (item.type === "tool_result") {
      steps.push({
        actor: "tool",
        itemIndex,
        content: interactionFingerprintContent(item.output, item.outputShape),
        calls: [],
        resultCallId: toolCalls.get(item.callId) ?? item.callId,
      });
      continue;
    }
    if (item.type === "tool_call") {
      let assistant = steps.at(-1);
      if (!assistant || assistant.actor !== "assistant") {
        assistant = {
          actor: "assistant",
          content: null,
          calls: [],
          resultCallId: null,
          itemIndex,
        };
        steps.push(assistant);
      }
      assistant.itemIndex = itemIndex;
      const id = appendToolCall(
        assistant,
        item,
        toolCallApi,
        policy.includeItemIds,
        policy.canonicalizeFunctionArguments,
      );
      toolCalls.set(item.callId, id);
      continue;
    }
    if (item.type === "hosted_tool_call") {
      let assistant = steps.at(-1);
      if (!assistant || assistant.actor !== "assistant") {
        assistant = {
          actor: "assistant",
          content: null,
          calls: [],
          resultCallId: null,
          itemIndex,
        };
        steps.push(assistant);
      }
      assistant.itemIndex = itemIndex;
      appendHostedToolCall(assistant, item);
      continue;
    }
    steps.push({
      actor: item.role,
      itemIndex,
      content: policy.loose && item.role === "assistant"
        ? normalizedAssistantFingerprintContent(item.content, item.contentShape)
        : interactionFingerprintContent(item.content, item.contentShape),
      calls: [],
      resultCallId: null,
      ...(policy.includeItemIds && item.id ? { itemId: item.id } : {}),
      ...(policy.includePhase && item.phase ? { phase: item.phase } : {}),
    });
  }
  return steps;
}

function reasoningFingerprint(
  item: Extract<InteractionItem, { type: "reasoning" }>,
  target: ProviderIdentity | null,
  includeItemId: boolean,
): ReasoningFingerprint {
  const continuation = compatibleProviderContinuation(item.continuation, target);
  const readable = continuationReadableText(item, continuation);
  return {
    ...(includeItemId && item.id ? { itemId: item.id } : {}),
    readableSha256: sha256(readable),
    ...(continuation
      ? { continuationStateSha256: sha256(stableStringify(continuation)) }
      : {}),
  };
}

function appendToolCall(
  assistant: InteractionFingerprintStep,
  item: Extract<InteractionItem, { type: "tool_call" }>,
  toolCallApi: string | null,
  includeItemId: boolean,
  canonicalizeFunctionArguments: boolean,
): string {
  const id = providerToolCallId(
    item.callId,
    includeItemId ? item.id : undefined,
    toolCallApi,
  );
  assistant.calls = [
    ...assistant.calls,
    {
      id,
      kind: item.kind,
      name: toolWireName(item.namespace, item.name),
      input: toolArguments(
        item.kind,
        item.input,
        canonicalizeFunctionArguments,
      ),
    },
  ];
  return id;
}

function appendHostedToolCall(
  assistant: InteractionFingerprintStep,
  item: Extract<InteractionItem, { type: "hosted_tool_call" }>,
): void {
  const payload: Record<string, unknown> = {
    ...item.payload,
    type: item.providerType,
    id: item.id,
  };
  if (item.status) payload.status = item.status;
  else delete payload.status;
  assistant.calls = [
    ...assistant.calls,
    {
      id: item.id,
      kind: "hosted",
      name: item.tool,
      input: payload,
    },
  ];
}

function continuationReadableText(
  item: Extract<InteractionItem, { type: "reasoning" }>,
  continuation: ProviderContinuationState | null
): string {
  if (continuation?.kind === "anthropic_thinking") return normalizedReadable(continuation.thinking);
  if (continuation?.kind === "anthropic_redacted_thinking") return "";
  return normalizedReadable([...item.summary, ...item.content].join("\n"));
}

// Streamed reasoning reaches clients as delta concatenations whose whitespace
// joins differ from the aggregated response body (part separators, trailing
// newlines), and the client echoes whichever form it saw. Whitespace therefore
// cannot participate in conversation identity.
function normalizedReadable(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function fingerprintChain(
  seed: string,
  steps: ReadonlyArray<InteractionFingerprintStep>,
): string[] {
  let hash = seed;
  return conversationFingerprintSteps(steps).map((step) => {
    hash = extendFingerprintHash(hash, step);
    return hash;
  });
}

function conversationFingerprintSteps(
  steps: ReadonlyArray<InteractionFingerprintStep>,
): InteractionFingerprintStep[] {
  const positional: InteractionFingerprintStep[] = [];
  let sawConversationStep = false;
  for (const step of steps) {
    if (step.actor !== "system" && step.actor !== "developer") {
      sawConversationStep = true;
      const previous = positional.at(-1);
      if (step.actor === "user" && previous?.actor === "user") {
        previous.content = appendPositionalFingerprintContent(previous.content, step.content);
        previous.itemIndex = step.itemIndex;
      } else {
        positional.push({ ...step });
      }
      continue;
    }
    if (!sawConversationStep) continue;

    const text = fingerprintReadableText(step.content);
    if (!text) continue;
    const previous = positional.at(-1);
    if (previous?.actor === "user" || previous?.actor === "tool") {
      previous.content = appendPositionalFingerprintText(previous.content, text);
      previous.itemIndex = step.itemIndex;
      continue;
    }
    positional.push({
      actor: "user",
      content: [{ type: "text", text }],
      calls: [],
      resultCallId: null,
      itemIndex: step.itemIndex,
    });
  }
  return positional;
}

function fingerprintReadableText(content: InteractionFingerprintStep["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part.type === "text" ? part.text : "(image omitted)").join("\n");
}

function appendPositionalFingerprintText(
  content: InteractionFingerprintStep["content"],
  text: string,
): InteractionFingerprintStep["content"] {
  return appendPositionalFingerprintContent(content, [{ type: "text", text }]);
}

function appendPositionalFingerprintContent(
  content: InteractionFingerprintStep["content"],
  appended: InteractionFingerprintStep["content"],
): InteractionFingerprintStep["content"] {
  const contentParts = typeof content === "string"
    ? [{ type: "text" as const, text: content }]
    : content ?? [];
  const appendedParts = typeof appended === "string"
    ? [{ type: "text" as const, text: appended }]
    : appended ?? [];
  return [...contentParts, ...appendedParts];
}

function extendFingerprintHash(
  lastHash: string,
  step: InteractionFingerprintStep,
): string {
  return sha256(
    `${lastHash}\u0000${canonicalInteractionFingerprintStep(step)}`,
  );
}

function toolArguments(
  kind: "function" | "custom",
  input: string | Record<string, unknown> | undefined,
  canonicalizeFunctionArguments: boolean
): unknown {
  if (kind === "custom") return JSON.stringify({ input: typeof input === "string" ? input : "" });
  if (canonicalizeFunctionArguments && typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Provider execution reports malformed function arguments separately;
      // fingerprinting itself must remain best-effort.
    }
  }
  return input;
}

function deepestDistinctHashes(chains: string[][], max: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (let depth = 1; result.length < max; depth += 1) {
    let found = false;
    for (const chain of chains) {
      const hash = chain.at(-depth);
      if (!hash) continue;
      found = true;
      if (!seen.has(hash)) {
        seen.add(hash);
        result.push(hash);
        if (result.length === max) break;
      }
    }
    if (!found) break;
  }
  return result;
}

function identityKey(identity: ProviderIdentity): string {
  return `${identity.provider}\u0000${identity.api}\u0000${identity.model}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
