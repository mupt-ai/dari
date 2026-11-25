import { hostname } from "node:os";

import { isReasoningEffort, type ReasoningEffort } from "@mupt-ai/dari-router/policy-engine";
import { anthropicToken, bearerToken } from "../http/auth.js";
import { errorResponse, HttpError } from "../http/errors.js";
import { anthropicErrorResponse } from "../ingress/anthropic_messages.js";
import type { GatewayPlatform } from "../platform/platform.js";
import { DEFAULT_ROUTER_ALIAS } from "../platform/routing_contract.js";
import { explicitModelId } from "../protocol/input/router_model.js";
import { parseGatewayConfig, type RouterConfig } from "./config.js";
import type { HostedSync } from "./hosted_sync.js";
import { createSelfHostedPlatform } from "./platform.js";
import { gatewayKeyIndex, resolveSelfHostedRouter } from "./resolve.js";

/**
 * A self-hosted gateway connected to hosted Dari (the Dari CLI runs one for
 * plans kept "on this computer"): it serves a turn on the user's own plans
 * when one serves the model, and otherwise hands the whole request to hosted
 * Dari with the user's Dari key, so agents see one router either way.
 *
 * - Routers are the user's hosted routers, by id (`/<router id>/v1/...`, or
 *   the default router at `/v1/...`): each serves the hosted router's models
 *   that a local plan serves, chosen by the hosted Auto Router API.
 * - A request no local plan can serve (none connected or every one held, or
 *   a model they do not serve) goes to hosted, as does every other path the
 *   gateway does not manage itself, such as model lists and commit reports.
 * - The plans and served requests sync to hosted (hosted_sync.ts), which
 *   shows them in Accounts and Activity; private plans neither serve nor sync.
 *   Dari Link and Activity are hosted's, not served here.
 */
export type HostedConnection = {
  // The hosted routing service, e.g. https://routing.dari.dev.
  url: string;
  // A Dari API key that acts for the user.
  apiKey: string;
  // This gateway, as hosted Dari tells the user's gateways apart.
  gatewayId: string;
  gatewayName: string;
};

/**
 * The connection `DARI_HOSTED_URL` and `DARI_HOSTED_API_KEY` set up, or null
 * when neither is set. A connected gateway needs `DARI_GATEWAY_ID` and
 * `DARI_GATEWAY_ENCRYPTION_KEY`; `DARI_GATEWAY_NAME` defaults to the host name.
 */
export function hostedConnectionFromEnv(env: Record<string, string | undefined>): HostedConnection | null {
  const url = env.DARI_HOSTED_URL?.trim().replace(/\/+$/, "");
  const apiKey = env.DARI_HOSTED_API_KEY?.trim();
  if (!url && !apiKey) return null;
  if (!url || !apiKey) throw new Error("Set both DARI_HOSTED_URL and DARI_HOSTED_API_KEY to connect to hosted Dari.");
  const gatewayId = env.DARI_GATEWAY_ID?.trim();
  if (!gatewayId) throw new Error("A gateway connected to hosted Dari needs DARI_GATEWAY_ID.");
  if (!env.DARI_GATEWAY_ENCRYPTION_KEY?.trim()) {
    throw new Error("A gateway connected to hosted Dari needs DARI_GATEWAY_ENCRYPTION_KEY to encrypt its plans' tokens.");
  }
  return { url, apiKey, gatewayId, gatewayName: env.DARI_GATEWAY_NAME?.trim() || hostname() };
}

type SelfHostedPlatformDeps = Parameters<typeof createSelfHostedPlatform>[0];

/** The self-hosted platform on hosted routers, reporting requests to hosted Dari. */
export function createConnectedPlatform(deps: SelfHostedPlatformDeps & {
  hosted: HostedConnection;
  sync: HostedSync;
}): GatewayPlatform {
  const platform = createSelfHostedPlatform(deps);
  const hostedRouter = hostedRouters(deps.hosted, deps.fetch as typeof fetch);
  return {
    ...platform,
    async resolveRouter(request) {
      const router = await hostedRouter(request.routerId);
      return await resolveSelfHostedRouter({
        ...deps,
        config: { ...deps.config, routers: { [request.routerId]: router } },
        prefixHits: (args) => deps.prefixes.hits(args),
      }, request);
    },
    recordRequest(record) {
      console.info("routing request", JSON.stringify(record.summary));
      try {
        deps.sync.enqueue(record.row);
      } catch (error) {
        console.error("hosted Activity queue failed", error instanceof Error ? error.message : String(error));
      }
    },
    link: undefined,
    activity: undefined,
  };
}

const ROUTER_CACHE_MS = 60_000;

/**
 * A hosted router as this gateway serves it: its models, read from hosted's
 * model list (cached for a minute), on the user's plans only.
 */
function hostedRouters(hosted: HostedConnection, fetchImpl: typeof fetch) {
  const cache = new Map<string, { router: RouterConfig; readAt: number }>();
  return async (routerId: string): Promise<RouterConfig> => {
    const cached = cache.get(routerId);
    if (cached !== undefined && Date.now() - cached.readAt < ROUTER_CACHE_MS) return cached.router;
    let router: RouterConfig;
    try {
      router = await readHostedRouter(hosted, fetchImpl, routerId);
    } catch (error) {
      if (cached !== undefined) return cached.router;
      console.error("hosted router read failed", error instanceof Error ? error.message : String(error));
      // A 424 hands the request to hosted, which reports its own error.
      throw new HttpError(424, `Router ${routerId} could not be read from hosted Dari.`, "hosted_router_unavailable");
    }
    cache.set(routerId, { router, readAt: Date.now() });
    return router;
  };
}

async function readHostedRouter(hosted: HostedConnection, fetchImpl: typeof fetch, routerId: string): Promise<RouterConfig> {
  const prefix = routerId === DEFAULT_ROUTER_ALIAS ? "" : `/${encodeURIComponent(routerId)}`;
  const response = await fetchImpl(`${hosted.url}${prefix}/v1/models`, {
    headers: { authorization: `Bearer ${hosted.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const catalog = await response.json() as {
    remote_compaction?: string;
    models?: Array<{ slug?: string; supported_reasoning_levels?: Array<{ effort?: string }> }>;
  };
  const models = (catalog.models ?? []).flatMap((entry) => {
    // `dari/routing` is the router itself, not one of its models.
    const id = explicitModelId(entry.slug);
    if (id === null) return [];
    const thinking = entry.supported_reasoning_levels
      ?.map((level) => level.effort === "none" ? "off" : level.effort)
      .filter((level): level is ReasoningEffort => isReasoningEffort(level));
    return [thinking?.length ? { id, thinking } : { id }];
  });
  if (models.length === 0) throw new Error("it lists no models");
  return parseGatewayConfig({
    routers: {
      [routerId]: { models, subscriptions: true, nativeCompaction: catalog.remote_compaction === "v2" },
    },
  }).routers[routerId]!;
}

// The routed calls a local plan may serve; anything else the gateway does
// not manage goes to hosted.
const ROUTED_CALL = /^(?:\/[^/]+)?(?:\/v1)?\/(?:chat\/completions|responses|messages)$/;

/**
 * Serve a connected gateway's routed surface: `gateway` (the gateway's own
 * handler on the connected platform) first, and hosted Dari for a request it
 * cannot serve on a local plan. Health checks stay local; every request
 * forwarded must carry a gateway key.
 */
export function connectedHandler(deps: {
  gateway: (request: Request) => Promise<Response>;
  gatewayKeys: readonly string[];
  hosted: HostedConnection;
  sync: HostedSync;
  fetch: typeof fetch;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz" || pathname === "/health" || pathname === "/api/hello") {
      return await deps.gateway(request);
    }
    // Claude Code reads errors in Anthropic's shape, as the gateway answers them.
    const fail = MESSAGES_CALL.test(pathname) ? anthropicErrorResponse : errorResponse;
    try {
      const anthropic = !request.headers.has("authorization") && request.headers.has("x-api-key");
      const key = anthropic ? anthropicToken(request.headers) : bearerToken(request.headers);
      if (gatewayKeyIndex(deps.gatewayKeys, key) === null) {
        throw new HttpError(401, "Missing or invalid gateway key.", "authentication_error");
      }
    } catch (error) {
      return fail(error);
    }
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    if (request.method === "POST" && ROUTED_CALL.test(pathname)) {
      const local = await deps.gateway(new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
        signal: request.signal,
      }));
      if (!(await servedElsewhere(local))) return local;
      await local.body?.cancel();
      // Hosted logs the request it serves; the local attempt is not one.
      const requestId = local.headers.get("x-request-id");
      if (requestId !== null) deps.sync.discard(requestId);
    }
    return await forward(request, body, deps, fail);
  };
}

const MESSAGES_CALL = /\/messages(?:\/count_tokens)?$/;

/**
 * Whether a local response means no local plan could serve the request: none
 * serves the router's models or the one asked for (424, or the explicit
 * model's 400), or every one is at its limit (429).
 */
async function servedElsewhere(response: Response): Promise<boolean> {
  if (response.status === 424 || response.status === 429) return true;
  if (response.status !== 400) return false;
  const text = await response.clone().text();
  return text.includes("model_not_enabled") || text.includes("is not enabled on this router");
}

// The request as the client sent it, on hosted Dari with the user's key.
async function forward(
  request: Request,
  body: ArrayBuffer | null,
  deps: { hosted: HostedConnection; fetch: typeof fetch },
  fail: (error: unknown) => Response,
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  for (const name of ["host", "authorization", "x-api-key", "content-length", "connection", "accept-encoding"]) {
    headers.delete(name);
  }
  headers.set("authorization", `Bearer ${deps.hosted.apiKey}`);
  let response: Response;
  try {
    response = await deps.fetch(`${deps.hosted.url}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      signal: request.signal,
    });
  } catch {
    return fail(new HttpError(502, "Hosted Dari could not be reached.", "hosted_unreachable"));
  }
  // The body arrives decoded; its length and encoding no longer apply.
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
}
