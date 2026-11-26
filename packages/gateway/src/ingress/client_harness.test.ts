import { expect, test } from "bun:test";

import { HttpError } from "../http/errors.js";
import { createRequestHandler } from "../http/handler.js";
import { createPrioritySelectorBackend } from "../strategies/priority_selector.js";
import { testPlatform } from "../test_support/platform.js";
import type { ClientHarness } from "../types.js";

const THREAD_ID = "019f930c-ba2d-7882-8dda-db915556b698";
const CHAT = { model: "dari/routing", messages: [{ role: "user", content: "hello" }] };
const MESSAGES = { ...CHAT, max_tokens: 16 };
const ANTHROPIC = { "x-api-key": "k", "anthropic-version": "2023-06-01" };

// The platform serves a coding agent its own models and plans by the client
// harness each resolve names. A request names the agent its own headers show.
// `x-dari-client-harness` is only a claim: it names the agent for a model
// list, and for a request only an agent no subscription is limited to.
test("each resolve names the coding agent the request comes from", async () => {
  const resolved: (ClientHarness | undefined)[] = [];
  const handler = createRequestHandler({
    platform: testPlatform({
      async resolveRouter(request) {
        resolved.push(request.clientHarness);
        throw new HttpError(401, "Stop after resolution.", "authentication_error");
      },
    }),
    selectorBackend: createPrioritySelectorBackend(),
  });
  const named = async (path: string, headers: Record<string, string>, body?: unknown) => {
    resolved.length = 0;
    const response = await handler(new Request(`http://gateway${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer k", "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    expect(response.status).toBe(401);
    expect(resolved.length).toBeGreaterThan(0);
    return [...new Set(resolved)];
  };

  expect(await named(
    "/v1/responses",
    { "thread-id": THREAD_ID, "x-codex-turn-metadata": JSON.stringify({ thread_id: THREAD_ID }) },
    { model: "dari/routing", input: "hello" },
  )).toEqual(["codex"]);
  expect(await named("/v1/chat/completions", { "x-pi-session-id": "pi-session" }, CHAT)).toEqual(["pi"]);
  expect(await named("/v1/chat/completions", { "x-opencode-session-id": "ses_1" }, CHAT)).toEqual(["opencode"]);
  expect(await named("/v1/chat/completions", { "x-dari-client-harness": "hermes" }, CHAT)).toEqual(["hermes"]);
  expect(await named("/v1/messages", { "x-dari-client-harness": "openclaw", ...ANTHROPIC }, MESSAGES)).toEqual(["openclaw"]);
  expect(await named("/v1/chat/completions", {}, CHAT)).toEqual([undefined]);

  // An agent is the same agent on an API it does not speak itself: a gateway
  // connected to hosted Dari passes its headers on over the served model's API.
  const claudeCode = { "user-agent": "claude-cli/2.1.300 (external, cli)", "x-app": "cli", "x-claude-code-session-id": THREAD_ID };
  expect(await named("/v1/messages", { ...claudeCode, ...ANTHROPIC }, MESSAGES)).toEqual(["claude_code"]);
  expect(await named("/v1/responses", claudeCode, { model: "dari/routing", input: "hello" })).toEqual(["claude_code"]);
  expect(await named(
    "/v1/messages",
    { "thread-id": THREAD_ID, "x-codex-turn-metadata": JSON.stringify({ thread_id: THREAD_ID }), ...ANTHROPIC },
    MESSAGES,
  )).toEqual(["codex"]);
  expect(await named("/v1/messages", { "x-opencode-session-id": "ses_1", ...ANTHROPIC }, MESSAGES)).toEqual(["opencode"]);
  expect(await named("/v1/responses", { "x-opencode-session-id": "ses_1" }, { model: "dari/routing", input: "hello" })).toEqual(["opencode"]);
  expect(await named("/v1/responses", { "x-pi-session-id": "pi-session" }, { model: "dari/routing", input: "hello" })).toEqual(["pi"]);
  expect(await named("/v1/messages", { "x-client-id": "tbh:exec", ...ANTHROPIC }, MESSAGES)).toEqual(["muse_code"]);

  // Claiming to be Claude Code does not make a request Claude Code's.
  expect(await named("/v1/chat/completions", { "x-dari-client-harness": "claude_code" }, CHAT)).toEqual([undefined]);
  expect(await named("/v1/messages", { "x-dari-client-harness": "claude_code", ...ANTHROPIC }, MESSAGES)).toEqual([undefined]);

  // A model list is for whichever agent the header names.
  expect(await named("/v1/models", { "x-dari-client-harness": "claude_code" })).toEqual(["claude_code"]);
  expect(await named("/v1/models", { "x-dari-client-harness": "codex" })).toEqual(["codex"]);
  expect(await named("/v1/models", { "x-dari-client-harness": "anything" })).toEqual([undefined]);
});
