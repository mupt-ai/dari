import { expect, test } from "bun:test";

import type { ProviderIdentity } from "./types.js";
import { providerToolCallId, providerToolCallIdentity } from "./tool_identity.js";

const OPENAI_RESPONSES: ProviderIdentity = {
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.5",
};

test("round-trips Responses call and item IDs", () => {
  const id = providerToolCallId("call_123", "fc_123", OPENAI_RESPONSES.api);

  expect(id).toBe("call_123|fc_123");
  expect(providerToolCallId("call_123", "fc_123", "azure-openai-responses")).toBe("call_123|fc_123");
  expect(providerToolCallIdentity(id, OPENAI_RESPONSES)).toEqual({
    callId: "call_123",
    itemId: "fc_123",
  });
});

test("does not add Responses item IDs to other provider APIs", () => {
  const anthropic = {
    provider: "anthropic",
    api: "anthropic-messages",
    model: "claude-sonnet-4-6",
  };

  expect(providerToolCallId("call_123", "fc_123", anthropic.api)).toBe("call_123");
  expect(providerToolCallId("call_123", "fc_123", null)).toBe("call_123");
});

test("allows the maximum protocol call ID inside a longer Responses provider ID", () => {
  const callId = "c".repeat(512);

  expect(providerToolCallIdentity(`${callId}|fc_123`, OPENAI_RESPONSES)).toEqual({
    callId,
    itemId: "fc_123",
  });
});
