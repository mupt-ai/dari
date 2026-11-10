import { expect, test } from "bun:test";

import type { InteractionPrefixContext } from "./interaction_fingerprint.js";
import {
  promptMetrics,
  providerPromptAccounting,
} from "./provider_prompt_accounting.js";
import type { InteractionRequest, ProviderIdentity } from "../interaction/types.js";

const OPENAI_MODEL = "openai/gpt-5.5";
const CLAUDE_MODEL = "anthropic/claude-sonnet-4-6";
const OPENAI: ProviderIdentity = {
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.5",
};
const CLAUDE: ProviderIdentity = {
  provider: "anthropic",
  api: "anthropic-messages",
  model: "claude-sonnet-4-6",
};

function reasoningToolLoop(): InteractionRequest {
  return {
    sourceProtocol: "openai_responses",
    items: [
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Inspect the repository." }],
        contentShape: "parts",
      },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        content: [],
        continuation: {
          kind: "openai_reasoning",
          source: OPENAI,
          encryptedContent: "opaque-openai-state",
        },
      },
      {
        type: "tool_call",
        id: "fc_1",
        callId: "call_1",
        kind: "function",
        name: "read_file",
        input: { path: "README.md" },
      },
      {
        type: "tool_result",
        callId: "call_1",
        kind: "function",
        name: "read_file",
        output: "contents",
        outputShape: "string",
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Continue." }],
        contentShape: "parts",
      },
    ],
    tools: [
      {
        kind: "function",
        name: "read_file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ],
    generation: {},
    stream: true,
  };
}

function prefixContext(
  request: InteractionRequest,
): InteractionPrefixContext {
  return {
    chainByModel: new Map([
      [OPENAI_MODEL, ["openai-h1", "openai-h2", "openai-h3"]],
      [CLAUDE_MODEL, ["claude-h1", "claude-h2", "claude-h3"]],
    ]),
    itemIndexByHashByModel: new Map([
      [
        OPENAI_MODEL,
        new Map([
          ["openai-h1", 0],
          ["openai-h2", 2],
          ["openai-h3", 3],
        ]),
      ],
      [
        CLAUDE_MODEL,
        new Map([
          ["claude-h1", 0],
          ["claude-h2", 2],
          ["claude-h3", 3],
        ]),
      ],
    ]),
    looseChain: [],
    fingerprints: {
      tool_choice_fp: "tool-choice",
      response_format_fp: "response-format",
    },
  };
}

test("uses candidate-visible continuation state for block and size accounting", () => {
  const request = reasoningToolLoop();
  const openAI = promptMetrics(request, OPENAI);
  const claude = promptMetrics(request, CLAUDE);

  expect(openAI.blockDepth).toBe(5);
  expect(claude.blockDepth).toBe(4);
  expect(openAI.serializedChars).not.toBe(claude.serializedChars);
});

test("computes an anchored tail from the same candidate-visible projection", () => {
  const request = reasoningToolLoop();
  const prefix = prefixContext(request);
  const accounting = providerPromptAccounting({
    request,
    prefix,
    targetsByModel: new Map([
      [OPENAI_MODEL, OPENAI],
      [CLAUDE_MODEL, CLAUDE],
    ]),
  });

  const full = promptMetrics(request, OPENAI).serializedChars;
  const throughToolCall = promptMetrics(
    { ...request, items: request.items.slice(0, 3) },
    OPENAI,
  ).serializedChars;

  expect(
    accounting.promptEstimateFor(OPENAI_MODEL, {
      hash: "openai-h2",
      depth: 2,
    }),
  ).toEqual({
    chars: full - throughToolCall,
    reusesStoredPromptTokens: true,
  });
  expect(accounting.providerBlockDepthFor(OPENAI_MODEL)).toBe(5);
  expect(accounting.providerBlockDepthFor(CLAUDE_MODEL)).toBe(4);
});

test("uses the full provider-visible prompt when an anchor cannot be mapped", () => {
  const request = reasoningToolLoop();
  const accounting = providerPromptAccounting({
    request,
    prefix: {
      ...prefixContext(request),
      itemIndexByHashByModel: new Map(),
    },
    targetsByModel: new Map([[OPENAI_MODEL, OPENAI]]),
  });

  expect(
    accounting.promptEstimateFor(OPENAI_MODEL, {
      hash: "unknown-prefix",
      depth: 2,
    }),
  ).toEqual({
    chars: promptMetrics(request, OPENAI).serializedChars,
    reusesStoredPromptTokens: false,
  });
});

test("fails closed when a candidate has no provider target", () => {
  const request = reasoningToolLoop();
  const accounting = providerPromptAccounting({
    request,
    prefix: prefixContext(request),
    targetsByModel: new Map(),
  });

  expect(() => accounting.providerBlockDepthFor(OPENAI_MODEL)).toThrow(
    `missing provider target for ${OPENAI_MODEL}`,
  );
});

test("uses a bounded detail-aware estimate instead of raw image bytes", () => {
  const imageRequest = (data: string): InteractionRequest => ({
    sourceProtocol: "openai_chat",
    items: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image", url: `data:image/png;base64,${data}` },
        ],
        contentShape: "parts",
      },
    ],
    tools: [],
    generation: {},
    stream: false,
  });

  const small = promptMetrics(
    imageRequest(Buffer.from("a").toString("base64")),
    OPENAI,
  );
  const large = promptMetrics(
    imageRequest(Buffer.from("a".repeat(10_000)).toString("base64")),
    OPENAI,
  );

  expect(small).toEqual(large);
  expect(small.serializedChars).toBeGreaterThan(4_000);
});

test("tool arguments that resemble image records remain in prompt estimates", () => {
  const toolRequest = (data: string): InteractionRequest => ({
    sourceProtocol: "openai_responses",
    items: [
      {
        type: "tool_call",
        callId: "call_1",
        kind: "function",
        name: "store_record",
        input: { type: "image", data },
      },
    ],
    tools: [],
    generation: {},
    stream: false,
  });

  const small = promptMetrics(toolRequest("a"), OPENAI);
  const large = promptMetrics(toolRequest("a".repeat(10_000)), OPENAI);

  expect(large.serializedChars).toBeGreaterThan(small.serializedChars + 9_000);
});

test("counts hosted tools and response schemas visible in provider options", () => {
  const base = reasoningToolLoop();
  const plain = promptMetrics(base, OPENAI);
  const hosted = promptMetrics(
    {
      ...base,
      tools: [
        ...base.tools,
        {
          kind: "hosted",
          type: "web_search",
          config: {
            type: "web_search",
            filters: { allowed_domains: ["docs.example.com"] },
          },
        },
      ],
    },
    OPENAI,
  );
  const schema = promptMetrics(
    {
      ...base,
      responseFormat: {
        type: "json_schema",
        name: "large_result",
        schema: {
          type: "object",
          description: "x".repeat(10_000),
        },
      },
    },
    OPENAI,
  );

  expect(hosted.serializedChars).toBeGreaterThan(plain.serializedChars + 50);
  expect(schema.serializedChars).toBeGreaterThan(plain.serializedChars + 10_000);
});

test("counts only raw hosted history items, not Pi compatibility fields", () => {
  const payload = {
    type: "web_search_call",
    id: "ws_1",
    status: "completed",
  };
  const request: InteractionRequest = {
    sourceProtocol: "openai_responses",
    items: [
      {
        type: "hosted_tool_call",
        id: "ws_1",
        tool: "web_search",
        providerType: "web_search_call",
        payload,
        source: OPENAI,
      },
    ],
    tools: [],
    generation: {},
    stream: false,
  };

  const metrics = promptMetrics(request, OPENAI);
  const expected = JSON.stringify({
    messages: [{ role: "assistant", content: [payload] }],
  }).length;

  expect(metrics.serializedChars).toBe(expected);
});
