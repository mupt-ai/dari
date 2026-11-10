import type {
  InteractionContent,
  InteractionMessage,
  InteractionRequest,
} from "../interaction/types.js";

type AssistantGroup = {
  kind: "assistant";
  rawBlocks: number;
  hasContent: boolean;
  hasReasoning: boolean;
  hasToolCalls: boolean;
  hostedToolCarrier: boolean;
};

type LastGroup = AssistantGroup | { kind: "other" } | null;

// Monotonic, target-independent position used only to fence asynchronous
// lease writes. It follows canonical Interaction grouping and deliberately
// does not serialize selector messages or approximate provider cache blocks.
export function interactionLeaseFenceDepth(
  request: InteractionRequest,
): number {
  const state: { depth: number; last: LastGroup } = {
    depth: 0,
    last: null,
  };

  const startAssistant = (args: {
    rawBlocks: number;
    hasContent?: boolean;
    hasReasoning?: boolean;
    hasToolCalls?: boolean;
    hostedToolCarrier?: boolean;
  }): AssistantGroup => {
    const assistant: AssistantGroup = {
      kind: "assistant",
      rawBlocks: args.rawBlocks,
      hasContent: args.hasContent ?? false,
      hasReasoning: args.hasReasoning ?? false,
      hasToolCalls: args.hasToolCalls ?? false,
      hostedToolCarrier: args.hostedToolCarrier ?? false,
    };
    state.depth += groupBlockCount(assistant.rawBlocks);
    state.last = assistant;
    return assistant;
  };

  const addAssistantBlock = (assistant: AssistantGroup): void => {
    const before = groupBlockCount(assistant.rawBlocks);
    assistant.rawBlocks += 1;
    state.depth += groupBlockCount(assistant.rawBlocks) - before;
  };

  const addOther = (blocks: number): void => {
    state.depth += groupBlockCount(blocks);
    state.last = { kind: "other" };
  };

  for (const item of request.items) {
    if (item.type === "reasoning") {
      if (
        state.last?.kind === "assistant"
        && !state.last.hasContent
        && !state.last.hostedToolCarrier
      ) {
        state.last.hasReasoning = true;
      } else {
        startAssistant({ rawBlocks: 0, hasReasoning: true });
      }
      continue;
    }

    if (item.type === "reasoning_configuration") {
      continue;
    }

    if (item.type === "tool_result") {
      addOther(1);
      continue;
    }

    if (item.type === "tool_call" || item.type === "hosted_tool_call") {
      const assistant = state.last?.kind === "assistant"
        ? state.last
        : startAssistant({ rawBlocks: 0 });
      addAssistantBlock(assistant);
      assistant.hasToolCalls = true;
      if (item.type === "hosted_tool_call") {
        assistant.hostedToolCarrier = true;
      }
      continue;
    }

    if (item.role === "system" || item.role === "developer") {
      state.last = { kind: "other" };
      continue;
    }

    const blocks = messageContentBlocks(item);
    const hasContent = blocks > 0;
    if (
      item.role === "assistant"
      && state.last?.kind === "assistant"
      && state.last.hasReasoning
      && !state.last.hasContent
      && !state.last.hasToolCalls
    ) {
      const before = groupBlockCount(state.last.rawBlocks);
      state.last.rawBlocks = blocks;
      state.last.hasContent = hasContent;
      state.depth += groupBlockCount(state.last.rawBlocks) - before;
      continue;
    }

    if (item.role === "assistant") {
      startAssistant({ rawBlocks: blocks, hasContent });
    } else {
      addOther(blocks);
    }
  }

  return state.depth;
}

function messageContentBlocks(message: InteractionMessage): number {
  if (message.contentShape === "absent" || message.contentShape === "null") {
    return 0;
  }
  if (message.contentShape === "string") {
    return stringContent(message.content).length > 0 ? 1 : 0;
  }
  if (Array.isArray(message.content)) return message.content.length;
  return message.content === null ? 0 : 1;
}

function stringContent(content: string | InteractionContent[] | null): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      part.type === "text"
    )
    .map((part) => part.text)
    .join("");
}

function groupBlockCount(rawBlocks: number): number {
  return Math.max(1, rawBlocks);
}
