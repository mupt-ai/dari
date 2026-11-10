import { expect, test } from "bun:test";

import {
  canonicalMessage,
  conversationBlockCount,
  extendChain,
  headHash,
  messageBlockCount,
  optionsFingerprints,
  prefixChain,
  stableStringify,
} from "../src/fingerprint.js";
import type { ChatCompletionRequest } from "../src/types.js";

const ROUTER = "rtr_test";

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: "dari/routing",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" },
    ],
    ...overrides,
  };
}

test("chain is deterministic and extends without changing earlier hashes", () => {
  const turn1 = prefixChain(ROUTER, request());
  expect(turn1).toEqual(prefixChain(ROUTER, request()));
  expect(turn1).toHaveLength(1);

  const assistant = { role: "assistant", content: "hi there" };
  const entryHash = extendChain(turn1[0], assistant);

  const turn2 = prefixChain(
    ROUTER,
    request({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "next question" },
      ],
    })
  );
  expect(turn2).toHaveLength(3);
  expect(turn2[0]).toBe(turn1[0]);
  expect(turn2[1]).toBe(entryHash);
});

test("mid-conversation system notes extend without reseeding the prefix", () => {
  const first = prefixChain(ROUTER, request({
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ],
  }));
  const replay = prefixChain(ROUTER, request({
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "system", content: "<total_tokens>1000 tokens left</total_tokens>" },
      { role: "user", content: "next question" },
    ],
  }));

  expect(replay.slice(0, first.length)).toEqual(first);
  expect(replay).toHaveLength(first.length + 1);
});

test("head hash is sensitive to router, system prompt, and tools", () => {
  const base = headHash(ROUTER, request());
  expect(headHash("rtr_other", request())).not.toBe(base);
  expect(
    headHash(ROUTER, request({ messages: [{ role: "system", content: "Different." }, { role: "user", content: "hello" }] }))
  ).not.toBe(base);
  expect(
    headHash(
      ROUTER,
      request({ tools: [{ type: "function", function: { name: "lookup" } }] })
    )
  ).not.toBe(base);
});

test("chain ignores sampling and option knobs", () => {
  const base = prefixChain(ROUTER, request());
  expect(prefixChain(ROUTER, request({ temperature: 0.9, top_p: 0.5, max_tokens: 32 }))).toEqual(base);
  expect(prefixChain(ROUTER, request({ tool_choice: "required" }))).toEqual(base);
  expect(
    prefixChain(ROUTER, request({ response_format: { type: "json_object" } }))
  ).toEqual(base);
});

test("options fingerprints react to their own knob only", () => {
  const base = optionsFingerprints(request());
  const toolChoiceFlip = optionsFingerprints(request({ tool_choice: "required" }));
  expect(toolChoiceFlip.tool_choice_fp).not.toBe(base.tool_choice_fp);
  expect(toolChoiceFlip.response_format_fp).toBe(base.response_format_fp);

  const formatFlip = optionsFingerprints(request({ response_format: { type: "json_object" } }));
  expect(formatFlip.response_format_fp).not.toBe(base.response_format_fp);
  expect(formatFlip.tool_choice_fp).toBe(base.tool_choice_fp);
});

test("edited history produces a different chain", () => {
  const original = prefixChain(
    ROUTER,
    request({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "next" },
      ],
    })
  );
  const edited = prefixChain(
    ROUTER,
    request({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello edited" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "next" },
      ],
    })
  );
  expect(edited[0]).not.toBe(original[0]);
  expect(edited[1]).not.toBe(original[1]);
});

test("string tool arguments stay byte-exact while objects canonicalize", () => {
  const stringArgs = canonicalMessage({
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "f", arguments: '{"b":1,"a":2}' } },
    ],
  });
  const reorderedStringArgs = canonicalMessage({
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "f", arguments: '{"a":2,"b":1}' } },
    ],
  });
  // Different argument bytes mean a different provider prompt: must differ.
  expect(stringArgs).not.toBe(reorderedStringArgs);

  const objectArgs = canonicalMessage({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_1", function: { name: "f", arguments: { b: 1, a: 2 } } }],
  });
  const reorderedObjectArgs = canonicalMessage({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_1", function: { name: "f", arguments: { a: 2, b: 1 } } }],
  });
  expect(objectArgs).toBe(reorderedObjectArgs);
});

test("stableStringify sorts keys recursively", () => {
  expect(stableStringify({ b: [{ d: 1, c: 2 }], a: "x" })).toBe('{"a":"x","b":[{"c":2,"d":1}]}');
});

test("block count approximates Anthropic content blocks", () => {
  expect(messageBlockCount({ role: "user", content: "hello" })).toBe(1);
  expect(
    messageBlockCount({
      role: "user",
      content: [
        { type: "text", text: "look:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
      ],
    })
  ).toBe(2);
  expect(
    messageBlockCount({
      role: "assistant",
      content: "calling tools",
      tool_calls: [
        { id: "a", function: { name: "f" } },
        { id: "b", function: { name: "g" } },
      ],
    })
  ).toBe(3);
  expect(messageBlockCount({ role: "tool", tool_call_id: "a", content: "result" })).toBe(1);
  expect(messageBlockCount({ role: "assistant", content: "" })).toBe(1);

  expect(
    conversationBlockCount({
      messages: [
        { role: "system", content: "ignored" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi", tool_calls: [{ id: "a", function: { name: "f" } }] },
        { role: "tool", tool_call_id: "a", content: "out" },
      ],
    })
  ).toBe(4);
});
