/* Activity's HTTP surface: `GET /v1/organizations/{organization}/routing/
   activity/...`, the reads behind the Activity dashboard and `dari activity`,
   and the import `dari traces import` posts to. Every platform serves the
   same routes over its own database; the platform only says who is asking,
   where retained payloads live, and how an imported request is stored. */

import { randomUUID } from "node:crypto";

import { HttpError } from "../http/errors.js";
import { activityError, Params } from "./params.js";
import type { CommitEvent } from "../telemetry/tools/git_events.js";
import type { ActivityDb } from "./sql.js";
import { ACTIVITY_ROUTES } from "./routes.js";

export const ACTIVITY_ROUTE = /^\/v1\/organizations\/([^/]+)\/routing\/activity\/(.+)$/;

/** Commits an agent session made, as the Dari CLI's git hook reports them. */
export type SessionGitEvents = {
  organizationId: string;
  sourceProtocol: string;
  agentSessionId: string;
  events: CommitEvent[];
};

/** Activity as a platform provides it. */
export type ActivityPlatform = {
  /** The database holding `routing_requests` and the tables Activity joins. */
  db: ActivityDb;
  /** Store a session's commits, now; a commit it already has is kept once. */
  saveSessionGitEvents(write: SessionGitEvents): Promise<void>;
  /**
   * The organization a request may read. `organizationRef` is the path's
   * organization: an ID, or `current` for the one the bearer key belongs to.
   * Throws HttpError 401 for a caller it cannot authenticate, and 403 or 404
   * for one that is not an admin of the organization. Its message is the
   * response's `detail`.
   */
  authorize(request: Request, organizationRef: string): Promise<ActivityCaller>;
  /** A retained payload's bytes, or null when nothing is stored there. */
  readBlob(bucket: string, key: string): Promise<BodyInit | null>;
  /**
   * Optional. Store one imported request's report (imports.ts) under the
   * organization's "Imported" router, creating the router when it has none.
   * Resolves false when a request with the report's ID is already stored.
   * Never bills, prices, or titles the request. Without it the import
   * endpoint answers 404.
   */
  importRequest?(caller: ActivityCaller, report: Record<string, unknown>): Promise<boolean>;
};

/** An admitted caller: its organization and, where the platform has users, who it is. */
export type ActivityCaller = { organizationId: string; userId?: string };

/** One Activity request, as a route reads it. */
export type ActivityRequest = {
  db: ActivityDb;
  platform: ActivityPlatform;
  params: Params;
  /** The route's own path segments, such as `conversation_ref`. */
  path: Record<string, string>;
  /** The request's JSON body; fails with 422 when it is not JSON. */
  body(): Promise<unknown>;
  /** The caller's user, once `admitted`, where the platform has users. */
  userId?: string;
  /**
   * The organization the caller may read. Routes call it after reading their
   * parameters, so a malformed request fails with 422 or 400 before an
   * authenticated non-admin learns it is not one.
   */
  admitted(): string;
};

export type ActivityRoute = (request: ActivityRequest) => Promise<Response | object>;

/** Serve an Activity request; null when the path is not one of its routes. */
export async function handleActivityRequest(
  request: Request,
  platform: ActivityPlatform | undefined,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = ACTIVITY_ROUTE.exec(url.pathname);
  if (match === null) return null;
  if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
  // Every answer names its request, and an error carries the same ID, as
  // Dari's API always has, so a reported error can be found in the logs.
  const requestId = `req_${randomUUID().replaceAll("-", "")}`;
  try {
    if (platform === undefined) throw activityError(404, "Not Found");
    const found = findRoute(match[2]!);
    if (found === null) throw activityError(404, "Not Found");
    if (request.method !== found.method) throw activityError(405, "Method Not Allowed");
    let caller: ActivityCaller | null = null;
    let refused: unknown = null;
    try {
      caller = await platform.authorize(request, decodePathSegment(match[1]!));
    } catch (error) {
      if (!(error instanceof HttpError) || error.status === 401) throw error;
      refused = error;
    }
    const result = await found.route({
      db: platform.db,
      platform,
      params: new Params(url.searchParams),
      path: found.path,
      body: () => request.json().catch(() => {
        throw activityError(422, "The body must be JSON.");
      }),
      userId: caller?.userId,
      admitted() {
        if (refused !== null) throw refused;
        return caller!.organizationId;
      },
    });
    return withCors(result instanceof Response ? result : jsonResponse(result), requestId);
  } catch (error) {
    if (error instanceof HttpError) {
      const body = { ...(error.body ?? { detail: error.message }), request_id: requestId };
      return withCors(jsonResponse(body, error.status), requestId);
    }
    throw error;
  }
}

function findRoute(rest: string): { route: ActivityRoute; method: string; path: Record<string, string> } | null {
  const segments = rest.split("/");
  for (const [pattern, route, method = "GET"] of ACTIVITY_ROUTES) {
    const parts = pattern.split("/");
    if (parts.length !== segments.length) continue;
    const path: Record<string, string> = {};
    const matches = parts.every((part, index) => {
      const segment = segments[index]!;
      if (part.startsWith(":")) {
        if (segment === "") return false;
        path[part.slice(1)] = decodePathSegment(segment);
        return true;
      }
      return part === segment;
    });
    if (matches) return { route, method, path };
  }
  return null;
}

// A malformed escape stays as written, as the API reads it, rather than
// failing the request.
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// The dashboard calls Activity from its own origin with a bearer token; no
// cookie authorizes anything here, so any origin may call.
function withCors(response: Response, requestId?: string): Response {
  if (requestId !== undefined) response.headers.set("X-Request-Id", requestId);
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.headers.set("Access-Control-Expose-Headers", "X-Dari-Request-Format, X-Request-Id");
  response.headers.set("Access-Control-Max-Age", "600");
  return response;
}
