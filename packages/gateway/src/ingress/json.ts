import { Readable, type Transform } from "node:stream";
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createZstdDecompress,
} from "node:zlib";

import { HttpError } from "../http/errors.js";

const MAX_ENCODED_JSON_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_JSON_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_CONTENT_ENCODING_LAYERS = 3;

export async function parseJsonRequest<T extends Record<string, unknown>>(request: Request): Promise<T> {
  let payload: unknown;
  try {
    payload = JSON.parse(await requestText(request));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Request body must be valid JSON.", "invalid_request_error");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new HttpError(400, "Request body must be a JSON object.", "invalid_request_error");
  }
  return payload as T;
}

async function requestText(request: Request): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > MAX_ENCODED_JSON_REQUEST_BYTES) {
      throw requestTooLarge();
    }
  }
  const encodings = contentEncodings(request.headers.get("content-encoding"));
  if (encodings.length > MAX_CONTENT_ENCODING_LAYERS) {
    throw new HttpError(415, "Too many Content-Encoding layers.", "unsupported_content_encoding", "content-encoding");
  }
  let stream: AsyncIterable<Uint8Array> = boundedChunks(
    request.body ?? emptyByteStream(),
    MAX_ENCODED_JSON_REQUEST_BYTES
  );
  for (const encoding of encodings.reverse()) {
    stream = boundedChunks(
      decodedChunks(stream, encoding),
      MAX_DECODED_JSON_REQUEST_BYTES
    );
  }
  return await readText(stream);
}

function contentEncodings(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value && value !== "identity");
}

async function* boundedChunks(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number
): AsyncGenerator<Uint8Array> {
  let bytesRead = 0;
  for await (const chunk of stream) {
    bytesRead += chunk.byteLength;
    if (bytesRead > maxBytes) throw requestTooLarge();
    yield chunk;
  }
}

async function* decodedChunks(
  stream: AsyncIterable<Uint8Array>,
  encoding: string
): AsyncGenerator<Uint8Array> {
  const decoded = Readable.from(stream).pipe(decompressor(encoding));
  try {
    for await (const chunk of decoded) {
      if (!(chunk instanceof Uint8Array)) throw new Error("Decompressor emitted a non-byte chunk.");
      yield chunk;
    }
  } finally {
    decoded.destroy();
  }
}

function decompressor(encoding: string): Transform {
  if (encoding === "zstd") return createZstdDecompress();
  if (encoding === "gzip" || encoding === "x-gzip") return createGunzip();
  if (encoding === "deflate") return createInflate();
  if (encoding === "br") return createBrotliDecompress();
  throw new HttpError(415, `Unsupported Content-Encoding '${encoding}'.`, "unsupported_content_encoding", "content-encoding");
}

async function readText(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const parts: string[] = [];
  for await (const chunk of stream) {
    parts.push(decoder.decode(chunk, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

async function* emptyByteStream(): AsyncGenerator<Uint8Array> {
  return;
}

function requestTooLarge(): HttpError {
  return new HttpError(413, "Request body is too large.", "request_entity_too_large");
}
