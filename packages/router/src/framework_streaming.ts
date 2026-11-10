import { RouterFrameworkError } from "./framework_error.js";
import {
  anthropicMessageStart,
  anthropicStopReason,
  anthropicUsage,
} from "./protocol_anthropic.js";
import {
  openAIChatChunk,
  openAIStreamDelta,
  openAIUsage,
} from "./protocol_openai_chat.js";
import { encodeProviderContinuationState } from "./continuation_state.js";
import { encodePortableReasoningState } from "./portable_reasoning_state.js";
import {
  cancelled,
  closeAsyncIterator,
  errorMessage,
  streamContract,
  throwIfAborted,
} from "./framework_lifecycle.js";
import {
  validateStreamEvent,
  validateStreamSequence,
} from "./framework_validation.js";
import type {
  RouterCompletion,
  RouterProtocol,
  RouterSelection,
  RouterStreamEvent,
} from "./framework_types.js";

export type PrimedStream = {
  first: RouterStreamEvent;
  iterator: AsyncIterator<RouterStreamEvent>;
};

// An executor result that already passed mode and shape validation and, for
// streams, priming — i.e. everything covered by the fallback/lease-drop
// region.
export type StartedExecution =
  | { type: "stream"; primed: PrimedStream }
  | { type: "complete"; output: RouterCompletion };

export async function primeStream(
  events: AsyncIterable<RouterStreamEvent>,
  controller: AbortController,
): Promise<PrimedStream> {
  let iterator: AsyncIterator<RouterStreamEvent> | undefined;
  let first: IteratorResult<RouterStreamEvent>;
  try {
    iterator = events[Symbol.asyncIterator]();
    throwIfAborted(controller.signal);
    first = await iterator.next();
  } catch (error) {
    if (iterator !== undefined) await closeAsyncIterator(iterator);
    if (controller.signal.aborted) throw cancelled(controller.signal.reason);
    if (error instanceof RouterFrameworkError) throw error;
    throw new RouterFrameworkError(
      "executor",
      errorMessage(error, "Executor stream failed before its first event."),
      "stream_setup_failed",
      undefined,
      { cause: error },
    );
  }
  if (controller.signal.aborted) {
    await closeAsyncIterator(iterator);
    throw cancelled(controller.signal.reason);
  }
  if (first.done) {
    // Do not abort the shared controller: that would poison a fallback
    // attempt and misreport this contract failure as a cancellation.
    await closeAsyncIterator(iterator);
    throw new RouterFrameworkError(
      "executor",
      "Executor stream ended without a terminal event.",
      "stream_empty",
    );
  }
  try {
    validateStreamEvent(first.value);
    if (first.value.type === "tool_call_delta" || first.value.type === "tool_call_end") {
      throw streamContract("Executor stream must start with text, reasoning, a tool call, or finish.");
    }
  } catch (error) {
    await closeAsyncIterator(iterator);
    throw error;
  }
  return { first: first.value, iterator };
}

export function streamResponse<Metadata>(args: {
  protocol: RouterProtocol;
  id: string;
  model: string;
  requestedModel: string;
  selection: RouterSelection<Metadata>;
  primed: PrimedStream;
  controller: AbortController;
  headers: HeadersInit;
  // Fired once, at failure-classification time, when the stream dies from a
  // genuine provider/contract failure (never on client abort or reader
  // cancel). Must not throw and must not need awaiting.
  onStreamFailure?: () => void;
  // Fired exactly once during teardown, after the executor iterator is
  // closed and before the wire stream closes. Must not throw.
  onFinalize: (
    completion: RouterCompletion | null,
    error: RouterFrameworkError | null,
  ) => void;
}): Response {
  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  let cancelledByReader = false;
  let finalized = false;
  let emitted = false;
  let firstEvent: RouterStreamEvent | undefined = args.primed.first;
  let streamCompletion: RouterCompletion | null = null;
  let streamError: RouterFrameworkError | null = null;
  let streamController: ReadableStreamDefaultController<Uint8Array>;

  const sequenceIndexes = new Map<number, "text" | "tool" | "reasoning">();
  const anthropicState: AnthropicStreamState = {
    openBlocks: new Map(),
    pendingTools: new Map(),
    pendingToolOrder: [],
    nextWireIndex: 0,
  };
  const openAIToolIndexes = new Map<number, number>();
  let nextOpenAIToolIndex = 0;
  let nextOpenAIReasoningIndex = 0;
  let enqueuedFrames = 0;
  const enqueueFrame = (frame: string) => {
    if (cancelledByReader) return;
    streamController.enqueue(encoder.encode(frame));
    enqueuedFrames += 1;
  };
  const sendOpenAI = (value: Record<string, unknown> | "[DONE]") => {
    enqueueFrame(`data: ${value === "[DONE]" ? value : JSON.stringify(value)}\n\n`);
  };
  const sendAnthropic = (event: string, value: Record<string, unknown>) => {
    enqueueFrame(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const sendOpenAIChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
    sendOpenAI(openAIChatChunk({ id: args.id, created, model: args.model, delta, finishReason }));
  };

  const processEvent = (event: RouterStreamEvent) => {
    validateStreamEvent(event);
    if (streamCompletion !== null) throw streamContract("Executor emitted an event after finish.");
    if (event.type === "finish") {
      if ([...sequenceIndexes.values()].includes("tool")) {
        throw streamContract("Executor finished with an open tool call.");
      }
      if ([...sequenceIndexes.values()].includes("reasoning")) {
        throw streamContract("Executor finished with an open reasoning block.");
      }
      streamCompletion = {
        content: [],
        finishReason: event.finishReason,
        ...(event.usage === undefined ? {} : { usage: event.usage }),
      };
      closeAnthropicTextBlocks(anthropicState, sendAnthropic);
      if (args.protocol === "openai_chat_completions") {
        sendOpenAIChunk({}, event.finishReason);
        if (event.usage !== undefined) {
          // Match OpenAI: usage arrives in a separate final chunk with an
          // empty choices array.
          sendOpenAI({
            ...openAIChatChunk({
              id: args.id,
              created,
              model: args.model,
              delta: {},
              finishReason: null,
            }),
            choices: [],
            usage: openAIUsage(event.usage),
          });
        }
      } else {
        sendAnthropic("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: anthropicStopReason(event.finishReason),
            stop_sequence: null,
          },
          usage: anthropicUsage(event.usage),
        });
      }
      return;
    }

    emitted = true;
    validateStreamSequence(event, sequenceIndexes);
    if (args.protocol !== "openai_chat_completions") {
      sendAnthropicEvent(event, anthropicState, sendAnthropic);
      return;
    }
    if (event.type === "tool_call_start" || event.type === "hosted_tool_call") {
      openAIToolIndexes.set(event.index, nextOpenAIToolIndex++);
    }
    const delta = openAIStreamDelta(
      event,
      event.type === "tool_call_start" ||
        event.type === "tool_call_delta" ||
        event.type === "hosted_tool_call"
        ? openAIToolIndexes.get(event.index)
        : undefined,
      // openAIStreamDelta emits a detail for every reasoning_end, so the index always advances.
      event.type === "reasoning_end" ? nextOpenAIReasoningIndex++ : undefined,
    );
    if (delta !== null) sendOpenAIChunk(delta);
  };

  const finalize = async () => {
    if (finalized) return;
    finalized = true;
    await closeAsyncIterator(args.primed.iterator);
    args.onFinalize(streamCompletion, streamError);
    if (cancelledByReader) return;
    if (streamCompletion !== null && streamError === null) {
      if (args.protocol === "openai_chat_completions") sendOpenAI("[DONE]");
      else sendAnthropic("message_stop", { type: "message_stop" });
    }
    streamController.close();
  };

  // Pull-based pump: one executor event per consumer pull, so slow readers
  // exert backpressure on the upstream provider instead of buffering the
  // whole response.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (args.protocol === "openai_chat_completions") {
        sendOpenAI(openAIChatChunk({
          id: args.id,
          created,
          model: args.model,
          delta: { role: "assistant" },
          finishReason: null,
          routing: { requestedModel: args.requestedModel, selection: args.selection },
        }));
      } else {
        sendAnthropic("message_start", anthropicMessageStart({
          id: args.id,
          model: args.model,
          requestedModel: args.requestedModel,
          selection: args.selection,
        }));
      }
    },
    async pull() {
      if (finalized) return;
      // Advance the executor until at least one SSE frame is enqueued: some
      // events (tool_call_end, buffered pending tools) emit nothing, and a
      // pull that enqueues nothing would stall the stream.
      const target = enqueuedFrames + 1;
      try {
        while (!finalized && enqueuedFrames < target) {
          if (args.controller.signal.aborted) {
            await finalize();
            return;
          }
          let event: RouterStreamEvent;
          if (firstEvent !== undefined) {
            event = firstEvent;
            firstEvent = undefined;
          } else {
            const next = await args.primed.iterator.next();
            if (finalized) return;
            if (args.controller.signal.aborted) {
              await finalize();
              return;
            }
            if (next.done) {
              if (streamCompletion === null) {
                throw streamContract(
                  emitted
                    ? "Executor stream ended without a finish event."
                    : "Executor stream ended without output or a finish event.",
                );
              }
              await finalize();
              return;
            }
            event = next.value;
          }
          processEvent(event);
        }
      } catch (error) {
        if (finalized) return;
        streamError = error instanceof RouterFrameworkError
          ? error
          : streamContract(errorMessage(error, "Executor stream failed."));
        if (!args.controller.signal.aborted) {
          // Client aborts and reader cancels abort the controller before the
          // pump observes them, so un-aborted here means a genuine failure.
          args.onStreamFailure?.();
          const message = errorMessage(error, "Executor stream failed.");
          if (args.protocol === "openai_chat_completions") {
            sendOpenAI({
              error: {
                message,
                type: "server_error",
                code: error instanceof RouterFrameworkError ? error.code : "stream_failed",
              },
            });
          } else {
            sendAnthropic("error", {
              type: "error",
              error: { type: "api_error", message },
            });
          }
        }
        // Stop the provider request from burning tokens once the stream is
        // dead; client aborts and reader cancels already do this.
        args.controller.abort(streamError);
        await finalize();
      }
    },
    async cancel(reason) {
      cancelledByReader = true;
      args.controller.abort(reason);
      await finalize();
    },
  });

  return new Response(body, {
    headers: {
      ...Object.fromEntries(new Headers(args.headers)),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

type AnthropicStreamBlock = {
  kind: "text" | "tool" | "reasoning";
  wireIndex: number;
};

type AnthropicPendingTool = {
  id: string;
  name: string;
  deltas: string[];
  ended: boolean;
};

type AnthropicStreamState = {
  openBlocks: Map<number, AnthropicStreamBlock>;
  pendingTools: Map<number, AnthropicPendingTool>;
  pendingToolOrder: Array<{
    normalizedIndex: number;
    tool: AnthropicPendingTool;
  }>;
  nextWireIndex: number;
};

function sendAnthropicEvent(
  event: Exclude<RouterStreamEvent, { type: "finish" }>,
  state: AnthropicStreamState,
  send: (event: string, value: Record<string, unknown>) => void,
): void {
  if (event.type === "hosted_tool_call") {
    throw new RouterFrameworkError(
      "configuration",
      "Hosted tool calls are not representable on the anthropic_messages protocol; route hosted-tool models over the OpenAI protocol.",
      "hosted_tool_call_unrepresentable",
    );
  }
  if (event.type === "text_delta") {
    closeAnthropicTextBlocks(state, send, event.index);
    if (hasOpenAnthropicBlock(state, "tool")) {
      throw streamContract("Anthropic text cannot interleave with an open tool call.");
    }
    if (hasOpenAnthropicBlock(state, "reasoning", event.index)) {
      throw streamContract("Anthropic text cannot interleave with an open thinking block.");
    }
    let block = state.openBlocks.get(event.index);
    if (block === undefined) {
      block = { kind: "text", wireIndex: state.nextWireIndex++ };
      state.openBlocks.set(event.index, block);
      send("content_block_start", {
        type: "content_block_start",
        index: block.wireIndex,
        content_block: { type: "text", text: "" },
      });
    }
    send("content_block_delta", {
      type: "content_block_delta",
      index: block.wireIndex,
      delta: { type: "text_delta", text: event.delta },
    });
    return;
  }
  if (event.type === "reasoning_delta") {
    closeAnthropicTextBlocks(state, send, event.index);
    if (hasOpenAnthropicBlock(state, "tool")) {
      throw streamContract("Anthropic reasoning cannot interleave with an open tool call.");
    }
    if (hasOpenAnthropicBlock(state, "reasoning", event.index)) {
      throw streamContract("Anthropic thinking blocks cannot interleave with each other.");
    }
    let block = state.openBlocks.get(event.index);
    if (block === undefined) {
      block = { kind: "reasoning", wireIndex: state.nextWireIndex++ };
      state.openBlocks.set(event.index, block);
      send("content_block_start", {
        type: "content_block_start",
        index: block.wireIndex,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
    }
    send("content_block_delta", {
      type: "content_block_delta",
      index: block.wireIndex,
      delta: { type: "thinking_delta", thinking: event.delta },
    });
    return;
  }
  if (event.type === "reasoning_end") {
    const block = state.openBlocks.get(event.index);
    if (block !== undefined && block.kind !== "reasoning") {
      throw streamContract(`Anthropic stream index ${event.index} is a ${block.kind} block, not reasoning.`);
    }
    if (event.redacted === true) {
      // Redacted thinking has no streamable content: emit the complete block
      // at once. SDK accumulators apply signature_delta to .signature, which
      // would leave data empty and fail replay.
      if (block !== undefined) {
        throw streamContract("Anthropic redacted thinking cannot follow streamed thinking deltas.");
      }
      const wireIndex = state.nextWireIndex++;
      send("content_block_start", {
        type: "content_block_start",
        index: wireIndex,
        content_block: {
          type: "redacted_thinking",
          data: reasoningEnvelope(event, wireIndex),
        },
      });
      stopAnthropicBlock(send, wireIndex);
      return;
    }
    let wireIndex: number;
    if (block === undefined) {
      // Empty thinking with no prior reasoning_delta: open and immediately
      // close a block so the content-block shape matches non-streaming
      // output.
      wireIndex = state.nextWireIndex++;
      send("content_block_start", {
        type: "content_block_start",
        index: wireIndex,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
    } else {
      wireIndex = block.wireIndex;
      state.openBlocks.delete(event.index);
    }
    // Every thinking block gets a signature: the provider continuation when
    // one exists, otherwise a portable envelope so the block replays through
    // the request parser.
    send("content_block_delta", {
      type: "content_block_delta",
      index: wireIndex,
      delta: { type: "signature_delta", signature: reasoningEnvelope(event, wireIndex) },
    });
    stopAnthropicBlock(send, wireIndex);
    return;
  }
  if (event.type === "tool_call_start") {
    closeAnthropicTextBlocks(state, send);
    if (hasOpenAnthropicBlock(state, "reasoning")) {
      throw streamContract("Anthropic tool calls cannot interleave with an open thinking block.");
    }
    if (hasOpenAnthropicBlock(state, "tool")) {
      const pending = {
        id: event.id,
        name: event.name,
        deltas: [],
        ended: false,
      };
      state.pendingTools.set(event.index, pending);
      state.pendingToolOrder.push({ normalizedIndex: event.index, tool: pending });
      return;
    }
    startAnthropicTool(state, send, event.index, event.id, event.name);
    return;
  }

  const block = state.openBlocks.get(event.index);
  if (block?.kind === "tool") {
    if (event.type === "tool_call_delta") {
      sendAnthropicToolDelta(send, block.wireIndex, event.delta);
      return;
    }
    state.openBlocks.delete(event.index);
    stopAnthropicBlock(send, block.wireIndex);
    flushPendingAnthropicTools(state, send);
    return;
  }

  const pending = state.pendingTools.get(event.index);
  if (pending === undefined) {
    throw streamContract(`Anthropic stream index ${event.index} has no open tool call.`);
  }
  if (event.type === "tool_call_delta") {
    pending.deltas.push(event.delta);
  } else {
    pending.ended = true;
    state.pendingTools.delete(event.index);
  }
}

function hasOpenAnthropicBlock(
  state: AnthropicStreamState,
  kind: "tool" | "reasoning",
  exceptIndex?: number,
): boolean {
  for (const [index, block] of state.openBlocks) {
    if (block.kind === kind && index !== exceptIndex) return true;
  }
  return false;
}

function reasoningEnvelope(
  event: Extract<RouterStreamEvent, { type: "reasoning_end" }>,
  wireIndex: number,
): string {
  return event.continuation
    ? encodeProviderContinuationState(event.continuation)
    : encodePortableReasoningState({
        ...(event.source === undefined ? {} : { source: event.source }),
        itemId: event.itemId ?? `reasoning_${wireIndex}`,
      });
}

function startAnthropicTool(
  state: AnthropicStreamState,
  send: (event: string, value: Record<string, unknown>) => void,
  normalizedIndex: number,
  id: string,
  name: string,
): AnthropicStreamBlock {
  const block = { kind: "tool" as const, wireIndex: state.nextWireIndex++ };
  state.openBlocks.set(normalizedIndex, block);
  send("content_block_start", {
    type: "content_block_start",
    index: block.wireIndex,
    content_block: { type: "tool_use", id, name, input: {} },
  });
  return block;
}

function sendAnthropicToolDelta(
  send: (event: string, value: Record<string, unknown>) => void,
  wireIndex: number,
  delta: string,
): void {
  send("content_block_delta", {
    type: "content_block_delta",
    index: wireIndex,
    delta: { type: "input_json_delta", partial_json: delta },
  });
}

function stopAnthropicBlock(
  send: (event: string, value: Record<string, unknown>) => void,
  wireIndex: number,
): void {
  send("content_block_stop", { type: "content_block_stop", index: wireIndex });
}

function flushPendingAnthropicTools(
  state: AnthropicStreamState,
  send: (event: string, value: Record<string, unknown>) => void,
): void {
  let entry = state.pendingToolOrder.shift();
  while (entry !== undefined) {
    const { normalizedIndex, tool } = entry;
    if (state.pendingTools.get(normalizedIndex) === tool) {
      state.pendingTools.delete(normalizedIndex);
    }
    const block = startAnthropicTool(
      state,
      send,
      normalizedIndex,
      tool.id,
      tool.name,
    );
    for (const delta of tool.deltas) {
      sendAnthropicToolDelta(send, block.wireIndex, delta);
    }
    if (!tool.ended) return;
    state.openBlocks.delete(normalizedIndex);
    stopAnthropicBlock(send, block.wireIndex);
    entry = state.pendingToolOrder.shift();
  }
}

function closeAnthropicTextBlocks(
  state: AnthropicStreamState,
  send: (event: string, value: Record<string, unknown>) => void,
  exceptIndex?: number,
): void {
  for (const [normalizedIndex, block] of state.openBlocks) {
    if (block.kind !== "text" || normalizedIndex === exceptIndex) continue;
    stopAnthropicBlock(send, block.wireIndex);
    state.openBlocks.delete(normalizedIndex);
  }
}
