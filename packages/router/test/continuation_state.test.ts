import { expect, test } from "bun:test";

import {
  compatibleProviderContinuation,
  decodeUntrustedProviderContinuationState,
  encodeProviderContinuationState,
  sameProviderIdentity,
  type ProviderContinuationState,
} from "../src/continuation_state.js";

const OPENAI_SOURCE = { provider: "openai", api: "openai-responses", model: "openai/gpt-5.4" };
const ANTHROPIC_SOURCE = { provider: "anthropic", api: "anthropic-messages", model: "anthropic/claude-opus-4-6" };

test("continuation state round-trips through the dari-pcs-v1 envelope", () => {
  const state: ProviderContinuationState = {
    kind: "openai_reasoning",
    source: OPENAI_SOURCE,
    encryptedContent: "encrypted-openai-state",
    providerItemId: "rs_1",
    hostedToolCallIds: ["call_a", "call_b"],
    hostedToolCallOffsets: [10, -20],
  };
  const encoded = encodeProviderContinuationState(state);
  expect(encoded.startsWith("dari-pcs-v1.")).toBe(true);
  expect(decodeUntrustedProviderContinuationState(encoded)).toEqual(state);
});

test("anthropic thinking and redacted continuations round-trip", () => {
  const thinking: ProviderContinuationState = {
    kind: "anthropic_thinking",
    source: ANTHROPIC_SOURCE,
    thinking: "Inspect first.",
    signature: "anthropic-signature",
  };
  const redacted: ProviderContinuationState = {
    kind: "anthropic_redacted_thinking",
    source: ANTHROPIC_SOURCE,
    data: "redacted-blob",
  };
  expect(decodeUntrustedProviderContinuationState(encodeProviderContinuationState(thinking))).toEqual(thinking);
  expect(decodeUntrustedProviderContinuationState(encodeProviderContinuationState(redacted))).toEqual(redacted);
});

test("anthropic continuations carry the effort their turn was generated under", () => {
  const thinking: ProviderContinuationState = {
    kind: "anthropic_thinking",
    source: ANTHROPIC_SOURCE,
    thinking: "Inspect first.",
    signature: "anthropic-signature",
    effort: "high",
  };
  const redacted: ProviderContinuationState = {
    kind: "anthropic_redacted_thinking",
    source: ANTHROPIC_SOURCE,
    data: "redacted-blob",
    effort: "low",
  };
  expect(decodeUntrustedProviderContinuationState(encodeProviderContinuationState(thinking))).toEqual(thinking);
  expect(decodeUntrustedProviderContinuationState(encodeProviderContinuationState(redacted))).toEqual(redacted);

  const forged = `dari-pcs-v1.${Buffer.from(JSON.stringify({
    v: 1,
    kind: "anthropic_thinking",
    source: ANTHROPIC_SOURCE,
    state: { thinking: "x", signature: "sig", effort: "turbo" },
  })).toString("base64url")}`;
  expect(() => decodeUntrustedProviderContinuationState(forged)).toThrow("effort is invalid");
});

test("non-Dari provider state decodes to null without throwing", () => {
  expect(decodeUntrustedProviderContinuationState("provider-native-ciphertext")).toBeNull();
});

test("compatibleProviderContinuation only replays to the same provider api", () => {
  const openai: ProviderContinuationState = {
    kind: "openai_reasoning",
    source: OPENAI_SOURCE,
    encryptedContent: "x",
  };
  expect(compatibleProviderContinuation(openai, OPENAI_SOURCE)).toEqual(openai);
  expect(compatibleProviderContinuation(openai, ANTHROPIC_SOURCE)).toBeNull();
  expect(compatibleProviderContinuation(openai, { ...OPENAI_SOURCE, api: "openai-completions" })).toBeNull();
});

test("ChatGPT-subscription Codex reasoning replays to its own Responses transport only", () => {
  const codexSource = { provider: "openai-codex", api: "openai-codex-responses", model: "openai/gpt-5.6-luna" };
  const codex: ProviderContinuationState = {
    kind: "openai_reasoning",
    source: codexSource,
    encryptedContent: "x",
  };
  expect(compatibleProviderContinuation(codex, codexSource)).toEqual(codex);
  expect(compatibleProviderContinuation(codex, OPENAI_SOURCE)).toBeNull();
  expect(compatibleProviderContinuation(codex, { ...codexSource, api: "openai-completions" })).toBeNull();
});

test("Bedrock-sourced Anthropic thinking replays to the same Bedrock identity only", () => {
  const bedrockSource = {
    provider: "amazon-bedrock",
    api: "bedrock-converse-stream",
    model: "global.anthropic.claude-sonnet-5",
  };
  const thinking: ProviderContinuationState = {
    kind: "anthropic_thinking",
    source: bedrockSource,
    thinking: "chain",
    signature: "sig",
  };
  expect(compatibleProviderContinuation(thinking, bedrockSource)).toEqual(thinking);
  expect(compatibleProviderContinuation(thinking, ANTHROPIC_SOURCE)).toBeNull();
  expect(
    compatibleProviderContinuation(thinking, { ...bedrockSource, model: "other" })
  ).toBeNull();
});

test("sameProviderIdentity compares provider, api, and model", () => {
  expect(sameProviderIdentity(OPENAI_SOURCE, OPENAI_SOURCE)).toBe(true);
  expect(sameProviderIdentity(OPENAI_SOURCE, { ...OPENAI_SOURCE, model: "other" })).toBe(false);
});
