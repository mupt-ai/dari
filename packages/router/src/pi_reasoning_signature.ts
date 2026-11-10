import { isRecord } from "./types.js";

// Wire codec for the JSON blob Pi carries in thinkingSignature on
// openai-responses APIs: a serialized Responses reasoning item whose
// encrypted_content holds the replayable state.

export function encodeOpenAIReasoningSignature(state: {
  id?: string;
  summary: string[];
  content: string[];
  encryptedContent: string;
}): string {
  return JSON.stringify({
    type: "reasoning",
    ...(state.id ? { id: state.id } : {}),
    summary: state.summary.map((text) => ({ type: "summary_text", text })),
    ...(state.content.length
      ? { content: state.content.map((text) => ({ type: "reasoning_text", text })) }
      : {}),
    encrypted_content: state.encryptedContent,
  });
}

export function decodeOpenAIReasoningSignature(value: string): {
  id?: string;
  encryptedContent?: string;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "reasoning") return null;
  return {
    ...(typeof parsed.id === "string" && parsed.id.length > 0 ? { id: parsed.id } : {}),
    ...(typeof parsed.encrypted_content === "string" && parsed.encrypted_content.length > 0
      ? { encryptedContent: parsed.encrypted_content }
      : {}),
  };
}
