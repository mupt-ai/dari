#!/usr/bin/env bun
import { chmodSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { builtinModels } from "@mupt-ai/pi-ai/providers/all";

import { bearerToken } from "../http/auth.js";
import { errorResponse, HttpError } from "../http/errors.js";
import { createRequestHandler } from "../http/handler.js";
import { installShutdownHandlers, startServer } from "../http/serve.js";
import { createAutoRoutingSelectorBackend } from "../strategies/auto_routing_selector.js";
import { createPrioritySelectorBackend } from "../strategies/priority_selector.js";
import type { SelectorBackend } from "../strategies/routing.js";
import { ActivityStore } from "./activity_store.js";
import { connectedHandler, createConnectedPlatform, hostedConnectionFromEnv, hostedRouters } from "./connected.js";
import { HostedSync, readHostedAccounts } from "./hosted_sync.js";
import { createSelfHostedPlatform } from "./platform.js";
import { checkProviderKey } from "../providers/key_check.js";
import { CANONICAL_MODELS } from "../models/canonical.js";
import { allRouterModels, loadGatewayConfig, modelProvider, type GatewayConfig, type RouterConfig } from "./config.js";
import {
  configuredProviderApiKey,
  gatewayKeyIndex,
  providersWithoutCredentials,
  SELF_HOSTED_ORGANIZATION_ID,
} from "./resolve.js";
import { SqliteLinkStore } from "../link/sqlite_store.js";
import { secretBoxFromEnv } from "./secret_box.js";
import { PrefixStore } from "./prefix_store.js";
import { handleRouterModelsRequest, ROUTER_MODELS_ROUTE, RouterModelStore } from "./router_models.js";
import {
  handleRouterSpecsRequest,
  loadRouterSpecDirectory,
  ROUTERS_ROUTE,
  RouterSpecStore,
  servedRouter,
  servedRouterIds,
  type ServedRouters,
} from "./router_specs.js";
import { SessionPinStore } from "./session_pin_store.js";
import { handleSubscriptionRequest, SubscriptionStore } from "./subscriptions/index.js";
import { providerBaseUrls } from "./subscriptions/resets.js";
import { refreshStaleUsage } from "./subscriptions/usage.js";

const SUBSCRIPTION_ROUTES = "/v1/organizations/current/credentials";
// The models Dari serves, which the Dari CLI's model picker offers.
const CANONICAL_MODELS_ROUTE = "/v1/canonical-models";
// How often a connected gateway reads idle plans' usage, so hosted Dari's
// meters move without a request here.
const IDLE_USAGE_INTERVAL_MS = 5 * 60_000;

/**
 * Start a self-hosted Dari Gateway from environment variables:
 *
 * - `DARI_GATEWAY_KEYS` (required): comma-separated bearer keys clients use.
 * - `DARI_GATEWAY_CONFIG`: router config file. Unset, `dari-gateway.yaml`
 *   serves when present, and otherwise the default router.
 * - `DARI_GATEWAY_ROUTERS_DIR`: a directory of router specs, read at startup:
 *   each `<id>.yaml` (or `.yml`) is router `<id>`, served in place of a
 *   config file router of that id. Specs saved through `PUT /v1/routers/<id>`
 *   are served in place of both.
 * - `DARI_GATEWAY_DB`: SQLite database for subscriptions, Dari Link grants,
 *   saved model lists and router specs, prefix-cache state, and Activity:
 *   each request's log row and, outside ZDR routers, its request and response
 *   bodies (default `dari-gateway.db`). It holds subscription tokens.
 * - `DARI_GATEWAY_ENCRYPTION_KEY`: encrypts the subscription tokens and API
 *   keys in the database (`openssl rand -base64 32`; see secret_box.ts for
 *   rotation). Unset, they are stored as they are, and the Dari Link approval
 *   page takes nobody's subscriptions or keys.
 * - `DARI_LINK_SESSION_SECRET`: signs the cookie that remembers a Dari Link
 *   approval page's user. Unset, each process makes its own, so a restart
 *   forgets who connected which plans.
 * - `DARI_AUTO_ROUTING_API_KEY`: choose among a router's models with Dari
 *   Auto Routing; without it, `dari/routing` serves the first listed model.
 * - `PORT` (default 8080), `DARI_GATEWAY_HOST` (default 127.0.0.1; the container
 *   image sets 0.0.0.0), and each provider's standard API key variable.
 * - `DARI_HOSTED_URL` and `DARI_HOSTED_API_KEY`: connect the gateway to hosted
 *   Dari (connected.ts), with `DARI_GATEWAY_ID`, `DARI_GATEWAY_NAME`, and
 *   `DARI_GATEWAY_ENCRYPTION_KEY`. It then serves the user's hosted routers on
 *   its own plans and then on hosted Dari, and syncs its plans and requests
 *   there; Dari Link and Activity are hosted's.
 */
export async function startSelfHostedGateway(env: Record<string, string> = process.env as Record<string, string>) {
  const hosted = hostedConnectionFromEnv(env);
  const gatewayKeys = (env.DARI_GATEWAY_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  if (gatewayKeys.length === 0) {
    throw new Error("Set DARI_GATEWAY_KEYS to the comma-separated keys clients authenticate with.");
  }
  const config = await loadGatewayConfig(env.DARI_GATEWAY_CONFIG?.trim() || undefined);
  const routersDir = env.DARI_GATEWAY_ROUTERS_DIR?.trim();
  const specFiles = routersDir ? await loadRouterSpecDirectory(routersDir) : undefined;
  const databasePath = env.DARI_GATEWAY_DB ?? "dari-gateway.db";
  const created = databasePath !== ":memory:" && !existsSync(databasePath);
  const db = new Database(databasePath, { create: true });
  if (created) chmodSync(databasePath, 0o600);
  db.exec("PRAGMA journal_mode = WAL");
  const secrets = secretBoxFromEnv(env.DARI_GATEWAY_ENCRYPTION_KEY);
  if (secrets === null) {
    console.warn(
      "dari-gateway stores subscription tokens unencrypted; set DARI_GATEWAY_ENCRYPTION_KEY (openssl rand -base64 32) to encrypt them",
    );
  }
  const subscriptions = new SubscriptionStore(db, secrets);
  const prefixes = new PrefixStore(db);
  const sessionPins = new SessionPinStore(db);
  const routerModels = new RouterModelStore(db);
  const routerSpecs = new RouterSpecStore(db, specFiles);
  const routers: ServedRouters = { config, routerModels, routerSpecs };
  const links = new SqliteLinkStore(db, secrets);
  const activity = new ActivityStore(db);
  // Activity lists the routers served, so it follows each saved spec.
  const syncActivityRouters = () => activity.syncDirectory(
    SELF_HOSTED_ORGANIZATION_ID,
    servedRouterIds(routers).map((id) => ({ id, zdr: servedRouter(routers, id)!.zdr })),
    gatewayKeys.length,
  );
  syncActivityRouters();
  // Pi's provider auth reads each provider's standard key variable, such as
  // OPENAI_API_KEY, from this environment only.
  const piModels = builtinModels({
    authContext: { env: async (name) => env[name], fileExists: async () => false },
  });

  const providerApiKey = async (provider: string) => (await piModels.getAuth(provider))?.auth.apiKey;
  const autoRoutingKey = hosted?.apiKey ?? env.DARI_AUTO_ROUTING_API_KEY?.trim();
  const sync = hosted === null ? null : new HostedSync(db, subscriptions, hosted, fetch);
  // The hosted router, read once a minute, for both serving and routing calls.
  const hostedRouter = hosted === null ? null : hostedRouters(hosted, fetch);
  const baseUrls = providerBaseUrls(config.providers);
  if (sync !== null) {
    subscriptions.onChange = (change) => change === "usage" ? sync.usageChanged() : sync.plansChanged();
  }
  const platformDeps = {
    activity,
    config,
    routerModels,
    routerSpecs,
    gatewayKeys,
    subscriptions,
    links,
    prefixes,
    sessionPins,
    providerApiKey,
    autoRouting: Boolean(autoRoutingKey),
    env,
    fetch,
  };
  const platform = hosted === null || sync === null || hostedRouter === null
    ? createSelfHostedPlatform(platformDeps)
    : createConnectedPlatform({ ...platformDeps, hosted, sync, hostedRouter });
  // A model without a credential is dropped at request time, so a missing key
  // would otherwise surface only as a 424 on the first request.
  const warnWithoutCredentials = async (routerId: string, router: RouterConfig) => {
    const missing = await providersWithoutCredentials({ config, subscriptions, providerApiKey, env }, router);
    if (missing.length > 0) {
      console.warn(
        "dari-gateway router has providers without credentials; their models are not served",
        JSON.stringify({ router: routerId, providers: missing }),
      );
    }
  };
  const served = servedRouterIds(routers).map((routerId) => [routerId, servedRouter(routers, routerId)!] as const);
  // A connected gateway serves hosted routers, not these.
  if (hosted === null) for (const [routerId, router] of served) await warnWithoutCredentials(routerId, router);
  await checkConfiguredProviderKeys(config, served.map(([, router]) => router), (provider) =>
    configuredProviderApiKey({ config, providerApiKey, env }, provider));
  // A saved or removed spec changes what is served at once.
  const routersChanged = (routerId: string) => {
    syncActivityRouters();
    const router = servedRouter(routers, routerId);
    if (router !== undefined) void warnWithoutCredentials(routerId, router);
  };
  const selectorBackend: SelectorBackend = autoRoutingKey
    ? createAutoRoutingSelectorBackend({
        apiKey: autoRoutingKey,
        ...(hosted !== null
          ? { endpoint: `${hosted.url}/v1/auto-router` }
          : env.DARI_AUTO_ROUTING_URL ? { endpoint: env.DARI_AUTO_ROUTING_URL } : {}),
      })
    : createPrioritySelectorBackend();
  const routed = createRequestHandler({ platform, selectorBackend });
  const gateway = hosted === null || sync === null || hostedRouter === null
    ? routed
    : connectedHandler({ gateway: routed, gatewayKeys, hosted, hostedRouter, fetch });

  // Subscriptions, model lists, and router specs are managed with any gateway
  // key; every other path is the gateway's own.
  const handler = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const manages = pathname === SUBSCRIPTION_ROUTES
      || pathname.startsWith(`${SUBSCRIPTION_ROUTES}/`)
      || pathname === CANONICAL_MODELS_ROUTE
      || ROUTER_MODELS_ROUTE.test(pathname)
      || ROUTERS_ROUTE.test(pathname);
    if (!manages) return await gateway(request);
    try {
      if (gatewayKeyIndex(gatewayKeys, bearerToken(request.headers)) === null) {
        throw new HttpError(401, "Missing or invalid gateway key.", "authentication_error");
      }
    } catch (error) {
      return errorResponse(error);
    }
    if (pathname === CANONICAL_MODELS_ROUTE && request.method === "GET") {
      return Response.json({ data: CANONICAL_MODELS }, { headers: { "Cache-Control": "no-store" } });
    }
    return (await handleSubscriptionRequest(request, {
      store: subscriptions,
      fetch,
      baseUrls,
      ...(hosted === null ? {} : { hostedAccounts: () => readHostedAccounts(hosted, fetch) }),
    }))
      ?? (await handleRouterModelsRequest(request, routers))
      ?? (await handleRouterSpecsRequest(request, { ...routers, changed: routersChanged }))
      ?? errorResponse(new HttpError(404, "Not found", "not_found"));
  };

  const port = Number(env.PORT ?? "8080");
  // Loopback unless DARI_GATEWAY_HOST says otherwise (see the doc comment).
  const hostname = (env.DARI_GATEWAY_HOST ?? "").trim() || "127.0.0.1";
  const server = startServer(port, handler, { hostname });
  console.info(
    "dari-gateway listening",
    JSON.stringify({
      hostname,
      // The bound port, so PORT=0 reports the port the OS assigned.
      port: server.port,
      routers: servedRouterIds(routers),
      // These serve lists saved with `dari gateway models`, not the config file's.
      saved_model_lists: routerModels.routersWithSavedLists(),
      // These serve router specs saved through the API.
      saved_routers: routerSpecs.savedIds(),
      auto_routing: autoRoutingKey ? "dari" : "priority",
      ...(hosted === null ? {} : { connected: { hosted_url: hosted.url, gateway_id: hosted.gatewayId } }),
    }),
  );
  if (env.DARI_SESSION_PORT_FILE) await Bun.write(env.DARI_SESSION_PORT_FILE, String(server.port));
  sync?.start();
  const idleUsage = sync === null ? null : setInterval(() => {
    void refreshStaleUsage(subscriptions, { fetch, baseUrls });
  }, IDLE_USAGE_INTERVAL_MS);
  idleUsage?.unref?.();
  return {
    server,
    close: () => {
      if (idleUsage !== null) clearInterval(idleUsage);
      sync?.stop();
      db.close();
    },
  };
}

/**
 * Check each provider API key the routers use before serving: a key its
 * provider rejects fails startup, and one no check could answer is reported.
 */
async function checkConfiguredProviderKeys(
  config: GatewayConfig,
  routers: readonly RouterConfig[],
  providerApiKey: (provider: string) => Promise<string | undefined>,
): Promise<void> {
  const providers = new Set(
    routers.flatMap((router) => allRouterModels(router).map(modelProvider)),
  );
  const checks = await Promise.all([...providers].map(async (provider) => {
    const endpoint = config.providers[provider];
    // Endpoints configured without a key variable take no key.
    if (endpoint !== undefined && endpoint.apiKeyEnv === undefined) return null;
    const key = await providerApiKey(provider);
    if (key === undefined) return null;
    return { provider, ...(await checkProviderKey({ provider, key, ...(endpoint ? { endpoint } : {}), fetch })) };
  }));
  const rejected = checks.flatMap((check) => check?.result === "rejected" ? [`${check.provider} (${check.status})`] : []);
  if (rejected.length > 0) {
    throw new Error(
      `Provider API keys were rejected: ${rejected.join(", ")}. Fix or unset each key before starting the gateway.`,
    );
  }
  const unchecked = checks.flatMap((check) => check?.result === "unchecked" ? [check.provider] : []);
  if (unchecked.length > 0) {
    console.warn("dari-gateway could not check these provider API keys", JSON.stringify({ providers: unchecked }));
  }
}

/** Run the gateway as a process: the `dari-gateway` bin and compiled binary. */
export async function runSelfHostedGateway(): Promise<void> {
  // Startup errors are configuration mistakes: print the message, not a stack.
  const started = await startSelfHostedGateway().catch((error: unknown) => {
    console.error(`dari-gateway: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
  installShutdownHandlers(started.server, async () => started.close());
}

if (import.meta.main) await runSelfHostedGateway();
