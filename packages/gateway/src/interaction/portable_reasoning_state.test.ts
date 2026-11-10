import { expect, test } from "bun:test";

import { HttpError } from "../http/errors.js";
import {
  decodeUntrustedPortableReasoningState,
  encodePortableReasoningState,
} from "./portable_reasoning_state.js";

const source = {
  provider: "fireworks",
  api: "openai-completions",
  model: "accounts/fireworks/models/glm-5p2",
};

test("portable reasoning state is deterministic and round-trips provenance", () => {
  const state = { source, itemId: "reasoning_1" };
  const encoded = encodePortableReasoningState(state);

  expect(encoded).toStartWith("dari-ir-v1.");
  expect(encodePortableReasoningState(state)).toBe(encoded);
  expect(decodeUntrustedPortableReasoningState(encoded)).toEqual(state);
});

test("portable reasoning state rejects malformed Dari envelopes and ignores provider-native state", () => {
  expect(decodeUntrustedPortableReasoningState("provider-native-signature")).toBeNull();
  expect(() => decodeUntrustedPortableReasoningState("dari-ir-v2.e30")).toThrow("version is not supported");
  expect(() => decodeUntrustedPortableReasoningState("dari-ir-v1.e30")).toThrow("schema is invalid");
});

test("portable reasoning decode failures surface the hosted 400 contract", () => {
  let thrown: unknown;
  try {
    decodeUntrustedPortableReasoningState("dari-ir-v2.e30");
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(HttpError);
  expect(thrown).toMatchObject({ status: 400, code: "invalid_provider_continuation_state" });
});
