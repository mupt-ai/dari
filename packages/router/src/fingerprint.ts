import { createHash } from "node:crypto";

import type { ChatCompletionRequest, ChatMessage } from "./types.js";

const FP_VERSION = "v2";

/**
 * Conversation identity is an exact-prefix match over what providers actually
 * cache: system prompt, tools, and the message sequence. Sampling parameters
 * (temperature, top_p, max_tokens, ...) never enter provider cache keys and
 * are deliberately excluded. tool_choice and response_format are also kept
 * out of the chain — folding them in would break conversation identity over
 * a one-turn knob flip — and are tracked via optionsFingerprints instead.
 */

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// JSON with recursively sorted object keys so semantically identical payloads
// hash identically regardless of client key ordering. Provider caches match
// tokenized content, not raw JSON byte order.
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function canonicalToolCalls(toolCalls: Array<Record<string, unknown>> | undefined): unknown {
  if (!toolCalls?.length) return null;
  return toolCalls.map((call) => {
    const fn = isRecord(call.function) ? call.function : {};
    return {
      id: typeof call.id === "string" ? call.id : "",
      name: typeof fn.name === "string" ? fn.name : "",
      // Keep string arguments byte-exact; never parse-and-restringify, the
      // provider saw (and cached) exactly these bytes inside its prompt.
      arguments: typeof fn.arguments === "string" ? fn.arguments : stableStringify(fn.arguments ?? null),
    };
  });
}

export function canonicalMessage(message: ChatMessage): string {
  return stableStringify({
    role: message.role,
    content: message.content ?? null,
    tool_calls: canonicalToolCalls(message.tool_calls),
    tool_call_id: message.tool_call_id ?? null,
  });
}

function isSystemRole(role: string): boolean {
  return role === "system" || role === "developer";
}

export function conversationMessages(request: ChatCompletionRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let sawConversationMessage = false;
  for (const message of request.messages ?? []) {
    if (isSystemRole(message.role)) {
      if (!sawConversationMessage) continue;
      const previous = messages.at(-1);
      if (previous?.role === "tool") {
        previous.content = [...contentParts(previous.content), ...contentParts(message.content)];
      } else {
        appendConversationMessage(messages, { role: "user", content: message.content ?? null });
      }
      continue;
    }
    sawConversationMessage = true;
    appendConversationMessage(messages, message);
  }
  return messages;
}

function appendConversationMessage(messages: ChatMessage[], message: ChatMessage): void {
  const previous = messages.at(-1);
  if (message.role === "user" && previous?.role === "user") {
    previous.content = [...contentParts(previous.content), ...contentParts(message.content)];
    return;
  }
  messages.push({ ...message });
}

function contentParts(content: ChatMessage["content"]): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

// Approximates how many Anthropic content blocks a message renders to: one
// per content part (or one for string content), plus one per tool call; tool
// results are a single tool_result block. Used only for the Anthropic
// breakpoint-lookback gate, where blocks — not messages — are the unit.
export function messageBlockCount(message: ChatMessage): number {
  if (message.role === "tool") return 1;
  let blocks = 0;
  if (typeof message.content === "string") {
    if (message.content.length > 0) blocks += 1;
  } else if (Array.isArray(message.content)) {
    blocks += message.content.length;
  }
  blocks += message.tool_calls?.length ?? 0;
  return Math.max(1, blocks);
}

// Content-block position of this request's cache breakpoint (its last user
// message): total blocks across the non-system messages.
export function conversationBlockCount(request: ChatCompletionRequest): number {
  return conversationMessages(request).reduce(
    (total, message) => total + messageBlockCount(message),
    0
  );
}

// Anchors and scopes the chain. routerId is a pure namespace so two routers
// receiving identical conversations never share entries; system/tools changes
// bust provider caches, so they bust ours too.
// Only the leading system/developer preamble enters the head. Provider
// lowering keeps later system notes positional so per-turn reminders cannot
// reseed the whole cache chain.
// NUL is the component delimiter throughout: JSON.stringify always escapes
// control characters, so canonical output can never contain a raw NUL and
// component boundaries are unambiguous.
export function headHash(routerId: string, request: ChatCompletionRequest): string {
  const systemMessages: string[] = [];
  for (const message of request.messages ?? []) {
    if (!isSystemRole(message.role)) break;
    systemMessages.push(canonicalMessage(message));
  }
  return sha256(
    [FP_VERSION, routerId, `[${systemMessages.join(",")}]`, stableStringify(request.tools ?? [])].join("\u0000")
  );
}

// h[i] = sha256(h[i-1] ‖ canonical(message_i)) over provider-visible
// conversation messages. Mid-conversation system notes remain positional;
// only the leading preamble lives in the head hash.
export function prefixChain(routerId: string, request: ChatCompletionRequest): string[] {
  let hash = headHash(routerId, request);
  const chain: string[] = [];
  for (const message of conversationMessages(request)) {
    hash = sha256(`${hash}\u0000${canonicalMessage(message)}`);
    chain.push(hash);
  }
  return chain;
}

// Chain extended with the assistant reply we are about to return, in the
// exact OpenAI shape the client will echo back next turn.
export function extendChain(lastHash: string, assistantMessage: Record<string, unknown>): string {
  const canonical = canonicalMessage({
    role: "assistant",
    content: (assistantMessage.content as ChatMessage["content"]) ?? null,
    tool_calls: Array.isArray(assistantMessage.tool_calls)
      ? (assistantMessage.tool_calls as Array<Record<string, unknown>>)
      : undefined,
  });
  return sha256(`${lastHash}\u0000${canonical}`);
}

// NOT part of the chain (see the module comment): compared against the
// matched entry's stored values to downgrade cache-warmth estimates when
// these knobs flip mid-conversation. Do not "fix" this by folding them into
// headHash — that would break conversation identity over a one-turn change.
export function optionsFingerprints(request: ChatCompletionRequest): {
  tool_choice_fp: string;
  response_format_fp: string;
} {
  return {
    tool_choice_fp: sha256(stableStringify(request.tool_choice ?? null)),
    response_format_fp: sha256(stableStringify(request.response_format ?? null)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
