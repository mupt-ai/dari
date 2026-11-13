import type { ChatMessage } from "@mupt-ai/dari-router/policy-engine";

import { toolWireName } from "../interaction/tool_identity.js";
import type {
  InteractionContent,
  InteractionMessage,
  InteractionRequest,
  InteractionToolCall,
} from "../interaction/types.js";

export const IMAGE_OMITTED = "<image omitted>";
// Matches every numbered placeholder in a rendered selector prompt.
export const SELECTOR_IMAGE_PLACEHOLDERS = /<image (\d+)>/g;
const OPAQUE_REASONING_OMITTED = "<opaque reasoning omitted>";

// An image the selector may receive out of band. `index` is the 1-based
// position of its `<image N>` placeholder in the projected messages.
export type SelectorImage = {
  index: number;
  url: string;
};

export type SelectorProjection = {
  messages: ChatMessage[];
  // Empty unless image input was requested; then every image part in
  // `messages` is a numbered placeholder with its bytes listed here.
  images: SelectorImage[];
};

// The selector needs readable task history, not provider replay state. This
// projection intentionally keeps text and tool exchanges while omitting
// opaque continuation payloads, source item ids, phases, and image bytes.
// With `imageInput`, image parts become numbered `<image N>` placeholders and
// the data URLs are returned separately so the policy adapter can attach them
// as ordered image parts. Without it the projection stays byte-identical to
// the pre-image-input shape, which the deployed policy was trained on.
export function selectorMessagesForInteraction(
  interaction: InteractionRequest,
  options: { imageInput?: boolean } = {},
): SelectorProjection {
  const messages: ChatMessage[] = [];
  const images: SelectorImage[] = [];
  const imagePart = (url: string, detail: string | undefined): Record<string, unknown> => {
    let placeholder = IMAGE_OMITTED;
    if (options.imageInput === true) {
      images.push({ index: images.length + 1, url });
      placeholder = `<image ${images.length}>`;
    }
    return {
      type: "image_url",
      image_url: {
        url: placeholder,
        ...(detail !== undefined ? { detail } : {}),
      },
    };
  };
  // Hosted calls are complete provider output groups. Harness calls can be
  // persisted before reasoning that belongs to the same assistant turn.
  const hostedToolCarriers = new WeakSet<ChatMessage>();
  if (interaction.instructions) {
    messages.push({ role: "system", content: interaction.instructions });
  }

  for (const item of interaction.items) {
    if (item.type === "reasoning") {
      const readable = [...item.summary, ...item.content].join("\n");
      let assistant = messages.at(-1);
      if (
        !assistant
        || assistant.role !== "assistant"
        || hasAssistantContent(assistant)
        || hostedToolCarriers.has(assistant)
      ) {
        assistant = { role: "assistant", content: null };
        messages.push(assistant);
      }
      const selectorReasoning =
        readable || OPAQUE_REASONING_OMITTED;
      assistant.reasoning_content = assistant.reasoning_content
        ? `${assistant.reasoning_content}\n${selectorReasoning}`
        : selectorReasoning;
      continue;
    }

    if (item.type === "reasoning_configuration" || item.type === "compaction") {
      continue;
    }

    if (item.type === "tool_result") {
      messages.push({
        role: "tool",
        tool_call_id: item.callId,
        ...selectorContentField(item.output, item.outputShape, imagePart),
      });
      continue;
    }

    if (item.type === "tool_call") {
      appendToolCall(messages, item);
      continue;
    }

    if (item.type === "hosted_tool_call") {
      const assistant = appendToolCall(messages, {
        type: "tool_call",
        id: item.id,
        callId: item.id,
        kind: "function",
        name: item.tool,
        input: item.payload,
      });
      hostedToolCarriers.add(assistant);
      continue;
    }

    const content = selectorContentField(item.content, item.contentShape, imagePart);
    const previous = messages.at(-1);
    if (
      item.role === "assistant"
      && previous?.role === "assistant"
      && isReasoningOnly(previous)
    ) {
      if ("content" in content) previous.content = content.content;
      else delete previous.content;
      continue;
    }
    messages.push({ role: item.role, ...content });
  }

  return { messages, images };
}

function appendToolCall(
  messages: ChatMessage[],
  item: InteractionToolCall,
): ChatMessage {
  let assistant = messages.at(-1);
  if (!assistant || assistant.role !== "assistant") {
    assistant = { role: "assistant", content: null };
    messages.push(assistant);
  }
  assistant.tool_calls = [
    ...(assistant.tool_calls ?? []),
    {
      id: item.callId,
      type: "function",
      function: {
        name: toolWireName(item.namespace, item.name),
        ...(item.input !== undefined
          ? {
              arguments:
                item.kind === "custom"
                  ? JSON.stringify({ input: String(item.input) })
                  : item.input,
            }
          : {}),
      },
    },
  ];
  return assistant;
}

function selectorContentField(
  content: InteractionContent[] | string | null,
  shape: InteractionMessage["contentShape"],
  imagePart: (url: string, detail: string | undefined) => Record<string, unknown>,
): Pick<ChatMessage, "content"> {
  if (shape === "absent") return {};
  if (shape === "null") return { content: null };
  if (shape === "string") {
    const text = Array.isArray(content)
      ? content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
      : content;
    return { content: text ?? "" };
  }
  if (!Array.isArray(content)) {
    return {
      content:
        content === null
          ? []
          : [{ type: "text", text: content }],
    };
  }
  return {
    content: content.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "tool_reference") {
        return { type: "text", text: `Referenced tool: ${part.toolName}` };
      }
      // The selector model is text-only; it sees a marker, not the document bytes.
      if (part.type === "document") return { type: "text", text: "(PDF document omitted from selector input)" };
      return imagePart(part.url, part.detail);
    }),
  };
}

function hasAssistantContent(message: ChatMessage): boolean {
  if (typeof message.content === "string") return message.content.length > 0;
  return Array.isArray(message.content) && message.content.length > 0;
}

function isReasoningOnly(message: ChatMessage): boolean {
  return !message.tool_calls?.length
    && !hasAssistantContent(message)
    && message.reasoning_content !== undefined;
}
