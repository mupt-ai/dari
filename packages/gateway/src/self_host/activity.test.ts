import { afterEach, expect, test } from "bun:test";

import { startStubGateway } from "./stub_gateway.js";

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

// A request served by the self-hosted gateway shows up in its own Activity:
// the summary, the conversation, and the retained request body.
test("a self-hosted gateway serves Activity for the requests it routed", async () => {
  const gateway = await startStubGateway({ plans: ["openai_codex"] });
  stop = gateway.stop;
  const auth = { authorization: `Bearer ${gateway.gatewayKey}` };
  const served = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ model: "dari/routing", messages: [{ role: "user", content: "hello" }] }),
  });
  expect(served.status).toBe(200);
  await served.text();

  const from = new Date(Date.now() - 3_600_000).toISOString();
  const to = new Date(Date.now() + 3_600_000).toISOString();
  const read = async (route: string, query = "") => {
    // The request is recorded after its response; give it a moment.
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(
        `${gateway.baseUrl}/v1/organizations/current/routing/activity/${route}?from=${from}&to=${to}${query}`,
        { headers: auth },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, any>;
      if (route !== "overview" || body.summary.model_steps > 0 || attempt === 20) return body;
      await Bun.sleep(50);
    }
  };

  const overview = await read("overview", "&bucket_seconds=3600");
  expect(overview.summary).toMatchObject({ messages_sent: 1, model_steps: 1 });
  expect(overview.api_keys).toEqual([expect.objectContaining({ api_key_id: "gateway_key_1", label: "Gateway key 1" })]);

  const { conversations } = await read("conversations");
  expect(conversations).toHaveLength(1);
  expect(conversations[0]).toMatchObject({ router_id: "default", router_name: "default" });

  const detail = await fetch(
    `${gateway.baseUrl}/v1/organizations/current/routing/activity/conversations/${conversations[0].conversation_ref}`,
    { headers: auth },
  );
  const { steps } = (await detail.json()) as { steps: Array<{ client_request_url: string | null }> };
  expect(steps[0]!.client_request_url).not.toBeNull();
  const body = await fetch(`${gateway.baseUrl}${steps[0]!.client_request_url}`, { headers: auth });
  expect(body.status).toBe(200);
  expect(await body.text()).toContain("hello");

  // Only a gateway key reads it.
  const anonymous = await fetch(`${gateway.baseUrl}/v1/organizations/current/routing/activity/overview?from=${from}&to=${to}&bucket_seconds=3600`);
  expect(anonymous.status).toBe(401);
});
