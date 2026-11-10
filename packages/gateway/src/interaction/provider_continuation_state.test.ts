import { expect, test } from "bun:test";

import { HttpError } from "../http/errors.js";
import {
  decodeUntrustedProviderContinuationState,
  encodeProviderContinuationState,
  providerIdentityFromModel,
} from "./provider_continuation_state.js";
import type { ProviderContinuationState } from "./types.js";

const states: ProviderContinuationState[] = [
  {
    kind: "openai_reasoning",
    source: { provider: "openai", api: "openai-responses", model: "gpt-5.5" },
    encryptedContent: "openai-opaque-state",
    providerItemId: "rs_provider",
    hostedToolCallIds: ["ws_search", "ws_open_page"],
    hostedToolCallOffsets: [-1, 2],
  },
  {
    kind: "anthropic_thinking",
    source: { provider: "anthropic", api: "anthropic-messages", model: "claude-fable-5" },
    thinking: "",
    signature: "anthropic-signature",
  },
  {
    kind: "anthropic_redacted_thinking",
    source: { provider: "anthropic", api: "anthropic-messages", model: "claude-fable-5" },
    data: "anthropic-redacted-state",
  },
];

test("provider continuation state encoding is deterministic and round-trips every supported kind", () => {
  for (const state of states) {
    const encoded = encodeProviderContinuationState(state);
    expect(encoded.startsWith("dari-pcs-v1.")).toBe(true);
    expect(encodeProviderContinuationState(state)).toBe(encoded);
    expect(decodeUntrustedProviderContinuationState(encoded)).toEqual(state);
  }
});

test("non-Dari opaque state is unknown and omitted", () => {
  expect(decodeUntrustedProviderContinuationState("provider-native-ciphertext")).toBeNull();
});

test("OpenAI continuation envelopes without provider item IDs remain valid", () => {
  expect(decodeUntrustedProviderContinuationState(encodedEnvelope({
    v: 1,
    kind: "openai_reasoning",
    source: { provider: "openai", api: "openai-responses", model: "gpt-5.5" },
    state: { encrypted_content: "openai-opaque-state" },
  }))).toEqual({
    kind: "openai_reasoning",
    source: { provider: "openai", api: "openai-responses", model: "gpt-5.5" },
    encryptedContent: "openai-opaque-state",
  });
});

test.each([
  "dari-pcs-v2.abc",
  "dari-pcs-v1.",
  "dari-pcs-v1.not+padded=",
  encodedEnvelope({ v: 1, kind: "openai_reasoning", source: {}, state: { encrypted_content: "x" } }),
  encodedEnvelope({
    v: 1,
    kind: "openai_reasoning",
    source: { provider: "openai", api: "openai-responses", model: "gpt-5.5" },
    state: { encrypted_content: "x", extra: "not allowed" },
  }),
  encodedEnvelope({
    v: 1,
    kind: "openai_reasoning",
    source: { provider: "openai", api: "openai-responses", model: "gpt-5.5" },
    state: { encrypted_content: "x", hosted_tool_call_ids: "not-json" },
  }),
  encodedEnvelope({
    v: 1,
    kind: "openai_reasoning",
    source: { provider: "openai", api: "openai-responses", model: "gpt-5.5" },
    state: { encrypted_content: "x", hosted_tool_call_offsets: "[1]" },
  }),
  encodedEnvelope({
    v: 1,
    kind: "openai_reasoning",
    source: { provider: "openai", api: "openai-responses", model: "gpt-5.5" },
    state: { encrypted_content: "x", hosted_tool_call_ids: "[\"ws_1\"]", hosted_tool_call_offsets: "[1,2]" },
  }),
  encodedEnvelope({
    v: 1,
    kind: "openai_reasoning",
    source: { provider: "openai", api: "openai-responses", model: "gpt-5.5" },
    state: { encrypted_content: "x", hosted_tool_call_ids: "[\"ws_1\"]", hosted_tool_call_offsets: "[0]" },
  }),
  encodedEnvelope({
    v: 1,
    kind: "anthropic_thinking",
    source: { provider: "anthropic", api: "anthropic-messages", model: "claude-fable-5" },
    state: { thinking: "summary", signature: "" },
  }),
])("malformed or unsupported Dari continuation envelopes fail explicitly", (encoded) => {
  let thrown: unknown;
  try {
    decodeUntrustedProviderContinuationState(encoded);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(HttpError);
  expect(thrown).toMatchObject({
    status: 400,
    code: "invalid_provider_continuation_state",
    param: "input.reasoning.encrypted_content",
  });
});

test("model metadata without provider identity fails as a 502 provider configuration error", () => {
  let thrown: unknown;
  try {
    providerIdentityFromModel({ id: "gpt-5.5" });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(HttpError);
  expect(thrown).toMatchObject({ status: 502, code: "provider_configuration_error" });
});

test("encoded continuation state is bounded before decoding", () => {
  expect(() => decodeUntrustedProviderContinuationState(`dari-pcs-v1.${"A".repeat(5_600_000)}`)).toThrow(
    "encoding is invalid"
  );
});

function encodedEnvelope(value: unknown): string {
  return `dari-pcs-v1.${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}
