import { expect, test } from "bun:test";

import { CUSTOM_RULES_PROMPT, SELECTOR_SYSTEM_PROMPT } from "../src/prompts.js";
import { buildSelectorRequest, buildSizedSelectorRequest } from "../src/selector_request.js";
import { selectorSafeMessages } from "../src/selector_input.js";
import type { ChatMessage, RoutingCandidate } from "../src/types.js";

const CANDIDATES: RoutingCandidate[] = [
  { model: "openai/gpt-4.1-mini", reasoningEffort: "medium" },
];

function build(messages: ChatMessage[], contextWindowChars: number) {
  return buildSizedSelectorRequest({
    candidates: CANDIDATES,
    selectorModel: "selector/model",
    contextWindowChars,
    messages,
  });
}

test("small conversations pass through untrimmed", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
  const built = build(messages, 100_000);
  expect(built.selectorInput.messages).toEqual(messages);
  expect(built.selectorRequest.messages?.[0]?.role).toBe("system");
  expect(built.selectorRequest.response_format?.type).toBe("json_schema");
});

test("oversized conversations trim oldest messages first", () => {
  const built = build(
    [
      { role: "user", content: "x".repeat(24_000) },
      { role: "assistant", content: "old reply" },
      { role: "user", content: "the question that matters" },
    ],
    4_000,
  );
  const sent = built.selectorInput.messages;
  expect(String(sent[0]?.content)).toBe("<earlier messages truncated for routing>");
  expect(sent.some((message) => String(message.content).includes("the question that matters"))).toBe(true);
  expect(sent.some((message) => String(message.content).includes("x".repeat(16_000)))).toBe(false);
});

test("trimming drops older agent turns before the user's earlier requests", () => {
  const built = build(
    [
      { role: "user", content: "first request: add the billing export" },
      { role: "assistant", content: "y".repeat(20_000) },
      { role: "assistant", content: "old reply" },
      { role: "user", content: "follow-up: also cover refunds" },
      { role: "assistant", content: "latest agent turn" },
    ],
    6_000,
  );
  const sent = JSON.stringify(built.selectorInput.messages);
  expect(JSON.stringify(built.selectorRequest.messages).length).toBeLessThanOrEqual(6_000);
  expect(sent).toContain("first request: add the billing export");
  expect(sent).toContain("follow-up: also cover refunds");
  expect(sent).toContain("latest agent turn");
  expect(sent).not.toContain("y".repeat(100));
});

test("an oversized single message keeps its tail", () => {
  const built = build([{ role: "user", content: `start-${"x".repeat(300_000)}-end` }], 65_536 * 4);

  expect(JSON.stringify(built.selectorRequest.messages).length).toBeLessThanOrEqual(65_536 * 4);
  expect(String(built.selectorInput.messages[0]?.content)).toStartWith(
    "<earlier messages truncated for routing>",
  );
  expect(String(built.selectorInput.messages[0]?.content)).toEndWith("-end");
});

test("throws a configuration error when trimming cannot converge", () => {
  expect(() => build([{ role: "user", content: "hello" }], 10)).toThrow(
    "Selector prompt cannot fit configured context window for selector/model.",
  );
});

test("image bytes never reach the selector serialization", () => {
  const dataUrl = `data:image/png;base64,${"A".repeat(5000)}`;
  const messages = selectorSafeMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "what is in this image?" },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ]);
  const built = build(messages, 100_000);
  const serialized = JSON.stringify(built.selectorInput.messages);
  expect(serialized).toContain("<image omitted>");
  expect(serialized).not.toContain("A".repeat(100));
});

test("numbered selector image placeholders survive scrubbing", () => {
  const messages = selectorSafeMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "transcribe this page" },
        { type: "image_url", image_url: { url: "<image 1>", detail: "high" } },
        { type: "image_url", image_url: { url: "https://example.com/page.png" } },
      ],
    },
  ]);
  expect(messages[0]?.content).toEqual([
    { type: "text", text: "transcribe this page" },
    { type: "image_url", image_url: { url: "<image 1>", detail: "high" } },
    { type: "image_url", image_url: { url: "<image omitted>" } },
  ]);
});

test("custom rules append the rules addendum to the shared selector prompt", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
  const plain = buildSelectorRequest({ candidates: CANDIDATES, selectorModel: "selector/model", messages });
  const custom = buildSelectorRequest({
    candidates: CANDIDATES,
    selectorModel: "selector/model",
    messages,
    customRules: [{ when: "planning", use: "openai/gpt-4.1-mini", thinking_level: null }],
    defaultTarget: null,
  });

  expect(plain.selectorRequest.messages?.[0]?.content).toBe(SELECTOR_SYSTEM_PROMPT);
  expect(custom.selectorRequest.messages?.[0]?.content).toBe(
    `${SELECTOR_SYSTEM_PROMPT}\n\n${CUSTOM_RULES_PROMPT}`,
  );
  expect(custom.selectorInput).toMatchObject({
    custom_rules: [{ when: "planning", use: "openai/gpt-4.1-mini", thinking_level: null }],
    default_target: null,
  });
});
