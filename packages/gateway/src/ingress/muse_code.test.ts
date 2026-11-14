import { expect, test } from "bun:test";

import { subscriptionServes } from "../models/subscriptions.js";
import { museCodeConversationIdentity } from "../runtime/harness_identity/index.js";
import { museCodeClientId } from "./muse_code.js";

test("recognizes each Muse Code surface by its x-client-id", () => {
  for (const clientId of ["tbh:tui", "tbh:exec", "tbh:desktop", "TBH:Serve "]) {
    expect(museCodeClientId(new Headers({ "x-client-id": clientId }))).toBe(clientId.trim().toLowerCase());
  }
  expect(museCodeClientId(new Headers())).toBeUndefined();
  expect(museCodeClientId(new Headers({ "x-client-id": "opencode" }))).toBeUndefined();
});

test("a plan serves only its own provider's models, and only to the client its provider allows", () => {
  expect(subscriptionServes("meta_muse", "meta", "muse_code")).toBe(true);
  expect(subscriptionServes("meta_muse", "meta", undefined)).toBe(false);
  expect(subscriptionServes("meta_muse", "meta", "claude_code")).toBe(false);
  expect(subscriptionServes("meta_muse", "openai", "muse_code")).toBe(false);
  expect(subscriptionServes("anthropic_claude_code", "anthropic", "muse_code")).toBe(false);
  expect(subscriptionServes("openai_codex", "openai", "muse_code")).toBe(true);
  expect(subscriptionServes("openai_codex", "openai-codex", "codex")).toBe(true);
  expect(subscriptionServes("opencode_go", "opencode-go", "codex")).toBe(true);
  expect(subscriptionServes("opencode_go", "fireworks", "codex")).toBe(false);
});

test("a Muse Code thread is the conversation, and each subagent thread is its own", () => {
  const main = museCodeConversationIdentity(new Headers({ "x-tbh-thread-id": "01a19e05-b415-7cb0-a712-559a01d2dfd6" }));
  const subagent = museCodeConversationIdentity(new Headers({ "x-tbh-thread-id": "01a19e05-bbc6-7b61-ac36-3126deba72e9" }));
  expect(main).toEqual({ kind: "muse_code_thread", value: "01a19e05-b415-7cb0-a712-559a01d2dfd6" });
  expect(subagent?.value).not.toBe(main?.value);
  expect(museCodeConversationIdentity(new Headers())).toBeUndefined();
});
