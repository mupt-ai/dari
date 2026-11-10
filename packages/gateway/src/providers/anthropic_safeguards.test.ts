import { expect, test } from "bun:test";

import type { InteractionRequest } from "../interaction/types.js";
import { piMessageToInteractionOutput } from "./pi_output.js";
import {
  completeInteractionModel,
  modelFixtures,
  piFixture,
  streamInteractionModel,
} from "./pi.fixtures.js";
import { buildOptions } from "./pi_options.js";

const SAFEGUARDS = [{
  type: "dangerous_tool_use",
  classifier_context: { v: 1, permission_mode: "auto" },
}];
const SAFEGUARD_RESULTS = [{
  type: "dangerous_tool_use",
  status: {
    type: "available",
    tool_uses: { toolu_bash: { type: "evaluated", outcome: "not_flagged" } },
  },
}];

const REQUEST: InteractionRequest = {
  sourceProtocol: "anthropic_messages",
  model: "dari/routing",
  items: [{
    type: "message",
    role: "user",
    content: [{ type: "text", text: "List the files." }],
    contentShape: "string",
  }],
  tools: [{
    kind: "function",
    name: "Bash",
    parameters: { type: "object", properties: { command: { type: "string" } } },
  }],
  generation: { maxOutputTokens: 256 },
  stream: true,
  anthropicSafeguards: { safeguards: SAFEGUARDS, betas: ["dangerous-tool-use-2026-09-03"] },
};

// Recorded shape of a Claude API stream answering a safeguards request.
const SSE = [
  `event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-6","id":"msg_1","type":"message","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":556,"output_tokens":8}}}`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_bash","name":"Bash","input":{}}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null,"safeguard_results":${JSON.stringify(SAFEGUARD_RESULTS)}},"usage":{"output_tokens":40}}`,
  `event: message_stop\ndata: {"type":"message_stop"}`,
].join("\n\n") + "\n\n";

function anthropicFetch(requests: Array<{ headers: Headers; body: Record<string, unknown> }>) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ headers: request.headers, body: await request.json() });
    // Split mid-line so the scanner has to reassemble events across chunks.
    const bytes = new TextEncoder().encode(SSE);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 37) {
          controller.enqueue(bytes.slice(offset, offset + 37));
        }
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
}

test("streams forward safeguards to Anthropic and return its safeguard results", async () => {
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const { events, source } = await streamInteractionModel({
    model: "anthropic/claude-sonnet-4-6",
    request: REQUEST,
    apiKey: "sk-ant-api-test",
    fetch: anthropicFetch(requests),
  });
  let message: Record<string, unknown> | undefined;
  for await (const event of events) {
    if (event.type === "done") message = event.message as Record<string, unknown>;
  }

  expect(requests[0]!.body.safeguards).toEqual(SAFEGUARDS);
  expect(requests[0]!.headers.get("anthropic-beta")).toContain("dangerous-tool-use-2026-09-03");
  const output = piMessageToInteractionOutput(message!, source, REQUEST);
  expect(output.safeguardResults).toEqual(SAFEGUARD_RESULTS);
  expect(output.items).toContainEqual(expect.objectContaining({ type: "tool_call", callId: "toolu_bash" }));
});

test("completions return Anthropic's safeguard results on the message", async () => {
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const { message } = await completeInteractionModel({
    model: "anthropic/claude-sonnet-4-6",
    request: { ...REQUEST, stream: false },
    apiKey: "sk-ant-api-test",
    fetch: anthropicFetch(requests),
  });

  expect(requests[0]!.body.safeguards).toEqual(SAFEGUARDS);
  expect(message.safeguardResults).toEqual(SAFEGUARD_RESULTS);
});

test("safeguards stay off requests that are not served by Anthropic's API", async () => {
  const options = buildOptions(REQUEST, "sk-test", "openai/gpt-5.5-pro", modelFixtures["openai/gpt-5.5-pro"]!, piFixture);
  const onPayload = options.onPayload as ((payload: unknown) => unknown) | undefined;
  const patched = await onPayload?.({ model: "gpt-5.5-pro", input: [] });
  expect(JSON.stringify(patched ?? {})).not.toContain("safeguards");
});

test("fast mode keeps the safeguards beta alongside its own", async () => {
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const { events } = await streamInteractionModel({
    model: "anthropic/claude-opus-4-8",
    request: REQUEST,
    apiKey: "sk-ant-api-test",
    config: {
      provider: "anthropic",
      native_model_id: "claude-opus-4-8",
      api: "anthropic-messages",
      base_url: "https://api.anthropic.com",
      context_window: 1_000_000,
      supported_thinking_levels: ["off", "high"],
      supports_managed_key: true,
      cost: { input: 5, output: 25 },
      fast_mode: true,
      fast_mode_cost: { input: 10, output: 50 },
    },
    fetch: anthropicFetch(requests),
  });
  for await (const _ of events) { /* drain */ }

  const betas = requests[0]!.headers.get("anthropic-beta")!.split(",");
  expect(betas).toContain("fast-mode-2026-02-01");
  expect(betas).toContain("dangerous-tool-use-2026-09-03");
  expect(requests[0]!.body.safeguards).toEqual(SAFEGUARDS);
});
