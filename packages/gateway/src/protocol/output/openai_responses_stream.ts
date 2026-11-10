import {
  openAIResponsesOutputItem,
  openAIResponsesOutputItems,
  openAIResponsesResponseId,
  openAIResponsesRouting,
  openAIResponsesTerminal,
  openAIResponsesUsage,
} from "./openai_responses_output.js";
import { piMessageToInteractionOutput, textSignature } from "../../providers/pi_output.js";
import type {
  InteractionOutput,
  InteractionOutputItem,
  InteractionRequest,
  ProviderIdentity,
} from "../../interaction/types.js";
import {
  isProviderFailureMessage,
  providerFailureFromEvent,
  providerFailureMessage,
  type ProviderStreamOutcome,
} from "../../runtime/provider_stream_outcome.js";
import { sseStream } from "./sse_stream.js";

type StreamArgs = {
  id: string;
  model: string;
  routing: RoutingDecision;
  events: AsyncIterable<Record<string, unknown>>;
  source: ProviderIdentity;
  request: InteractionRequest;
  conversationId?: string;
  onFinal?: (outcome: ProviderStreamOutcome) => void;
  // Optional terminal barrier. Streaming deltas are unaffected, but the
  // terminal Responses event and EOF are held until this settles.
  beforeClose?: (outcome: ProviderStreamOutcome) => Promise<void> | void;
  clientSignal?: AbortSignal;
  onAbort?: () => void;
};

type Send = (event: string, value: Record<string, unknown>) => void;

export function openAIResponsesSseStream(args: StreamArgs): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const responseId = openAIResponsesResponseId(args.id);
  const createdAt = Math.floor(Date.now() / 1000);
  const accumulator = new ResponsesAccumulator(args, responseId);
  return sseStream({
    protocol: "openai_responses",
    lifecycle: args,
    start: ({ controller, snapshot, lifecycle, settle, observeTerminal }) => {
      let sequenceNumber = 0;
      let emitTerminal: (() => void) | null = null;
      const send: Send = (event, value) => {
        if (!lifecycle.canWrite) return;
        const data = { type: event, ...value, sequence_number: sequenceNumber++ };
        snapshot.record({ event, data });
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      // A Responses failure is a terminal envelope, so it is armed here and
      // emitted with the close frame rather than sent mid-stream.
      const armFailure = (message: Record<string, unknown>) => {
        emitTerminal = () => sendFailure(send, args, responseId, createdAt, accumulator, message);
      };
      send("response.created", {
        response: responseEnvelope(args, responseId, createdAt, "in_progress", [], undefined),
      });

      return {
        consume: async () => {
          for await (const event of args.events) {
            if (lifecycle.shouldStopConsuming) break;
            if (event.type === "done") {
              if (!isRecord(event.message)) throw new Error("Provider stream ended without a terminal message.");
              observeTerminal(event.message);
              if (isProviderFailureMessage(event.message)) {
                const message = event.message;
                settle({ status: "provider_error", message });
                armFailure(message);
                break;
              }
              const output = accumulator.complete(event.message, send);
              settle({ status: "completed", message: event.message, output });
              const terminal = openAIResponsesTerminal(output);
              emitTerminal = () => {
                send(`response.${terminal.status}`, {
                  response: responseEnvelope(
                    args,
                    responseId,
                    createdAt,
                    terminal.status,
                    openAIResponsesOutputItems(output),
                    output
                  ),
                });
              };
              break;
            }
            if (event.type === "error") {
              const message = providerFailureFromEvent(event);
              settle({ status: "provider_error", message });
              armFailure(message);
              break;
            }
            accumulator.consume(event, send);
          }
        },
        emitProviderError: armFailure,
        close: () => {
          emitTerminal?.();
          controller.close();
        },
      };
    },
  });
}

class ResponsesAccumulator {
  private readonly items = new Map<number, InteractionOutputItem>();
  private readonly addedIndexes = new Set<number>();
  private readonly completedIndexes = new Set<number>();
  private readonly messageIds = new Map<number, string>();
  private readonly messagePhases = new Map<number, "commentary" | "final_answer">();
  private readonly reasoningIds = new Map<number, string>();
  private readonly messagePartStarted = new Set<number>();
  private readonly reasoningPartStarted = new Set<number>();
  private readonly reasoningSummaryCompleted = new Set<number>();
  private readonly providerIndexByContentIndex = new Map<number, number>();
  private readonly pendingProviderIndexes: number[] = [];
  private activeIndex: number | null = null;
  private finalOutput: InteractionOutput | null = null;
  private providerResponse: Record<string, unknown> | null = null;

  constructor(
    private readonly args: StreamArgs,
    private readonly responseId: string
  ) {}

  consume(event: Record<string, unknown>, send: Send): void {
    const type = event.type;
    if (type === "provider_event" && isRecord(event.event)) {
      this.consumeProviderEvent(event.event, send);
      return;
    }
    if (type === "text_start" || type === "thinking_start" || type === "toolcall_start") {
      const index = this.indexFor(event);
      this.activate(index, send);
      if (type === "thinking_start") this.ensureReasoning(index, send);
      if (type === "text_start") this.rememberMessageSignature(event, index);
      return;
    }
    if (type === "text_delta" && typeof event.delta === "string" && event.delta) {
      const index = this.indexFor(event);
      this.activate(index, send);
      const message = this.ensureMessage(index, send);
      const text = message.content[0]?.type === "text" ? message.content[0].text : "";
      message.content = [{ type: "text", text: text + event.delta }];
      send("response.output_text.delta", {
        item_id: message.id,
        output_index: index,
        content_index: 0,
        delta: event.delta,
      });
      return;
    }
    if (type === "thinking_delta" && typeof event.delta === "string" && event.delta) {
      const index = this.indexFor(event);
      this.activate(index, send);
      const reasoning = this.ensureReasoning(index, send);
      if (!this.reasoningPartStarted.has(index)) {
        this.reasoningPartStarted.add(index);
        send("response.reasoning_summary_part.added", {
          item_id: reasoning.id,
          output_index: index,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        });
      }
      reasoning.summary[0] = (reasoning.summary[0] ?? "") + event.delta;
      send("response.reasoning_summary_text.delta", {
        item_id: reasoning.id,
        output_index: index,
        summary_index: 0,
        delta: event.delta,
      });
      return;
    }
    if (type === "text_end" || type === "thinking_end" || type === "toolcall_end") {
      const index = this.indexFor(event);
      this.activate(index, send);
      const item = this.itemFromEndEvent(event, index);
      if (item) {
        this.items.set(index, this.withStreamedId(item, index));
        this.sendItemDone(index, send);
      }
      this.activeIndex = null;
    }
  }

  complete(message: Record<string, unknown>, send: Send): InteractionOutput {
    const codexTerminalOmittedOutput =
      this.args.source.api === "openai-codex-responses"
      && this.providerResponse !== null
      && (!Array.isArray(this.providerResponse.output) || this.providerResponse.output.length === 0)
      && this.items.size > 0;
    const terminal = piMessageToInteractionOutput(
      this.providerResponse && !codexTerminalOmittedOutput
        ? { ...message, providerResponse: this.providerResponse }
        : message,
      this.args.source,
      this.args.request
    );
    if (codexTerminalOmittedOutput) {
      terminal.items = [...this.items.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, item]) => item);
    }
    for (const index of this.items.keys()) {
      if (index >= terminal.items.length) {
        throw new Error(`Provider terminal output omitted streamed output item ${index}.`);
      }
    }
    const items: InteractionOutputItem[] = terminal.items.map((item, index) => {
      const streamed = this.items.get(index);
      if (streamed && !sameOutputIdentity(streamed, item)) {
        throw new Error(`Provider terminal output changed the identity of output item ${index}.`);
      }
      const reconciled = this.withStreamedId(item, index);
      this.items.set(index, reconciled);
      return reconciled;
    });
    terminal.items = items;
    this.finalOutput = terminal;
    for (const index of [...this.items.keys()].sort((a, b) => a - b)) this.sendItemDone(index, send);
    return terminal;
  }

  private consumeProviderEvent(event: Record<string, unknown>, send: Send): void {
    const type = typeof event.type === "string" ? event.type : "";
    if (
      (type === "response.completed" || type === "response.incomplete") &&
      isRecord(event.response)
    ) {
      this.providerResponse = event.response;
      return;
    }

    if (type === "response.output_item.added" && isRecord(event.item)) {
      const index = providerOutputIndex(event);
      if (event.item.type === "web_search_call") {
        const item = providerHostedToolCall(event.item, this.args.source);
        this.items.set(index, item);
        this.addedIndexes.add(index);
        send(type, providerEventPayload(event));
        return;
      }
      if (!this.providerIndexIsMapped(index)) this.pendingProviderIndexes.push(index);
      if (
        event.item.type === "message"
        && typeof event.item.id === "string"
        && !this.messageIds.has(index)
      ) {
        this.messageIds.set(index, event.item.id);
      }
      if (
        event.item.type === "reasoning"
        && typeof event.item.id === "string"
        && !this.reasoningIds.has(index)
      ) {
        this.reasoningIds.set(index, event.item.id);
      }
      return;
    }

    if (type === "response.output_item.done" && isRecord(event.item)) {
      const index = providerOutputIndex(event);
      if (event.item.type === "message") {
        this.applyProviderMessageAnnotations(index, event.item);
        return;
      }
      if (event.item.type !== "web_search_call") return;
      this.items.set(index, providerHostedToolCall(event.item, this.args.source));
      if (!this.addedIndexes.has(index)) {
        this.addedIndexes.add(index);
        send("response.output_item.added", { output_index: index, item: event.item });
      }
      this.completedIndexes.add(index);
      send(type, providerEventPayload(event));
      return;
    }

    if (type === "response.output_text.annotation.added") {
      const index = providerOutputIndex(event);
      const item = this.items.get(index);
      const contentIndex = typeof event.content_index === "number" ? event.content_index : 0;
      if (item?.type === "message" && isRecord(event.annotation)) {
        const part = item.content[contentIndex];
        if (part?.type === "text") {
          part.annotations = [...(part.annotations ?? []), { ...event.annotation }];
        }
      }
      send(type, providerEventPayload(event));
      return;
    }
    if (type.startsWith("response.web_search_call.")) {
      send(type, providerEventPayload(event));
    }
  }

  private applyProviderMessageAnnotations(index: number, item: Record<string, unknown>): void {
    const message = this.items.get(index);
    if (message?.type !== "message" || !Array.isArray(item.content)) return;
    for (const [contentIndex, providerPart] of item.content.entries()) {
      if (!isRecord(providerPart) || !Array.isArray(providerPart.annotations)) continue;
      const part = message.content[contentIndex];
      if (part?.type !== "text") continue;
      part.annotations = providerPart.annotations.flatMap((annotation) =>
        isRecord(annotation) ? [{ ...annotation }] : []
      );
    }
  }

  currentOutputItems(): Array<Record<string, unknown>> {
    if (this.finalOutput) return openAIResponsesOutputItems(this.finalOutput);
    const output = this.baseOutput();
    output.items = [...this.items.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, item]) => item);
    return output.items.length ? openAIResponsesOutputItems(output) : [];
  }

  currentUsage(): Record<string, unknown> {
    return openAIResponsesUsage(this.finalOutput ?? this.baseOutput());
  }

  // Pi signs a Responses text block with its message id and phase at
  // text_start, so the item is announced with the phase it ends with.
  private rememberMessageSignature(event: Record<string, unknown>, index: number): void {
    const content = isRecord(event.partial) ? event.partial.content : undefined;
    const block = Array.isArray(content) ? content[event.contentIndex as number] : undefined;
    const signature = isRecord(block) ? textSignature(block.textSignature) : null;
    if (signature?.id && !this.messageIds.has(index)) this.messageIds.set(index, signature.id);
    if (signature?.phase) this.messagePhases.set(index, signature.phase);
  }

  private ensureMessage(index: number, send: Send): Extract<InteractionOutputItem, { type: "message" }> {
    const existing = this.items.get(index);
    if (existing?.type === "message") return existing;
    const id = this.messageIds.get(index) ?? streamedItemId("msg", this.responseId, index);
    this.messageIds.set(index, id);
    const phase = this.messagePhases.get(index);
    const message: Extract<InteractionOutputItem, { type: "message" }> = {
      type: "message",
      id,
      role: "assistant",
      content: [{ type: "text", text: "" }],
      contentShape: "parts",
      ...(phase ? { phase } : {}),
      source: this.args.source,
    };
    this.items.set(index, message);
    this.addedIndexes.add(index);
    send("response.output_item.added", {
      output_index: index,
      item: {
        type: "message",
        role: "assistant",
        id,
        status: "in_progress",
        content: [],
        ...(phase ? { phase } : {}),
      },
    });
    this.sendMessagePartAdded(index, id, send);
    return message;
  }

  private ensureReasoning(index: number, send: Send): Extract<InteractionOutputItem, { type: "reasoning" }> {
    const existing = this.items.get(index);
    if (existing?.type === "reasoning") return existing;
    const id = this.reasoningIds.get(index) ?? streamedItemId("rs", this.responseId, index);
    this.reasoningIds.set(index, id);
    const reasoning: Extract<InteractionOutputItem, { type: "reasoning" }> = {
      type: "reasoning",
      id,
      summary: [],
      content: [],
      source: this.args.source,
    };
    this.items.set(index, reasoning);
    this.addedIndexes.add(index);
    send("response.output_item.added", {
      output_index: index,
      item: { type: "reasoning", id, status: "in_progress", summary: [] },
    });
    return reasoning;
  }

  private itemFromEndEvent(event: Record<string, unknown>, index: number): InteractionOutputItem | null {
    if (isRecord(event.partial)) {
      const output = piMessageToInteractionOutput(event.partial, this.args.source, this.args.request);
      const contentIndex = event.contentIndex;
      if (typeof contentIndex === "number" && output.items[contentIndex]) return output.items[contentIndex];
    }
    if (event.type === "toolcall_end" && isRecord(event.toolCall)) {
      const output = piMessageToInteractionOutput(
        { content: [{ type: "toolCall", ...event.toolCall }], stopReason: "toolUse" },
        this.args.source,
        this.args.request
      );
      return output.items[0] ?? null;
    }
    return this.items.get(index) ?? null;
  }

  private withStreamedId(item: InteractionOutputItem, index: number): InteractionOutputItem {
    if (item.type === "message" && this.messageIds.has(index)) return { ...item, id: this.messageIds.get(index) };
    if (item.type === "reasoning" && this.reasoningIds.has(index)) return { ...item, id: this.reasoningIds.get(index) };
    return item;
  }

  private sendItemDone(index: number, send: Send): void {
    if (this.completedIndexes.has(index)) return;
    const item = this.items.get(index);
    if (!item) return;
    if (item.type === "reasoning" && !this.finalOutput) return;
    const serialized = openAIResponsesOutputItem(this.finalOutput ?? this.baseOutput(), item, index);
    if (!this.addedIndexes.has(index)) {
      this.addedIndexes.add(index);
      if (item.type === "message") {
        send("response.output_item.added", {
          output_index: index,
          item: {
            type: "message",
            role: "assistant",
            id: serialized.id,
            status: "in_progress",
            content: [],
            ...(item.phase ? { phase: item.phase } : {}),
          },
        });
      } else {
        send("response.output_item.added", { output_index: index, item: serialized });
      }
    }
    if (item.type === "message") {
      const id = String(serialized.id);
      const text = item.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      const annotations = item.content.flatMap((part) =>
        part.type === "text" ? part.annotations ?? [] : []
      );
      const part = { type: "output_text", text, annotations };
      this.sendMessagePartAdded(index, id, send);
      send("response.output_text.done", {
        item_id: id,
        output_index: index,
        content_index: 0,
        text,
      });
      send("response.content_part.done", {
        item_id: id,
        output_index: index,
        content_index: 0,
        part,
      });
    }
    if (item.type === "reasoning" && !this.reasoningSummaryCompleted.has(index) && item.summary[0]) {
      this.reasoningSummaryCompleted.add(index);
      send("response.reasoning_summary_text.done", {
        item_id: serialized.id,
        output_index: index,
        summary_index: 0,
        text: item.summary[0],
      });
    }
    this.completedIndexes.add(index);
    send("response.output_item.done", {
      output_index: index,
      item: serialized,
    });
  }

  private sendMessagePartAdded(index: number, id: string, send: Send): void {
    if (this.messagePartStarted.has(index)) return;
    this.messagePartStarted.add(index);
    send("response.content_part.added", {
      item_id: id,
      output_index: index,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  }

  private activate(index: number, send: Send): void {
    if (this.activeIndex !== null && this.activeIndex !== index) this.sendItemDone(this.activeIndex, send);
    this.activeIndex = index;
  }

  private indexFor(event: Record<string, unknown>): number {
    const contentIndex = event.contentIndex;
    if (typeof contentIndex !== "number" || !Number.isInteger(contentIndex) || contentIndex < 0) {
      throw new Error("Provider stream event is missing a valid contentIndex.");
    }
    const existing = this.providerIndexByContentIndex.get(contentIndex);
    if (existing !== undefined) return existing;
    const providerIndex = this.pendingProviderIndexes.shift() ?? this.nextAvailableOutputIndex(contentIndex);
    this.providerIndexByContentIndex.set(contentIndex, providerIndex);
    return providerIndex;
  }

  private providerIndexIsMapped(index: number): boolean {
    return [...this.providerIndexByContentIndex.values()].includes(index);
  }

  private nextAvailableOutputIndex(candidate: number): number {
    const reserved = new Set([
      ...this.items.keys(),
      ...this.pendingProviderIndexes,
      ...this.providerIndexByContentIndex.values(),
    ]);
    while (reserved.has(candidate)) candidate += 1;
    return candidate;
  }

  private baseOutput(): InteractionOutput {
    return {
      responseId: this.responseId,
      createdAtMs: Date.now(),
      source: this.args.source,
      items: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
    };
  }
}

function providerOutputIndex(event: Record<string, unknown>): number {
  const index = event.output_index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    throw new Error("OpenAI provider event is missing a valid output_index.");
  }
  return index;
}

function providerEventPayload(event: Record<string, unknown>): Record<string, unknown> {
  const { type: _type, sequence_number: _sequenceNumber, ...payload } = event;
  return payload;
}

function providerHostedToolCall(
  item: Record<string, unknown>,
  source: ProviderIdentity
): Extract<InteractionOutputItem, { type: "hosted_tool_call" }> {
  if (item.type !== "web_search_call" || typeof item.id !== "string" || !item.id) {
    throw new Error("OpenAI provider web search item is malformed.");
  }
  const status = providerHostedStatus(item.status);
  return {
    type: "hosted_tool_call",
    id: item.id,
    tool: "web_search",
    providerType: "web_search_call",
    ...(status ? { status } : {}),
    payload: { ...item },
    source,
  };
}

function providerHostedStatus(
  value: unknown
): "in_progress" | "searching" | "completed" | "incomplete" | "failed" | undefined {
  return value === "in_progress" ||
    value === "searching" ||
    value === "completed" ||
    value === "incomplete" ||
    value === "failed"
    ? value
    : undefined;
}

function sameOutputIdentity(left: InteractionOutputItem, right: InteractionOutputItem): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "hosted_tool_call" && right.type === "hosted_tool_call") {
    return left.id === right.id
      && left.tool === right.tool
      && left.providerType === right.providerType;
  }
  if (left.type !== "tool_call" || right.type !== "tool_call") return true;
  return left.callId === right.callId
    && left.kind === right.kind
    && left.name === right.name
    && left.namespace === right.namespace;
}

function responseEnvelope(
  args: StreamArgs,
  id: string,
  createdAt: number,
  status: "in_progress" | "completed" | "incomplete" | "failed",
  output: Array<Record<string, unknown>>,
  interaction: InteractionOutput | undefined
): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: createdAt,
    status,
    incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
    model: args.model,
    output,
    parallel_tool_calls: args.request.parallelToolCalls ?? true,
    ...(interaction ? { usage: openAIResponsesUsage(interaction) } : {}),
    dari_routing: openAIResponsesRouting(args.routing, args.id, args.conversationId),
  };
}

function sendFailure(
  send: Send,
  args: StreamArgs,
  responseId: string,
  createdAt: number,
  accumulator: ResponsesAccumulator,
  error: Record<string, unknown>
): void {
  send("response.failed", {
    response: {
      ...responseEnvelope(args, responseId, createdAt, "failed", accumulator.currentOutputItems(), undefined),
      usage: accumulator.currentUsage(),
      error: {
        message: providerFailureMessage(error),
        type: "server_error",
        code: "provider_execution_failed",
      },
    },
  });
}

function streamedItemId(prefix: "msg" | "rs", responseId: string, index: number): string {
  return `${prefix}_${responseId}_${index}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}
import { isRecord, type RoutingDecision } from "@mupt-ai/dari-router/policy-engine";
