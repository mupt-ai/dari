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
import { createSelfHostedPlatform } from "./platform.js";
import { providerForModel } from "@mupt-ai/dari-router/policy-engine";
import { checkProviderKey } from "../providers/key_check.js";
import { CANONICAL_MODELS } from "../models/canonical.js";
import { DEFAULT_GATEWAY_CONFIG, loadGatewayConfig, type GatewayConfig } from "./config.js";
import { configuredProviderApiKey, gatewayKeyIndex, providersWithoutCredentials } from "./resolve.js";
import { PrefixStore } from "./prefix_store.js";
import { SessionPinStore } from "./session_pin_store.js";
import { handleSubscriptionRequest, SubscriptionStore } from "./subscriptions/index.js";

const SUBSCRIPTION_ROUTES = "/v1/organizations/current/credentials";

/**
 * Start a self-hosted Dari Gateway from environment variables:
 *
 * - `DARI_GATEWAY_KEYS` (required): comma-separated bearer keys clients use.
 * - `DARI_GATEWAY_CONFIG`: router config file. Unset, `dari-gateway.yaml`
 *   serves when present, and otherwise the default router.
 * - `DARI_GATEWAY_DB`: SQLite database for subscriptions and prefix-cache
 *   state (default `dari-gateway.db`). It holds subscription tokens.
 * - `DARI_AUTO_ROUTING_API_KEY`: choose among a router's models with Dari
 *   Auto Routing; without it, `dari/routing` serves the first listed model.
 * - `PORT` (default 8080), `DARI_GATEWAY_HOST` (default 127.0.0.1; the container
 *   image sets 0.0.0.0), and each provider's standard API key variable.
 */
export async function startSelfHostedGateway(env: Record<string, string> = process.env as Record<string, string>) {
  const gatewayKeys = (env.DARI_GATEWAY_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  if (gatewayKeys.length === 0) {
    throw new Error("Set DARI_GATEWAY_KEYS to the comma-separated keys clients authenticate with.");
  }
  const config = await loadGatewayConfig(env.DARI_GATEWAY_CONFIG?.trim() || undefined);
  const databasePath = env.DARI_GATEWAY_DB ?? "dari-gateway.db";
  const created = databasePath !== ":memory:" && !existsSync(databasePath);
  const db = new Database(databasePath, { create: true });
  if (created) chmodSync(databasePath, 0o600);
  db.exec("PRAGMA journal_mode = WAL");
  const subscriptions = new SubscriptionStore(db);
  const prefixes = new PrefixStore(db);
  const sessionPins = new SessionPinStore(db);
  // Pi's provider auth reads each provider's standard key variable, such as
  // OPENAI_API_KEY, from this environment only.
  const piModels = builtinModels({
    authContext: { env: async (name) => env[name], fileExists: async () => false },
  });

  const providerApiKey = async (provider: string) => (await piModels.getAuth(provider))?.auth.apiKey;
  const autoRoutingKey = env.DARI_AUTO_ROUTING_API_KEY?.trim();
  const platform = createSelfHostedPlatform({
    config,
    gatewayKeys,
    subscriptions,
    prefixes,
    sessionPins,
    providerApiKey,
    autoRouting: Boolean(autoRoutingKey),
    env,
    fetch,
  });
  // A model without a credential is dropped at request time, so a missing key
  // would otherwise surface only as a 424 on the first request.
  for (const [routerId, router] of Object.entries(config.routers)) {
    const missing = await providersWithoutCredentials({ config, subscriptions, providerApiKey, env }, router);
    if (missing.length > 0) {
      console.warn(
        "dari-gateway router has providers without credentials; their models are not served",
        JSON.stringify({ router: routerId, providers: missing }),
      );
    }
  }
  await checkConfiguredProviderKeys(config, (provider) =>
    configuredProviderApiKey({ config, providerApiKey, env }, provider));
  const selectorBackend: SelectorBackend = autoRoutingKey
    ? createAutoRoutingSelectorBackend({
        apiKey: autoRoutingKey,
        ...(env.DARI_AUTO_ROUTING_URL ? { endpoint: env.DARI_AUTO_ROUTING_URL } : {}),
      })
    : createPrioritySelectorBackend();
  const gateway = createRequestHandler({ platform, selectorBackend });

  const handler = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname !== SUBSCRIPTION_ROUTES && !pathname.startsWith(`${SUBSCRIPTION_ROUTES}/`)) {
      return await gateway(request);
    }
    try {
      if (gatewayKeyIndex(gatewayKeys, bearerToken(request.headers)) === null) {
        throw new HttpError(401, "Missing or invalid gateway key.", "authentication_error");
      }
    } catch (error) {
      return errorResponse(error);
    }
    return (await handleSubscriptionRequest(request, { store: subscriptions, fetch }))
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
      routers: Object.keys(config.routers),
      auto_routing: autoRoutingKey ? "dari" : "priority",
    }),
  );
  return { server, close: () => db.close() };
}

/**
 * Check each provider API key the routers use before serving: a key its
 * provider rejects fails startup, and one no check could answer is reported.
 */
async function checkConfiguredProviderKeys(
  config: GatewayConfig,
  providerApiKey: (provider: string) => Promise<string | undefined>,
): Promise<void> {
  const providers = new Set(
    Object.values(config.routers).flatMap((router) => router.models.map((model) => providerForModel(model.id))),
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
  // `--print-config` prints the router config the gateway would serve, as
  // JSON, and exits; `--print-default-config` prints the built-in default.
  // The Dari CLI edits a local gateway's models from them.
  if (process.argv.includes("--print-canonical-models")) {
    console.log(JSON.stringify(CANONICAL_MODELS));
    return;
  }
  if (process.argv.includes("--print-default-config")) {
    console.log(JSON.stringify(DEFAULT_GATEWAY_CONFIG));
    return;
  }
  if (process.argv.includes("--print-config")) {
    try {
      const config = await loadGatewayConfig(process.env.DARI_GATEWAY_CONFIG?.trim() || undefined);
      console.log(JSON.stringify(config));
      return;
    } catch (error) {
      console.error(`dari-gateway: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }
  // Startup errors are configuration mistakes: print the message, not a stack.
  const started = await startSelfHostedGateway().catch((error: unknown) => {
    console.error(`dari-gateway: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
  installShutdownHandlers(started.server, async () => started.close());
}

if (import.meta.main) await runSelfHostedGateway();
