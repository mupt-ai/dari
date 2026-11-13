import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SubscriptionStore } from "./subscriptions/index.js";
import { tokens } from "./subscriptions/test_support.js";

/**
 * A self-hosted gateway, run through its entrypoint as its own process so no
 * other test file's module mocks reach it, serving two Claude Code plans
 * (access tokens `sk-ant-oat01-a` and `-b`) against a local stand-in for
 * Anthropic. `upstream` answers each provider call given the plan's token
 * and the native model it asks for. The router lists `models`.
 */
export async function startSubscriptionGateway(
  upstream: (token: string, model: string) => Response,
  models: string[] = ["anthropic/claude-sonnet-5-5"],
) {
  const served: string[] = [];
  const provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      served.push(token);
      const body = await request.json() as { model?: string };
      return upstream(token, body.model ?? "");
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "dari-gateway-plans-"));
  const dbPath = join(dir, "gateway.db");
  const setup = new SubscriptionStore(new Database(dbPath));
  const future = new Date(Date.now() + 86_400_000);
  const plans = ["a", "b"].map((plan) =>
    setup.connect(tokens({ accountEmail: `${plan}@example.com`, accessToken: `sk-ant-oat01-${plan}`, expiresAt: future }), null)!
  );
  const configPath = join(dir, "dari-gateway.yaml");
  writeFileSync(configPath, `
routers:
  default:
    models: [${models.join(", ")}]
providers:
  anthropic:
    baseUrl: http://127.0.0.1:${provider.port}
    api: anthropic-messages
`);
  const port = await freePort();
  const gateway = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
    env: {
      PATH: process.env.PATH ?? "",
      DARI_GATEWAY_KEYS: "k",
      DARI_GATEWAY_CONFIG: configPath,
      DARI_GATEWAY_DB: dbPath,
      PORT: String(port),
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  await waitForLine(gateway.stdout as ReadableStream<Uint8Array>, "dari-gateway listening");
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    served,
    planIds: plans.map((plan) => plan.id),
    // The plans as the gateway stored them.
    plan: (id: string) => new SubscriptionStore(new Database(dbPath)).get(id),
    // One Claude Code request in the conversation `sessionId` starts, for
    // `model` or, by default, routed.
    claudeCode: async (sessionId: string, text: string, model = "dari/model/anthropic/claude-sonnet-5-5") =>
      await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": "k",
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
    stop: async () => {
      gateway.kill();
      await gateway.exited;
      await provider.stop(true);
    },
  };
}

/** A streamed Anthropic reply with the given response headers. */
export function anthropicReply(headers: Record<string, string> = {}): Response {
  const events = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { headers: { "content-type": "text/event-stream", ...headers } });
}

export async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(condition()).toBe(true);
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  return port!;
}

async function waitForLine(stream: ReadableStream<Uint8Array>, marker: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`Gateway exited before "${marker}":\n${output}`);
    output += decoder.decode(value);
  }
  reader.releaseLock();
  void stream.pipeTo(new WritableStream());
}
