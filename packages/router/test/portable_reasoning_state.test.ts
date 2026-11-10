import { expect, test } from "bun:test";

import {
  decodeUntrustedPortableReasoningState,
  encodePortableReasoningState,
  type PortableReasoningState,
} from "../src/portable_reasoning_state.js";
import { RouterFrameworkError } from "../src/framework_error.js";

const SOURCE = { provider: "openai", api: "openai-responses", model: "openai/gpt-5.4" };

test("portable reasoning state round-trips through the dari-ir-v1 envelope", () => {
  const state: PortableReasoningState = { source: SOURCE, itemId: "rs_1" };
  const encoded = encodePortableReasoningState(state);
  expect(encoded.startsWith("dari-ir-v1.")).toBe(true);
  expect(encodePortableReasoningState(state)).toBe(encoded);
  expect(decodeUntrustedPortableReasoningState(encoded)).toEqual(state);
});

test("empty portable reasoning state round-trips without optional fields", () => {
  expect(decodeUntrustedPortableReasoningState(encodePortableReasoningState({}))).toEqual({});
});

test("non-Dari provider state decodes to null without throwing", () => {
  expect(decodeUntrustedPortableReasoningState("provider-native-signature")).toBeNull();
});

test("unsupported dari-ir versions fail as invalid requests", () => {
  const thrown = decodeError("dari-ir-v2.e30");
  expect(thrown.kind).toBe("invalid_request");
  expect(thrown.message).toBe("Portable reasoning state version is not supported.");
});

test.each([
  "dari-ir-v1.",
  "dari-ir-v1.not+padded=",
  "dari-ir-v1.e30",
  encodedEnvelope({ v: 2 }),
  encodedEnvelope({ v: 1, extra: true }),
  encodedEnvelope({ v: 1, source: { provider: "openai" } }),
  encodedEnvelope({ v: 1, id: "" }),
  encodedEnvelope({ v: 1, id: "x".repeat(513) }),
])("malformed dari-ir envelopes fail as invalid requests: %s", (encoded) => {
  const thrown = decodeError(encoded);
  expect(thrown.kind).toBe("invalid_request");
  expect(thrown.code).toBe("invalid_provider_continuation_state");
});

test("encoded portable state is bounded before decoding", () => {
  const thrown = decodeError(`dari-ir-v1.${"A".repeat(8_192)}`);
  expect(thrown.kind).toBe("invalid_request");
  expect(thrown.message).toBe("Portable reasoning state encoding is invalid.");
});

test("encode-side validation failures are configuration errors, not client errors", () => {
  let thrown: unknown;
  try {
    encodePortableReasoningState({ itemId: "x".repeat(513) });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RouterFrameworkError);
  expect((thrown as RouterFrameworkError).kind).toBe("configuration");

  try {
    encodePortableReasoningState({
      source: { ...SOURCE, provider: "" },
    });
  } catch (error) {
    thrown = error;
  }
  expect((thrown as RouterFrameworkError).kind).toBe("configuration");
});

function decodeError(encoded: string): RouterFrameworkError {
  let thrown: unknown;
  try {
    decodeUntrustedPortableReasoningState(encoded);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RouterFrameworkError);
  return thrown as RouterFrameworkError;
}

function encodedEnvelope(value: unknown): string {
  return `dari-ir-v1.${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}
