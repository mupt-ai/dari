import { expect, test } from "bun:test";

import {
  providerFailureFromCaught,
  providerFailureMessage,
} from "./provider_stream_outcome.js";

test("scrubs provider failure details before exposing them", () => {
  expect(
    providerFailureMessage({
      errorMessage: "503 provider overloaded with sk-streamsecret9876",
    }),
  ).toBe("503 provider overloaded with sk-…");
});

test("preserves structured provider failure details for reporting", () => {
  expect(
    providerFailureFromCaught({
      status: 502,
      code: "provider_configuration_error",
      error: { message: "No base URL is configured" },
    }),
  ).toEqual({
    stopReason: "error",
    errorMessage: "Provider request failed.",
    content: [],
    status: 502,
    code: "provider_configuration_error",
    error: { message: "No base URL is configured" },
  });
});
