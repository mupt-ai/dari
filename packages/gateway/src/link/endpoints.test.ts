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
