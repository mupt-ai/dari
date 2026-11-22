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

