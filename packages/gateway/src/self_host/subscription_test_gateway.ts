import { Database } from "bun:sqlite";
import { expect } from "bun:test";

import { anthropicReply, startStubGateway } from "./stub_gateway.js";
import { secretBoxFromEnv } from "./secret_box.js";
import { SubscriptionStore } from "./subscriptions/index.js";

export { anthropicReply };

/**
 * A stub gateway (see stub_gateway.ts) serving two Claude Code plans (access
 * tokens `sk-ant-oat01-a` and `-b`) against a local stand-in for Anthropic,
 * with a helper for Claude Code requests. `upstream` answers each provider
 * call given the plan's token and the native model it asks for. The router
 * lists `models`. The plans are the gateway owner's, which serve the gateway
 * key, or with `owner: "link_user"` the approval page's user's.
 */
export async function startSubscriptionGateway(
  upstream: (token: string, model: string) => Response,
  models: string[] = ["anthropic/claude-sonnet-5-5"],
  owner: "link_user" | "gateway" = "gateway",
) {
  const gateway = await startStubGateway({
    plans: ["anthropic_claude_code", "anthropic_claude_code"],
    owner,
    models,
    upstream: ({ token, model }) => upstream(token, model),
  });
  const { baseUrl } = gateway;
  return {
    baseUrl,
    served: gateway.served,
    planIds: gateway.planIds,
    userCookie: gateway.userCookie,
    // The plans as the gateway stored them.
    plan: (id: string) => new SubscriptionStore(new Database(gateway.dbPath), secretBoxFromEnv(gateway.encryptionKey)).get(id),
    // One Claude Code request in the conversation `sessionId` starts, for
    // `model` or, by default, routed, with the gateway key or `key`.
    claudeCode: async (sessionId: string, text: string, model = "dari/model/anthropic/claude-sonnet-5-5", key = "k") =>
      await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "user-agent": "claude-cli/2.1.300 (external, cli)",
          "x-app": "cli",
          "x-claude-code-session-id": sessionId,
        },
        body: JSON.stringify({
          model,
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: text }],
        }),
      }),
    stop: gateway.stop,
  };
}

export async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(condition()).toBe(true);
}
