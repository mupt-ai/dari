import {
  createServer,
  type Http2ServerRequest,
  type Http2ServerResponse,
  type ServerHttp2Session,
} from "node:http2";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

export type Http2RequestHandler = (request: Request) => Response | Promise<Response>;

export type Http2RoutingServer = {
  readonly port: number;
  stop(force?: boolean): Promise<void>;
};

const HTTP2_FORBIDDEN_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);

export function startHttp2Server(
  port: number,
  handler: Http2RequestHandler,
  hostname = "0.0.0.0",
): Http2RoutingServer {
  const sessions = new Set<ServerHttp2Session>();
  let closePromise: Promise<void> | undefined;
  const server = createServer((request, response) => {
    void handleRequest(request, response, handler);
  });
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  server.listen(port, hostname);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("HTTP/2 gateway server did not bind to a TCP port.");
  }
  return {
    port: address.port,
    stop(force = false): Promise<void> {
      for (const session of sessions) {
        if (force) session.destroy();
        else session.close();
      }
      closePromise ??= new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return closePromise;
    },
  };
}

async function handleRequest(
  incoming: Http2ServerRequest,
  outgoing: Http2ServerResponse,
  handler: Http2RequestHandler,
): Promise<void> {
  const abort = new AbortController();
  incoming.once("aborted", () => abort.abort());
  outgoing.once("close", () => {
    if (!outgoing.writableEnded) abort.abort();
  });

  try {
    const response = await handler(toRequest(incoming, abort.signal));
    outgoing.statusCode = response.status;
    for (const [name, value] of response.headers) {
      if (!HTTP2_FORBIDDEN_RESPONSE_HEADERS.has(name.toLowerCase())) {
        outgoing.setHeader(name, value);
      }
    }
    if (response.body === null || incoming.method === "HEAD") {
      outgoing.end();
      return;
    }
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream),
      outgoing,
    );
  } catch (error) {
    if (abort.signal.aborted || outgoing.destroyed) return;
    console.error("routing HTTP/2 request failed", error);
    if (outgoing.headersSent) {
      outgoing.destroy();
      return;
    }
    outgoing.statusCode = 500;
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({ error: { message: "Internal server error." } }));
  }
}

function toRequest(incoming: Http2ServerRequest, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (name.startsWith(":")) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const method = incoming.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(
    `${incoming.scheme ?? "http"}://${incoming.authority ?? "localhost"}${incoming.url}`,
    {
      method,
      headers,
      body: hasBody ? Readable.toWeb(incoming) : undefined,
      signal,
      duplex: hasBody ? "half" : undefined,
    } as RequestInit & { duplex?: "half" },
  );
}
