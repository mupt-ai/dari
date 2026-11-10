import { expect, test } from "bun:test";

import type { InteractionRequest } from "../../interaction/types.js";
import { encodeRetainedInteractionRequest } from "./retained_interaction_request.js";

test("serializes the normalized interaction without projecting it through Chat", () => {
  const request: InteractionRequest = {
    sourceProtocol: "openai_responses",
    agentContext: { requestClass: "auxiliary" },
    model: "dari/routing",
    instructions: "Use the repository tools.",
    items: [
      {
        type: "message",
        id: "msg_1",
        role: "user",
        content: [
          { type: "text", text: "Inspect this image." },
          { type: "image", url: "data:image/png;base64,AA==", detail: "low" },
        ],
        contentShape: "parts",
      },
      {
        type: "reasoning",
        id: "rs_1",
        summary: ["Inspect the input."],
        content: [],
        source: {
          provider: "openai",
          api: "openai-responses",
          model: "gpt-5.6-sol",
        },
        continuation: {
          kind: "openai_reasoning",
          source: {
            provider: "openai",
            api: "openai-responses",
            model: "gpt-5.6-sol",
          },
          encryptedContent: "opaque-state",
          providerItemId: "rs_1",
        },
      },
      {
        type: "tool_result",
        callId: "call_1",
        kind: "function",
        name: "read_file",
        output: "file contents",
        outputShape: "string",
      },
    ],
    tools: [{
      kind: "function",
      name: "read_file",
      description: "Read a file.",
      parameters: { type: "object" },
    }],
    toolChoice: "auto",
    parallelToolCalls: true,
    generation: { maxOutputTokens: 1000 },
    reasoning: { effort: "high", enabled: true },
    promptCacheKey: "session-cache-key",
    stream: true,
    metadata: { trace: "retained-metadata" },
    user: "client-user",
  };

  const encoded = encodeRetainedInteractionRequest(request);

  expect(encoded.format).toBe("interaction_request_v1");
  expect(JSON.parse(encoded.json)).toEqual(request);
});
