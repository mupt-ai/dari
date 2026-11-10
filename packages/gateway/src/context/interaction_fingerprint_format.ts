import { createHash } from "node:crypto";

import { stableStringify } from "@mupt-ai/dari-router/policy-engine";

import type {
  InteractionContent,
  InteractionRequest,
} from "../interaction/types.js";

// Bump when canonical fingerprint semantics change so persisted hashes from
// incompatible contracts remain disjoint.
const INTERACTION_FINGERPRINT_VERSION = "interaction-v3";

const OPTION_FINGERPRINT_VERSION = "interaction-options-v1";

export type FingerprintContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "image";
          url: string;
          detail?: "auto" | "low" | "high" | "original";
        }
      | { type: "document"; mimeType: "application/pdf"; data: string }
      | { type: "tool_reference"; toolName: string }
    >
  | null;

export type FingerprintCall = {
  id: string;
  kind: "function" | "custom" | "hosted";
  name: string;
  input: unknown;
};

export type ReasoningFingerprint = {
  itemId?: string;
  readableSha256: string;
  continuationStateSha256?: string;
};

export type InteractionFingerprintStep = {
  actor: "system" | "developer" | "user" | "assistant" | "tool";
  content: FingerprintContent;
  calls: FingerprintCall[];
  resultCallId: string | null;
  itemIndex: number;
  itemId?: string;
  phase?: "commentary" | "final_answer";
  reasoning?: ReasoningFingerprint[];
};

export function interactionFingerprintHeadHash(
  routerId: string,
  request: InteractionRequest,
): string {
  const systemItems: Array<{ actor: "system" | "developer"; content: FingerprintContent }> = [];
  for (const item of request.items) {
    if (
      item.type !== "message"
      || (item.role !== "system" && item.role !== "developer")
    ) {
      break;
    }
    systemItems.push({
      actor: item.role,
      content: systemFingerprintContent(item.content, item.contentShape),
    });
  }
  return sha256(stableStringify({
    version: INTERACTION_FINGERPRINT_VERSION,
    routerId,
    ...(request.agentContext === undefined ? {} : { agentContext: {
      requestClass: request.agentContext.requestClass,
      agentId: request.agentContext.agentId ?? null,
    } }),
    instructions: request.instructions ?? null,
    systemItems,
    tools: request.tools,
  }));
}

function systemFingerprintContent(
  content: string | InteractionContent[] | null,
  shape: "string" | "parts" | "null" | "absent",
): FingerprintContent {
  const normalized = interactionFingerprintContent(content, shape);
  // Anthropic defines a string system value and one plain text block as
  // equivalent. Preserve that established head identity without flattening
  // structured system content such as images or multiple blocks.
  if (
    Array.isArray(normalized)
    && normalized.length === 1
    && normalized[0]?.type === "text"
  ) {
    return normalized[0].text;
  }
  return normalized;
}

export function interactionOptionsFingerprints(
  request: InteractionRequest,
): { tool_choice_fp: string; response_format_fp: string } {
  return {
    tool_choice_fp: optionFingerprint("tool-choice", request.toolChoice ?? null),
    response_format_fp: optionFingerprint(
      "response-format",
      request.responseFormat ?? null,
    ),
  };
}

export function canonicalInteractionFingerprintStep(
  step: InteractionFingerprintStep,
): string {
  return stableStringify({
    actor: step.actor,
    content: step.content,
    calls: step.calls.length > 0 ? step.calls : null,
    resultCallId: step.resultCallId,
    ...(step.itemId ? { itemId: step.itemId } : {}),
    ...(step.phase ? { phase: step.phase } : {}),
    ...(step.reasoning ? { reasoning: step.reasoning } : {}),
  });
}

export function interactionFingerprintContent(
  content: string | InteractionContent[] | null,
  shape: "string" | "parts" | "null" | "absent",
): FingerprintContent {
  // Preserve the established identity rule that absent and explicit null
  // content are equivalent. Structured parts remain distinct from strings.
  if (shape === "absent" || shape === "null") return null;
  if (shape === "string") {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((part): part is { type: "text"; text: string } =>
        part.type === "text"
      )
      .map((part) => part.text)
      .join("");
  }
  if (!Array.isArray(content)) return [];
  return content.map((part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text };
    if (part.type === "tool_reference") {
      return {
        type: "tool_reference" as const,
        toolName: part.toolName,
      };
    }
    if (part.type === "document") {
      return { type: "document" as const, mimeType: part.mimeType, data: part.data };
    }
    return {
      type: "image" as const,
      url: part.url,
      ...(part.detail !== undefined ? { detail: part.detail } : {}),
    };
  });
}

export function normalizedAssistantFingerprintContent(
  content: string | InteractionContent[] | null,
  shape: "string" | "parts" | "null" | "absent",
): FingerprintContent {
  const normalized = interactionFingerprintContent(content, shape);
  return typeof normalized === "string" && normalized.trim() === ""
    ? null
    : normalized;
}

export function appendFingerprintContentText(
  content: FingerprintContent,
  text: string,
): FingerprintContent {
  if (!text) return content;
  if (typeof content === "string") return content ? `${content}\n${text}` : text;
  if (Array.isArray(content)) return [...content, { type: "text", text }];
  return text;
}

function optionFingerprint(kind: string, value: unknown): string {
  return sha256(
    `${OPTION_FINGERPRINT_VERSION}\u0000${kind}\u0000${stableStringify(value)}`,
  );
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
