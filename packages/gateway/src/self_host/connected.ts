import { hostname } from "node:os";

import type { ReasoningEffort } from "@mupt-ai/dari-router/policy-engine";
import { anthropicToken, bearerToken } from "../http/auth.js";
import { errorResponse, HttpError } from "../http/errors.js";
import { anthropicErrorResponse } from "../ingress/anthropic_messages.js";
import type { GatewayPlatform } from "../platform/platform.js";
import { DEFAULT_ROUTER_ALIAS, HOSTED_DARI_PROVIDER } from "../platform/routing_contract.js";
import type { Source } from "../models/sources.js";
import { parseGatewayConfig, type RouterConfig } from "./config.js";
import type { HostedSync } from "./hosted_sync.js";
import { createSelfHostedPlatform } from "./platform.js";
import { gatewayKeyIndex, resolveSelfHostedRouter } from "./resolve.js";

/**
 * A self-hosted gateway connected to hosted Dari (the Dari CLI runs one for
 * every launch signed in to Dari): it serves every routed call itself, on the
 * user's plans on this computer first and then on hosted Dari as a provider.
 *
 * - Routers are the user's hosted routers, by id (`/<router id>/v1/...`, or
 *   the default router at `/v1/...`), read from hosted Dari: every model, each
 *   with its sources (models/sources.ts), chosen by the hosted Auto Router API.
 * - A model's plans on this computer serve it first. Whatever comes next that
 *   only Dari can serve (its own plans, the router's key, managed credits) is
 *   one candidate: hosted Dari, called for `dari/model/<id>` with the user's
 *   Dari key (resolve.ts).
 * - Every other path the gateway does not manage itself, such as commit
 *   reports, goes to hosted with the user's Dari key.
 * - The plans and the requests served here sync to hosted (hosted_sync.ts),
 *   which shows them in Accounts and Activity. Private plans serve, but
 *   neither they nor their requests sync; requests hosted Dari served are
 *   hosted's to log. Dari Link and Activity are hosted's, not served here.
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
  hostedRouter: HostedRouters;
}): GatewayPlatform {
  const platform = createSelfHostedPlatform(deps);
  return {
    ...platform,
    async resolveRouter(request) {
      const router = (await deps.hostedRouter(request.routerId)).config;
      return await resolveSelfHostedRouter({
        ...deps,
        config: { ...deps.config, routers: { [request.routerId]: router } },
        prefixHits: (args) => deps.prefixes.hits(args),
      }, request);
    },
    recordRequest(record) {
      console.info("routing request", JSON.stringify(record.summary));
      // Hosted Dari logs the requests it served itself.
      if (record.summary.selected_provider === HOSTED_DARI_PROVIDER) return;
      // A private plan's requests stay on this computer, as the plan does; so
      // does one whose plan is gone, since it may have been private.
      if (record.subscriptionCredentialId !== undefined) {
        const plan = deps.subscriptions.get(record.subscriptionCredentialId);
        if (plan === null || plan.private) return;
      }
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

/** A hosted router as this gateway serves it, read from hosted Dari (cached for a minute). */
/** A hosted router as this gateway serves it, and whether it uses custom rules. */
export type HostedRouterState = { config: RouterConfig; customRules: boolean };
export type HostedRouters = (routerId: string) => Promise<HostedRouterState>;

export function hostedRouters(hosted: HostedConnection, fetchImpl: typeof fetch): HostedRouters {
  const cache = new Map<string, { router: HostedRouterState; readAt: number }>();
  return async (routerId: string): Promise<HostedRouterState> => {
    const cached = cache.get(routerId);
    if (cached !== undefined && Date.now() - cached.readAt < ROUTER_CACHE_MS) return cached.router;
    let router: HostedRouterState;
    try {
      router = await readHostedRouter(hosted, fetchImpl, routerId);
    } catch (error) {
      if (cached !== undefined) return cached.router;
      console.error("hosted router read failed", error instanceof Error ? error.message : String(error));
      throw new HttpError(502, `Router ${routerId} could not be read from hosted Dari.`, "hosted_router_unavailable");
    }
    cache.set(routerId, { router, readAt: Date.now() });
    return router;
  };
}

/**
 * What hosted Dari says of a router (`GET /v1/gateway/routers/<id>`, or
 * `/v1/gateway/router` for the default): its every model, with the thinking
 * levels it offers and its sources, its reset threshold, and whether Codex may
 * compact natively.
 */
type HostedRouter = {
  models: Array<{ id: string; thinking: ReasoningEffort[] | null; sources: Source[] }>;
  reset_min_hours: number;
  native_compaction: boolean;
  zdr: boolean;
  session_pinning: boolean;
  retries: number;
  role_models: Record<string, string | null>;
  role_prompts: Record<string, string | null>;
  custom_rules: boolean;
};

async function readHostedRouter(hosted: HostedConnection, fetchImpl: typeof fetch, routerId: string): Promise<HostedRouterState> {
  let path = `/v1/gateway/routers/${encodeURIComponent(routerId)}`;
  if (routerId === DEFAULT_ROUTER_ALIAS) path = "/v1/gateway/router";
  const response = await fetchImpl(`${hosted.url}${path}`, {
    headers: { authorization: `Bearer ${hosted.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const router = await response.json() as HostedRouter;
  // A model's null thinking offers every level it supports.
  const config = parseGatewayConfig({
    routers: {
      [routerId]: {
        models: router.models,
        resetMinHours: router.reset_min_hours,
        nativeCompaction: router.native_compaction,
        zdr: router.zdr,
        sessionPinning: router.session_pinning,
        retries: router.retries,
        roleModels: router.role_models,
        rolePrompts: router.role_prompts,
      },
    },
  }).routers[routerId]!;
  return { config, customRules: router.custom_rules === true };
}

// The calls this gateway serves itself: routed calls and model lists. Every
// other path goes to hosted.
const LOCAL_CALL = /^(?:\/[^/]+)?(?:\/v1)?\/(?:chat\/completions|responses|messages|models)$/;

/**
 * Serve a connected gateway: routed calls and model lists on `gateway` (the
 * gateway's own handler on the connected platform), and every other path on
 * hosted Dari with the user's Dari key. Health checks stay local; every other
 * request must carry a gateway key.
 */
export function connectedHandler(deps: {
  gateway: (request: Request) => Promise<Response>;
  gatewayKeys: readonly string[];
  hosted: HostedConnection;
  hostedRouter: HostedRouters;
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
    if (!LOCAL_CALL.test(pathname)) return await forward(request, deps, fail);
    // Custom routing rules run only on hosted Dari: it serves those routers'
    // calls whole.
    if (request.method === "POST" && await usesCustomRules(deps.hostedRouter, pathname)) {
      return await forward(request, deps, fail);
    }
    return await deps.gateway(request);
  };
}

const MESSAGES_CALL = /\/messages(?:\/count_tokens)?$/;

// Whether the router a routed call's path names uses custom rules. A router
// that cannot be read goes to hosted Dari too: it may use them, and only Dari
// can run them.
async function usesCustomRules(hostedRouter: HostedRouters, pathname: string): Promise<boolean> {
  let routerId = DEFAULT_ROUTER_ALIAS;
  const first = pathname.split("/")[1];
  if (first !== undefined && first !== "v1" && !LOCAL_CALL.test(`/${first}`)) routerId = first;
  try {
    return (await hostedRouter(routerId)).customRules;
  } catch {
    return true;
  }
}

// The request as the client sent it, on hosted Dari with the user's key.
async function forward(
  request: Request,
  deps: { hosted: HostedConnection; fetch: typeof fetch },
  fail: (error: unknown) => Response,
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  for (const name of ["host", "authorization", "x-api-key", "content-length", "connection", "accept-encoding"]) {
    headers.delete(name);
  }
  headers.set("authorization", `Bearer ${deps.hosted.apiKey}`);
  let body: ArrayBuffer | null = null;
  if (request.method !== "GET" && request.method !== "HEAD") body = await request.arrayBuffer();
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
