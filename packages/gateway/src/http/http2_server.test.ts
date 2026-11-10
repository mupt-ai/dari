import { expect, test } from "bun:test";
import { connect, type ClientHttp2Stream, type IncomingHttpHeaders } from "node:http2";

import { parseJsonRequest } from "../ingress/json.js";
import { startHttp2Server } from "./http2_server.js";

const MIB = 1024 * 1024;

test("serves streaming responses over cleartext HTTP/2", async () => {
  const server = startHttp2Server(0, () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first"));
      controller.enqueue(new TextEncoder().encode("second"));
      controller.close();
    },
  }), {
    status: 201,
    headers: { Connection: "keep-alive", "x-routing-test": "h2c" },
  }));

  try {
    const response = await request(server.port, "/stream");
    expect(Number(response.headers[":status"])).toBe(201);
    expect(response.headers["x-routing-test"]).toBe("h2c");
    expect(response.headers.connection).toBeUndefined();
    expect(response.body).toBe("firstsecond");
  } finally {
    await server.stop(true);
  }
});

test("accepts JSON requests larger than Cloud Run's HTTP/1 limit over h2c", async () => {
  const server = startHttp2Server(0, async (request) => {
    const parsed = await parseJsonRequest<{ input: string }>(request);
    return Response.json({ length: parsed.input.length });
  });
  const body = JSON.stringify({ input: "x".repeat(33 * MIB) });

  try {
    const response = await request(server.port, "/large", body);
    expect(Number(response.headers[":status"])).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ length: 33 * MIB });
  } finally {
    await server.stop(true);
  }
});

function request(port: number, path: string, body?: string): Promise<{
  headers: IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const client = connect(`http://127.0.0.1:${port}`);
    client.once("error", reject);
    const stream = client.request({
      ":method": body === undefined ? "GET" : "POST",
      ":path": path,
      ...(body === undefined ? {} : {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      }),
    });
    const chunks: Buffer[] = [];
    let responseHeaders: IncomingHttpHeaders = {};
    stream.on("response", (headers) => {
      responseHeaders = headers;
    });
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("error", (error) => finish(client, stream, () => reject(error)));
    stream.once("end", () => finish(client, stream, () => resolve({
      headers: responseHeaders,
      body: Buffer.concat(chunks).toString("utf8"),
    })));
    stream.end(body);
  });
}

function finish(
  client: ReturnType<typeof connect>,
  stream: ClientHttp2Stream,
  done: () => void,
): void {
  stream.close();
  client.close();
  done();
}
