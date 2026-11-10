import { RouterFrameworkError } from "./framework_error.js";
import { isRecord } from "./types.js";

export type ProviderIdentity = {
  provider: string;
  api: string;
  model: string;
};

export type ProviderContinuationState =
  | {
      kind: "openai_reasoning";
      source: ProviderIdentity;
      encryptedContent: string;
      providerItemId?: string;
      hostedToolCallIds?: string[];
      hostedToolCallOffsets?: number[];
    }
  | {
      kind: "anthropic_thinking";
      source: ProviderIdentity;
      thinking: string;
      signature: string;
      effort?: AnthropicEffort;
    }
  | {
      kind: "anthropic_redacted_thinking";
      source: ProviderIdentity;
      data: string;
      effort?: AnthropicEffort;
    };

/**
 * The effort a managed-effort Claude model generated the block under. Those
 * models bind each thinking block to its request prefix, which included an
 * effort marker right before the turn; replay must restore that marker or the
 * API drops the block and the model loses its reasoning.
 */
export type AnthropicEffort = (typeof ANTHROPIC_EFFORTS)[number];

const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function isAnthropicEffort(value: unknown): value is AnthropicEffort {
  return ANTHROPIC_EFFORTS.includes(value as AnthropicEffort);
}

/** @deprecated Alias kept for the framework-prefixed vocabulary; use {@link ProviderIdentity}. */
export type RouterProviderIdentity = ProviderIdentity;
/** @deprecated Alias kept for the framework-prefixed vocabulary; use {@link ProviderContinuationState}. */
export type RouterContinuationState = ProviderContinuationState;

const PREFIX = "dari-pcs-v1.";
const FAMILY_PREFIX = "dari-pcs-";
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ENCODED_CHARS = Math.ceil(MAX_JSON_BYTES / 3) * 4;
const MAX_PROVIDER_LENGTH = 128;
const MAX_API_LENGTH = 128;
const MAX_MODEL_LENGTH = 512;
const MAX_ITEM_ID_LENGTH = 512;
const MAX_HOSTED_TOOL_CALL_IDS = 256;
const MAX_HOSTED_TOOL_CALL_OFFSET = 1_000_000;

type EnvelopeV1 = {
  v: 1;
  kind: ProviderContinuationState["kind"];
  source: ProviderIdentity;
  state: Record<string, string>;
};

export function encodeProviderContinuationState(value: ProviderContinuationState): string {
  const envelope = envelopeFor(value);
  validateEnvelope(envelope, "configuration");
  const json = JSON.stringify(envelope);
  if (Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES) {
    throw invalidState(
      "configuration",
      "Provider continuation state exceeds the encoded size limit.",
    );
  }
  return `${PREFIX}${Buffer.from(json, "utf8").toString("base64url")}`;
}

export function decodeUntrustedProviderContinuationState(
  value: string,
): ProviderContinuationState | null {
  if (!value.startsWith(FAMILY_PREFIX)) return null;
  if (!value.startsWith(PREFIX)) {
    throw invalidState("invalid_request", "Provider continuation state version is not supported.");
  }

  const encoded = value.slice(PREFIX.length);
  if (!encoded || encoded.length > MAX_ENCODED_CHARS || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw invalidState("invalid_request", "Provider continuation state encoding is invalid.");
  }

  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length > MAX_JSON_BYTES || bytes.toString("base64url") !== encoded) {
    throw invalidState("invalid_request", "Provider continuation state encoding is invalid.");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalidState("invalid_request", "Provider continuation state payload is invalid.");
  }
  return stateFromEnvelope(validateEnvelope(decoded, "invalid_request"));
}

export function isOpenAIResponsesApi(api: string): boolean {
  return api === "openai-responses" || api === "azure-openai-responses";
}

// OpenAI reasoning continuations also replay on the ChatGPT-subscription Codex
// Responses transport, which returns the same encrypted reasoning items.
export function isOpenAIReasoningContinuationApi(api: string): boolean {
  return isOpenAIResponsesApi(api) || api === "openai-codex-responses";
}

export function compatibleProviderContinuation(
  continuation: ProviderContinuationState | undefined,
  target: ProviderIdentity | null,
): ProviderContinuationState | null {
  if (!continuation || !target || !sameProviderIdentity(continuation.source, target)) return null;
  if (continuation.kind === "openai_reasoning") {
    return isOpenAIReasoningContinuationApi(target.api) ? continuation : null;
  }
  // Anthropic thinking signatures also round-trip through Bedrock's Converse
  // Stream transport (Claude on Bedrock rejects replayed thinking without its
  // signature). sameProviderIdentity above already pins source === target, so
  // this never crosses a Bedrock continuation into the Anthropic API or back.
  return target.api === "anthropic-messages" || target.api === "bedrock-converse-stream"
    ? continuation
    : null;
}

export function sameProviderIdentity(a: ProviderIdentity, b: ProviderIdentity): boolean {
  return a.provider === b.provider && a.api === b.api && a.model === b.model;
}

export function providerIdentityFromModel(model: {
  provider?: unknown;
  api?: unknown;
  id?: unknown;
}): ProviderIdentity {
  if (typeof model.provider !== "string" || typeof model.api !== "string" || typeof model.id !== "string") {
    throw new RouterFrameworkError(
      "configuration",
      "Selected model metadata is missing provider identity.",
      "provider_configuration_error",
    );
  }
  return { provider: model.provider, api: model.api, model: model.id };
}

function envelopeFor(value: ProviderContinuationState): EnvelopeV1 {
  if (value.kind === "openai_reasoning") {
    return {
      v: 1,
      kind: value.kind,
      source: value.source,
      state: {
        encrypted_content: value.encryptedContent,
        ...(value.providerItemId ? { item_id: value.providerItemId } : {}),
        ...(value.hostedToolCallIds?.length
          ? { hosted_tool_call_ids: JSON.stringify(value.hostedToolCallIds) }
          : {}),
        ...(value.hostedToolCallOffsets?.length
          ? { hosted_tool_call_offsets: JSON.stringify(value.hostedToolCallOffsets) }
          : {}),
      },
    };
  }
  if (value.kind === "anthropic_thinking") {
    return {
      v: 1,
      kind: value.kind,
      source: value.source,
      state: {
        thinking: value.thinking,
        signature: value.signature,
        ...(value.effort ? { effort: value.effort } : {}),
      },
    };
  }
  return {
    v: 1,
    kind: value.kind,
    source: value.source,
    state: { data: value.data, ...(value.effort ? { effort: value.effort } : {}) },
  };
}

function stateFromEnvelope(envelope: EnvelopeV1): ProviderContinuationState {
  if (envelope.kind === "openai_reasoning") {
    return {
      kind: envelope.kind,
      source: envelope.source,
      encryptedContent: envelope.state.encrypted_content,
      ...(envelope.state.item_id ? { providerItemId: envelope.state.item_id } : {}),
      ...(envelope.state.hosted_tool_call_ids
        ? {
            hostedToolCallIds: hostedToolCallIds(
              envelope.state.hosted_tool_call_ids,
              "invalid_request",
            ),
            ...(envelope.state.hosted_tool_call_offsets
              ? {
                  hostedToolCallOffsets: hostedToolCallOffsets(
                    envelope.state.hosted_tool_call_offsets,
                    "invalid_request",
                  ),
                }
              : {}),
          }
        : {}),
    };
  }
  if (envelope.kind === "anthropic_thinking") {
    return {
      kind: envelope.kind,
      source: envelope.source,
      thinking: envelope.state.thinking,
      signature: envelope.state.signature,
      ...(isAnthropicEffort(envelope.state.effort) ? { effort: envelope.state.effort } : {}),
    };
  }
  return {
    kind: envelope.kind,
    source: envelope.source,
    data: envelope.state.data,
    ...(isAnthropicEffort(envelope.state.effort) ? { effort: envelope.state.effort } : {}),
  };
}

function validateEnvelope(
  value: unknown,
  kind: "configuration" | "invalid_request",
): EnvelopeV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["v", "kind", "source", "state"]) || value.v !== 1) {
    throw invalidState(kind, "Provider continuation state schema is invalid.");
  }
  if (
    value.kind !== "openai_reasoning" &&
    value.kind !== "anthropic_thinking" &&
    value.kind !== "anthropic_redacted_thinking"
  ) {
    throw invalidState(kind, "Provider continuation state kind is invalid.");
  }
  return {
    v: 1,
    kind: value.kind,
    source: validateSource(value.source, kind),
    state: validateState(value.kind, value.state, kind),
  };
}

function validateSource(
  value: unknown,
  kind: "configuration" | "invalid_request",
): ProviderIdentity {
  if (!isRecord(value) || !hasExactKeys(value, ["provider", "api", "model"])) {
    throw invalidState(kind, "Provider continuation state source is invalid.");
  }
  return {
    provider: boundedString(value.provider, MAX_PROVIDER_LENGTH, kind, "provider"),
    api: boundedString(value.api, MAX_API_LENGTH, kind, "api"),
    model: boundedString(value.model, MAX_MODEL_LENGTH, kind, "model"),
  };
}

function validateState(
  continuationKind: ProviderContinuationState["kind"],
  value: unknown,
  errorKind: "configuration" | "invalid_request",
): Record<string, string> {
  if (!isRecord(value)) {
    throw invalidState(errorKind, "Provider continuation state payload is invalid.");
  }
  if (continuationKind === "openai_reasoning") {
    const keys = Object.keys(value);
    const keysValid = keys.includes("encrypted_content")
      && keys.every((key) =>
        key === "encrypted_content"
        || key === "item_id"
        || key === "hosted_tool_call_ids"
        || key === "hosted_tool_call_offsets"
      );
    if (!keysValid || (value.hosted_tool_call_offsets !== undefined && value.hosted_tool_call_ids === undefined)) {
      throw invalidState(errorKind, "OpenAI continuation state schema is invalid.");
    }
    const ids = value.hosted_tool_call_ids === undefined
      ? undefined
      : hostedToolCallIds(
          nonEmptyString(value.hosted_tool_call_ids, errorKind, "hosted_tool_call_ids"),
          errorKind,
        );
    const offsets = value.hosted_tool_call_offsets === undefined
      ? undefined
      : hostedToolCallOffsets(
          nonEmptyString(value.hosted_tool_call_offsets, errorKind, "hosted_tool_call_offsets"),
          errorKind,
        );
    if (ids && offsets && ids.length !== offsets.length) {
      throw invalidState(errorKind, "OpenAI hosted tool continuation state is invalid.");
    }
    return {
      encrypted_content: nonEmptyString(value.encrypted_content, errorKind, "encrypted_content"),
      ...(value.item_id === undefined
        ? {}
        : { item_id: boundedString(value.item_id, MAX_ITEM_ID_LENGTH, errorKind, "item_id") }),
      ...(ids ? { hosted_tool_call_ids: JSON.stringify(ids) } : {}),
      ...(offsets ? { hosted_tool_call_offsets: JSON.stringify(offsets) } : {}),
    };
  }
  if (continuationKind === "anthropic_thinking") {
    if (!hasKeys(value, ["thinking", "signature"], ["effort"])) {
      throw invalidState(errorKind, "Anthropic thinking state schema is invalid.");
    }
    if (typeof value.thinking !== "string") {
      throw invalidState(errorKind, "Anthropic thinking text is invalid.");
    }
    return {
      thinking: value.thinking,
      signature: nonEmptyString(value.signature, errorKind, "signature"),
      ...anthropicEffortState(value.effort, errorKind),
    };
  }
  if (!hasKeys(value, ["data"], ["effort"])) {
    throw invalidState(errorKind, "Anthropic redacted thinking state schema is invalid.");
  }
  return {
    data: nonEmptyString(value.data, errorKind, "data"),
    ...anthropicEffortState(value.effort, errorKind),
  };
}

function hostedToolCallIds(
  value: string,
  kind: "configuration" | "invalid_request",
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidState(kind, "OpenAI hosted tool continuation state is invalid.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_HOSTED_TOOL_CALL_IDS) {
    throw invalidState(kind, "OpenAI hosted tool continuation state is invalid.");
  }
  return parsed.map((id) => boundedString(id, MAX_ITEM_ID_LENGTH, kind, "hosted_tool_call_id"));
}

function hostedToolCallOffsets(
  value: string,
  kind: "configuration" | "invalid_request",
): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidState(kind, "OpenAI hosted tool continuation state is invalid.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_HOSTED_TOOL_CALL_IDS) {
    throw invalidState(kind, "OpenAI hosted tool continuation state is invalid.");
  }
  return parsed.map((offset) => {
    if (!Number.isSafeInteger(offset) || offset === 0 || Math.abs(offset) > MAX_HOSTED_TOOL_CALL_OFFSET) {
      throw invalidState(kind, "OpenAI hosted tool continuation state is invalid.");
    }
    return offset as number;
  });
}

function boundedString(
  value: unknown,
  maxLength: number,
  kind: "configuration" | "invalid_request",
  field: string,
): string {
  const text = nonEmptyString(value, kind, field);
  if (text.length > maxLength) {
    throw invalidState(kind, `Provider continuation state ${field} is too long.`);
  }
  return text;
}

function nonEmptyString(
  value: unknown,
  kind: "configuration" | "invalid_request",
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidState(kind, `Provider continuation state ${field} must be a non-empty string.`);
  }
  return value;
}

function anthropicEffortState(
  value: unknown,
  kind: "configuration" | "invalid_request",
): { effort?: string } {
  if (value === undefined) return {};
  if (!isAnthropicEffort(value)) throw invalidState(kind, "Anthropic thinking effort is invalid.");
  return { effort: value };
}

function hasKeys(value: Record<string, unknown>, required: string[], optional: string[]): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function invalidState(
  kind: "configuration" | "invalid_request",
  message: string,
): RouterFrameworkError {
  return new RouterFrameworkError(
    kind,
    message,
    "invalid_provider_continuation_state",
    "input.reasoning.encrypted_content",
  );
}
