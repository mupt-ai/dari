// Selector prompt sizing. The selector can see a front-trimmed view of the
// conversation; the eventual provider call still receives the full request.

import { isRecord, type ChatMessage } from "./types.js";

const SELECTOR_TRUNCATION_MARKER = "<earlier messages truncated for routing>";
const MARKER_MESSAGE: ChatMessage = { role: "user", content: SELECTOR_TRUNCATION_MARKER };

// Maximum removable history while keeping the latest message intact. Sizing
// uses this before compacting the latest turn.
export function olderMessageChars(messages: ChatMessage[]): number {
  if (messages.length <= 1) return 0;
  return Math.max(
    0,
    JSON.stringify(messages).length - JSON.stringify([MARKER_MESSAGE, messages.at(-1)]).length,
  );
}

// Drop the oldest agent messages first: the latest turns carry the routing
// signal and the user's messages carry their intent, so user messages go,
// oldest first, only once no older agent message is left.
export function trimMessagesFromFront(messages: ChatMessage[], dropChars: number): ChatMessage[] {
  const targetLength = Math.max(0, JSON.stringify(messages).length - Math.max(0, dropChars));
  const kept = [...messages];
  while (kept.length > 1 && JSON.stringify([MARKER_MESSAGE, ...kept]).length > targetLength) {
    const agentIndex = kept.findIndex(
      (message, index) => index < kept.length - 1 && message.role !== "user",
    );
    kept.splice(agentIndex >= 0 ? agentIndex : 0, 1);
  }

  const marked = [MARKER_MESSAGE, ...kept];
  if (JSON.stringify(marked).length <= targetLength) return marked;

  if (kept.length === 1) {
    const first = kept[0]!;
    const trimmableContent = trimSourceContent(first);
    if (trimmableContent === null) return [MARKER_MESSAGE];
    const prefix = `${SELECTOR_TRUNCATION_MARKER}\n`;
    let content = `${prefix}${trimmableContent}`;
    while (content.length > prefix.length) {
      const excess = JSON.stringify([{ ...first, content }]).length - targetLength;
      if (excess <= 0) break;
      content = `${prefix}${content.slice(prefix.length + excess)}`;
    }
    return [{ ...first, content }];
  }

  return [MARKER_MESSAGE];
}

function trimSourceContent(message: ChatMessage): string | null {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return null;
  return message.content.map(formatContentPartForTrim).join("\n");
}

function formatContentPartForTrim(part: Record<string, unknown>): string {
  if (isRecord(part) && part.type === "text" && typeof part.text === "string") return part.text;
  if (isRecord(part) && part.type === "image_url") return "<image omitted>";
  return JSON.stringify(part);
}
