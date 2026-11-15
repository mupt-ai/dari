import { afterEach, expect, test } from "bun:test";

import { createProviderResponseCapture } from "./response_capture.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function serve(body: string, contentType = "text/event-stream") {
  const bytes = new TextEncoder().encode(body);
  globalThis.fetch = (async () => new Response(
    // Split mid-line, as a network read does.
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 40));
        controller.enqueue(bytes.slice(40));
        controller.close();
      },
    }),
    { headers: { "content-type": contentType } },
  )) as unknown as typeof fetch;
}

// Meta's Muse Code stream, as observed live: the usage event comes last.
const MUSE_STREAM = [
  "event: response.created",
  'data: {"type":"response.created"}',
  "",
  "event: response.subscription_usage",
  'data: {"subscription":{"tier":"28367280949604159","weekly":{"resets_at":1794787200,"used_percent":0},"window":{"resets_at":1794706728,"used_percent":0,"window_duration_mins":300}},"type":"response.subscription_usage"}',
  "",
  "",
].join("\n");

test("a stream's subscription usage event is read as the client reads the stream", async () => {
  serve(MUSE_STREAM);
  const capture = createProviderResponseCapture({ watchSubscriptionUsage: true });
  const response = await capture.fetch("https://api.meta.ai/v1/responses");
  // The client still gets the stream unchanged.
  expect(await response.text()).toBe(MUSE_STREAM);
  expect(await capture.streamedSubscriptionUsage).toEqual({
    tier: "28367280949604159",
    weekly: { resets_at: 1794787200, used_percent: 0 },
    window: { resets_at: 1794706728, used_percent: 0, window_duration_mins: 300 },
  });
});

test("a stream without the event, or a cancelled one, reports none", async () => {
  serve('event: response.created\ndata: {"type":"response.created"}\n\n');
  const plain = createProviderResponseCapture({ watchSubscriptionUsage: true });
  await (await plain.fetch("https://example.test")).text();
  expect(await plain.streamedSubscriptionUsage).toBeNull();

  serve(MUSE_STREAM);
  const cancelled = createProviderResponseCapture({ watchSubscriptionUsage: true });
  await (await cancelled.fetch("https://example.test")).body!.cancel();
  expect(await cancelled.streamedSubscriptionUsage).toBeNull();
});

test("only a capture asked to watch reads the event, and an oversized line is skipped", async () => {
  serve(MUSE_STREAM);
  const unwatched = createProviderResponseCapture();
  expect(await (await unwatched.fetch("https://example.test")).text()).toBe(MUSE_STREAM);
  expect(await unwatched.streamedSubscriptionUsage).toBeNull();

  const huge = `data: {"type":"response.output_item.done","item":"${"x".repeat(200_000)}"}\n\n`;
  serve(huge + MUSE_STREAM);
  const watched = createProviderResponseCapture({ watchSubscriptionUsage: true });
  expect(await (await watched.fetch("https://example.test")).text()).toBe(huge + MUSE_STREAM);
  expect(await watched.streamedSubscriptionUsage).toMatchObject({ weekly: { used_percent: 0 } });
});
