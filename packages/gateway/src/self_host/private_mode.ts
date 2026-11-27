import type { Database } from "bun:sqlite";

import { HttpError } from "../http/errors.js";
import { parseJsonRequest } from "../ingress/json.js";

/** `GET` reads private mode and `PUT {"private": true|false}` sets it. */
export const PRIVATE_MODE_ROUTE = "/v1/gateway/private";

/**
 * Private mode of a gateway connected to hosted Dari, kept in its database:
 * on, none of its requests reach Activity, whichever plan or Dari serves them.
 * It sends none to hosted Activity, and asks hosted Dari to keep only what
 * billing needs of each it serves (PRIVATE_HEADER).
 */
export class PrivateMode {
  constructor(private readonly db: Database) {
    db.run("CREATE TABLE IF NOT EXISTS gateway_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  get on(): boolean {
    return this.db.query<{ value: string }, []>("SELECT value FROM gateway_settings WHERE key = 'private'").get()?.value === "1";
  }

  set(on: boolean): void {
    this.db.run(
      "INSERT INTO gateway_settings (key, value) VALUES ('private', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [on ? "1" : "0"],
    );
  }
}

export async function handlePrivateModeRequest(request: Request, mode: PrivateMode): Promise<Response> {
  if (request.method === "PUT") {
    const body = await parseJsonRequest(request);
    if (typeof body.private !== "boolean") throw new HttpError(400, "private must be true or false.", "invalid_request_error");
    mode.set(body.private);
  } else if (request.method !== "GET") {
    throw new HttpError(405, "Use GET or PUT.", "method_not_allowed");
  }
  return Response.json({ private: mode.on }, { headers: { "Cache-Control": "no-store" } });
}
