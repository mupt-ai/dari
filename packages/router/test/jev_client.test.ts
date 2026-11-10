import { afterEach, expect, test } from "bun:test";

import { RouterFrameworkError } from "../src/index.js";
import { postSystemOne, resolveJevConfig } from "../src/jev_client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("resolveJevConfig validates the API key, endpoint, and timeout", () => {
  expect(() => resolveJevConfig({ apiKey: " " })).toThrow("requires an apiKey");
  expect(() => resolveJevConfig({ apiKey: "k", endpoint: "not a url" })).toThrow(
    "must be a valid URL",
  );
  expect(() =>
    resolveJevConfig({ apiKey: "k", endpoint: "https://user:pw@api.typesafe.ai/v1" }),
  ).toThrow("without embedded credentials");
  expect(() => resolveJevConfig({ apiKey: "k", timeoutMs: 0 })).toThrow("positive integer");
  const resolved = resolveJevConfig({ apiKey: "k", endpoint: "https://api.typesafe.ai/v1/" });
  expect(resolved.endpoint).toBe("https://api.typesafe.ai/v1");
  expect(resolved.model).toBe("jev-latest");
});

test("postSystemOne retries once on rate limits and surfaces other HTTP errors", async () => {
  const config = resolveJevConfig({ apiKey: "ts-key" });
  const request = { model: config.model, state: null, questions: {} };
  const statuses = [429, 200];
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    expect(String(input)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ts-key");
    const status = statuses.shift()!;
    if (status !== 200) {
      return new Response("slow down", { status, headers: { "retry-after": "0" } });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  expect(await postSystemOne(request, config, undefined)).toEqual({ ok: true });
  expect(calls).toBe(2);

  globalThis.fetch = (async (_input: RequestInfo | URL) =>
    new Response("bad key", { status: 401 })) as typeof fetch;
  const error = await postSystemOne(request, config, undefined).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(RouterFrameworkError);
  expect((error as RouterFrameworkError).code).toBe("jev_http_error");
  expect((error as RouterFrameworkError).message).toContain("401");
});
