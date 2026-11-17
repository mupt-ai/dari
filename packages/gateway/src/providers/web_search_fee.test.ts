import { expect, test } from "bun:test";

import { messageWithWebSearchFee, webSearchCountTap } from "./web_search_fee.js";

const sse = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));

async function count(events: unknown[]): Promise<number> {
  const tap = webSearchCountTap(async () => sse(events));
  await (await tap.fetch("https://provider.test")).text();
  return tap.searches();
}

test("Anthropic's searches are its reported running total", async () => {
  expect(await count([
    { type: "message_start", message: { usage: { input_tokens: 10, server_tool_use: { web_search_requests: 0 } } } },
    { type: "message_delta", usage: { output_tokens: 5, server_tool_use: { web_search_requests: 2 } } },
  ])).toBe(2);
});

test("OpenAI's searches are its completed web_search_call items, each once", async () => {
  const call = (id: string, status: string) => ({ type: "response.output_item.done", item: { id, type: "web_search_call", status } });
  expect(await count([call("ws_1", "completed"), call("ws_1", "completed"), call("ws_2", "failed"), call("ws_3", "completed")])).toBe(2);
});

test("the fee is added to the message's cost total only when it searched", () => {
  const message = { usage: { cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } } };
  expect(messageWithWebSearchFee(message, 0)).toBe(message);
  expect((messageWithWebSearchFee(message, 3).usage as any).cost).toEqual({ input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.033 });
});
