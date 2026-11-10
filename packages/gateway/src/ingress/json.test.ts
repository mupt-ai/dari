import { expect, test } from "bun:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";

import { HttpError } from "../http/errors.js";
import { parseJsonRequest } from "./json.js";

const URL = "https://routing.test/rtr_test/v1/responses";
const MIB = 1024 * 1024;

test.each([
  ["zstd", (bytes: Uint8Array) => Bun.zstdCompressSync(bytes)],
  ["gzip", (bytes: Uint8Array) => gzipSync(bytes)],
  ["x-gzip", (bytes: Uint8Array) => gzipSync(bytes)],
  ["deflate", (bytes: Uint8Array) => deflateSync(bytes)],
  ["br", (bytes: Uint8Array) => brotliCompressSync(bytes)],
] as const)("streams %s-compressed JSON", async (encoding, compress) => {
  const source = new TextEncoder().encode(JSON.stringify({ input: "compressed", sequence: 7 }));
  const parsed = await parseJsonRequest(request(bodyBytes(compress(source)), encoding));

  expect(parsed).toEqual({ input: "compressed", sequence: 7 });
});

test("decodes layered Content-Encoding values in reverse application order", async () => {
  const source = new TextEncoder().encode(JSON.stringify({ input: "layered" }));
  const gzip = gzipSync(source);
  const brotliOverGzip = brotliCompressSync(gzip);

  expect(await parseJsonRequest(request(bodyBytes(brotliOverGzip), "gzip, br"))).toEqual({ input: "layered" });
});

test("rejects unsupported and excessive encoding layers before consuming the body", async () => {
  const unsupported = await caught(parseJsonRequest(request(new Uint8Array([1, 2, 3]), "snappy")));
  expect(unsupported).toMatchObject({ status: 415, code: "unsupported_content_encoding" });

  const layered = await caught(parseJsonRequest(request(new Uint8Array([1]), "gzip, br, zstd, gzip")));
  expect(layered).toMatchObject({ status: 415, code: "unsupported_content_encoding" });
});

test("rejects a compressed body while it expands past the decoded limit", async () => {
  const oversized = new TextEncoder().encode(JSON.stringify({ input: "x".repeat(64 * MIB) }));
  const compressed = Bun.zstdCompressSync(oversized);
  expect(compressed.byteLength).toBeLessThan(MIB);

  const error = await caught(parseJsonRequest(request(bodyBytes(compressed), "zstd")));
  expect(error).toMatchObject({ status: 413, code: "request_entity_too_large" });
});

test("bounds streaming encoded bodies even without Content-Length", async () => {
  const chunk = new Uint8Array(MIB);
  let emitted = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted === 65) {
        controller.close();
        return;
      }
      emitted += 1;
      controller.enqueue(chunk);
    },
  });
  const streamed = new Request(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  const error = await caught(parseJsonRequest(streamed));
  expect(error).toMatchObject({ status: 413, code: "request_entity_too_large" });
});

test("maps malformed compressed data to the existing JSON request error", async () => {
  const error = await caught(parseJsonRequest(request(new Uint8Array([1, 2, 3]), "zstd")));
  expect(error).toMatchObject({ status: 400, code: "invalid_request_error" });
});

function request(body: BodyInit, encoding?: string): Request {
  return new Request(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(encoding ? { "Content-Encoding": encoding } : {}),
    },
    body,
  });
}

function bodyBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

async function caught(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("Expected request parsing to fail.");
}
