import { expect, test } from "bun:test";

import type { GatewayPlatform, LinkPlatform } from "../platform/platform.js";
import { handleLinkRequest } from "./endpoints.js";

// A platform whose storage fails: the cause stays in the log, not the response.
test("a failed link request answers with a request id and none of the cause", async () => {
  const link = {
    app: async () => {
      throw new Error("connection to db-internal-7 refused: password=hunter2");
    },
  } as unknown as LinkPlatform;
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  let response: Response;
  try {
    response = await handleLinkRequest(
      new Request("http://gateway.test/v1/link/authorize?client_id=lnk_1&redirect_uri=https://app.example/cb"),
      { link } as unknown as GatewayPlatform,
    );
  } finally {
    console.error = original;
  }
  expect(response.status).toBe(500);
  const text = await response.text();
  expect(text).not.toContain("hunter2");
  expect(text).not.toContain("db-internal-7");
  const { error } = JSON.parse(text) as { error: { code: string; message: string; request_id: string } };
  expect(error.code).toBe("link_request_failed");
  expect(error.message).toContain(error.request_id);
  // The log line carries the same id beside the cause.
  expect(String(logged[0]![0])).toContain(error.request_id);
  expect(String(logged[0]![1])).toContain("hunter2");
});

test("a gateway without Dari Link answers 404", async () => {
  const response = await handleLinkRequest(new Request("http://gateway.test/v1/link/grants"), {} as GatewayPlatform);
  expect(response.status).toBe(404);
});

// A self-hosted gateway may allow http redirect URIs on private dev hosts it
// lists; anything else stays https or loopback.
test("http redirect URIs are allowed only on loopback and the hosts the gateway lists", async () => {
  const registered: string[][] = [];
  const link = {
    httpRedirectHosts: ["*.example.ts.net", "dev.local"],
    registerApp: async ({ name, redirectUris }: { name: string; redirectUris: string[] }) => {
      registered.push(redirectUris);
      return { clientId: "lnk_1", name, redirectUris, confidential: false };
    },
  } as unknown as LinkPlatform;
  const register = (uri: string) => handleLinkRequest(
    new Request("http://gateway.test/v1/link/register", {
      method: "POST",
      body: JSON.stringify({ client_name: "Dev", redirect_uris: [uri] }),
    }),
    { link } as unknown as GatewayPlatform,
  );
  expect((await register("http://box.example.ts.net:3000/cb")).status).toBe(201);
  expect((await register("http://dev.local/cb")).status).toBe(201);
  expect((await register("http://127.0.0.1:4000/cb")).status).toBe(201);
  expect((await register("http://example.ts.net/cb")).status).toBe(400);
  expect((await register("http://other.dev.local/cb")).status).toBe(400);
  expect((await register("http://evil.test/cb")).status).toBe(400);
  expect(registered).toHaveLength(3);

  // Users approve and manage connections on the gateway's own pages.
  const metadata = await handleLinkRequest(
    new Request("http://gateway.test/.well-known/oauth-authorization-server"),
    { link } as unknown as GatewayPlatform,
  );
  expect(await metadata.json()).toMatchObject({
    web_message_origin: "http://gateway.test",
    connected_apps_uri: "http://gateway.test/v1/link/connections",
    callback_script: "http://gateway.test/v1/link/callback.js",
  });
});

// A plan lists the models it has an offering of, whoever makes them: an
// OpenCode Go plan has none of its own, and a model two plans run is listed
// under both.
test("a plan lists the models it runs for other makers", async () => {
  const subscription = (id: string, provider: string) => ({
    id,
    provider,
    name: provider,
    label: null,
    accountEmail: "go@example.com",
    unavailableUntil: null,
    usage: [],
  });
  const link = {
    grant: async () => ({
      id: "lgr_1",
      clientId: "lnk_1",
      appName: "Notes",
      endpoint: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      budget: [],
      spend: [],
      subscriptions: [
        subscription("sub_go", "opencode_go"),
        subscription("sub_codex", "openai_codex"),
        subscription("sub_copilot", "github_copilot"),
        subscription("sub_claude", "anthropic_claude_code"),
        { ...subscription("key_fw", "fireworks"), apiKeyProvider: "fireworks" },
      ],
    }),
  } as unknown as LinkPlatform;
  // Any client is served the models below; only Claude Code is served Claude too.
  const any = ["openai/gpt-5.6-sol", "zai-org/GLM-5.3", "moonshotai/Kimi-K3"];
  const platform = {
    link,
    resolveRouter: async (args: { clientHarness?: string }) => {
      const models = args.clientHarness === "claude_code" ? [...any, "anthropic/claude-opus-5"] : any;
      return { link_models: models, enabled_models: models };
    },
  } as unknown as GatewayPlatform;
  const response = await handleLinkRequest(
    new Request("http://gateway.test/v1/link/grant", { headers: { authorization: "Bearer dlk_at_test" } }),
    platform,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { plans: Array<{ id: string; serves: string; models: Array<{ id: string }> }>; models: Array<{ id: string }> };
  const plan = (id: string) => body.plans.find((entry) => entry.id === id)!;
  const models = (id: string) => plan(id).models.map((model) => model.id);
  expect(models("sub_go")).toEqual(["dari/model/zai-org/GLM-5.3", "dari/model/moonshotai/Kimi-K3"]);
  expect(plan("sub_go").serves).toBe("any_app");
  expect(models("sub_codex")).toEqual(["dari/model/openai/gpt-5.6-sol"]);
  // Copilot runs the OpenAI model and Kimi K3 too: each is listed under every plan that runs it.
  expect(models("sub_copilot")).toEqual(["dari/model/openai/gpt-5.6-sol", "dari/model/moonshotai/Kimi-K3"]);
  // A Claude plan lists Claude only for its own client.
  expect(models("sub_claude")).toEqual(["dari/model/anthropic/claude-opus-5"]);
  // A key lists its own provider's models, none of which Fireworks makes.
  expect(models("key_fw")).toEqual([]);
  expect(body.models.map((model) => model.id)).toEqual(any.map((model) => `dari/model/${model}`));
});
