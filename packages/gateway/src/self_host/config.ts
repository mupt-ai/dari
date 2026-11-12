import {
  isReasoningEffort,
  isRecord,
  type ReasoningEffort,
} from "@mupt-ai/dari-router/policy-engine";

import { CLIENT_HARNESSES } from "../ingress/client_harness.js";
import type { ClientHarness } from "../types.js";

/**
 * The self-hosted gateway's configuration file (YAML or JSON):
 *
 * ```yaml
 * routers:
 *   default:
 *     models:
 *       - anthropic/claude-sonnet-5-5
 *       - id: openai/gpt-6.1-sol
 *         thinking: [medium, high]
 *     agentModels:          # optional: a coding agent's own list
 *       codex:
 *         - openai/gpt-6.1-sol
 *     subscriptions: true   # serve with connected Claude Code / ChatGPT plans
 *     sessionPinning: false # route each session and subagent once, then keep its model
 * providers:                # optional: OpenAI-compatible or self-run endpoints
 *   local:
 *     baseUrl: http://localhost:8000/v1
 *     apiKeyEnv: LOCAL_API_KEY
 * ```
 *
 * Secrets never live here: gateway keys come from `DARI_GATEWAY_KEYS`,
 * provider API keys from each provider's standard environment variable, and
 * personal subscriptions from the gateway database. Model lists saved through
 * the gateway's API (`dari gateway models`) live in the database too, and are
 * served in place of this file's.
 */
export type GatewayConfig = {
  routers: Record<string, RouterConfig>;
  providers: Record<string, ProviderEndpointConfig>;
};

// An endpoint for a provider id, used by every model with that prefix. Known
// providers need no entry; their endpoints and API keys come from the model
// catalog and standard environment variables.
export type ProviderEndpointConfig = {
  baseUrl: string;
  // The wire API, e.g. `openai-completions` (default) or `anthropic-messages`.
  api: string;
  // Environment variable holding the endpoint's API key; absent sends none.
  apiKeyEnv?: string;
};

export type RouterConfig = {
  models: RouterModelConfig[];
  // A coding agent's own models, served to it in place of `models`.
  agentModels: Partial<Record<ClientHarness, RouterModelConfig[]>>;
  retries: number;
  subscriptions: boolean;
  sessionPinning: boolean;
  zdr: boolean;
};

export type RouterModelConfig = {
  // Canonical `provider/model` id, e.g. `anthropic/claude-sonnet-5-5`.
  id: string;
  // Thinking levels the router offers; absent offers every level the model
  // supports.
  thinking?: ReasoningEffort[];
};

const ROUTER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*\/\S+$/;

// Served when no config file is set or found. A model is served once its
// provider has a credential (a connected subscription or the provider's API
// key); dari/routing without Auto Routing serves the first available one.
export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = parseGatewayConfig({
  routers: {
    default: {
      models: [
        "anthropic/claude-sonnet-5-5",
        "anthropic/claude-opus-5-5",
        "anthropic/claude-fable-5-2",
        "anthropic/claude-haiku-5-5",
        "openai/gpt-6.1-sol",
        "openai/gpt-6.1-terra",
      ],
    },
  },
});

const DEFAULT_CONFIG_PATH = "dari-gateway.yaml";

/**
 * Load the config at `path`, which must exist. Without a path, load
 * `dari-gateway.yaml` from the working directory when present, and otherwise
 * serve DEFAULT_GATEWAY_CONFIG.
 */
export async function loadGatewayConfig(path: string | undefined): Promise<GatewayConfig> {
  if (path === undefined) {
    if (!(await Bun.file(DEFAULT_CONFIG_PATH).exists())) return DEFAULT_GATEWAY_CONFIG;
    path = DEFAULT_CONFIG_PATH;
  }
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(
      `Gateway config not found at ${path}. Write one from dari-gateway.example.yaml, `
        + "or unset DARI_GATEWAY_CONFIG to serve the default router "
        + "(in the container image, mount it at /config/dari-gateway.yaml).",
    );
  }
  const text = await file.text();
  const raw: unknown = path.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text);
  return parseGatewayConfig(raw);
}

export function parseGatewayConfig(raw: unknown): GatewayConfig {
  if (!isRecord(raw) || !isRecord(raw.routers)) {
    throw new Error("Gateway config needs a `routers` map.");
  }
  const routers: Record<string, RouterConfig> = {};
  for (const [id, router] of Object.entries(raw.routers)) {
    if (!ROUTER_ID_PATTERN.test(id)) {
      throw new Error(`Router id "${id}" may use only letters, digits, "-" and "_".`);
    }
    routers[id] = parseRouter(id, router);
  }
  if (Object.keys(routers).length === 0) {
    throw new Error("Gateway config needs at least one router.");
  }
  const providers: Record<string, ProviderEndpointConfig> = {};
  if (raw.providers !== undefined) {
    if (!isRecord(raw.providers)) throw new Error("`providers` must be a map of provider ids.");
    for (const [id, provider] of Object.entries(raw.providers)) {
      if (!PROVIDER_ID_PATTERN.test(id)) {
        throw new Error(`Provider id "${id}" may use only lowercase letters, digits, "." and "-".`);
      }
      providers[id] = parseProvider(id, provider);
    }
  }
  return { routers, providers };
}

function parseProvider(id: string, raw: unknown): ProviderEndpointConfig {
  if (!isRecord(raw) || typeof raw.baseUrl !== "string" || !URL.canParse(raw.baseUrl)) {
    throw new Error(`Provider "${id}" needs a \`baseUrl\` URL.`);
  }
  if (raw.api !== undefined && (typeof raw.api !== "string" || !raw.api.trim())) {
    throw new Error(`providers.${id}.api must be a wire API name.`);
  }
  if (raw.apiKeyEnv !== undefined && (typeof raw.apiKeyEnv !== "string" || !raw.apiKeyEnv.trim())) {
    throw new Error(`providers.${id}.apiKeyEnv must name an environment variable.`);
  }
  return {
    baseUrl: raw.baseUrl.replace(/\/+$/, ""),
    api: typeof raw.api === "string" ? raw.api.trim() : "openai-completions",
    ...(typeof raw.apiKeyEnv === "string" ? { apiKeyEnv: raw.apiKeyEnv.trim() } : {}),
  };
}

/** The models a router serves a client: its coding agent's own list, else the router's. */
export function routerModelsFor(router: RouterConfig, clientHarness?: ClientHarness): RouterModelConfig[] {
  return (clientHarness === undefined ? undefined : router.agentModels[clientHarness]) ?? router.models;
}

/** Every model a router can serve, to any client. */
export function allRouterModels(router: RouterConfig): RouterModelConfig[] {
  return [router.models, ...Object.values(router.agentModels)].flat();
}

function parseRouter(id: string, raw: unknown): RouterConfig {
  if (!isRecord(raw)) throw new Error(`Router "${id}" needs a non-empty \`models\` list.`);
  const agentModels: RouterConfig["agentModels"] = {};
  if (raw.agentModels !== undefined) {
    if (!isRecord(raw.agentModels)) {
      throw new Error(`routers.${id}.agentModels must map coding agents to model lists.`);
    }
    for (const [agent, models] of Object.entries(raw.agentModels)) {
      if (!CLIENT_HARNESSES.includes(agent)) {
        throw new Error(
          `Router "${id}" has models for an unknown coding agent "${agent}"; use ${CLIENT_HARNESSES.join(", ")}.`,
        );
      }
      agentModels[agent as ClientHarness] = parseRouterModels(id, `agentModels.${agent}`, models);
    }
  }
  return {
    models: parseRouterModels(id, "models", raw.models),
    agentModels,
    retries: optionalRetries(raw.retries, `routers.${id}.retries`) ?? 1,
    subscriptions: optionalBoolean(raw.subscriptions, `routers.${id}.subscriptions`) ?? true,
    sessionPinning: optionalBoolean(raw.sessionPinning, `routers.${id}.sessionPinning`) ?? false,
    zdr: optionalBoolean(raw.zdr, `routers.${id}.zdr`) ?? false,
  };
}

/** Read one model list of a router, naming `field` in what it rejects. */
export function parseRouterModels(routerId: string, field: string, raw: unknown): RouterModelConfig[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Router "${routerId}" needs a non-empty \`${field}\` list.`);
  }
  const models = raw.map((model) => parseModel(routerId, model));
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) throw new Error(`Router "${routerId}" lists ${model.id} twice in \`${field}\`.`);
    seen.add(model.id);
  }
  return models;
}

function parseModel(routerId: string, raw: unknown): RouterModelConfig {
  const entry = typeof raw === "string" ? { id: raw } : raw;
  if (!isRecord(entry) || typeof entry.id !== "string" || !MODEL_ID_PATTERN.test(entry.id)) {
    throw new Error(
      `Router "${routerId}" has an invalid model; use a canonical "provider/model" id.`,
    );
  }
  if (entry.thinking === undefined) return { id: entry.id };
  if (
    !Array.isArray(entry.thinking) ||
    entry.thinking.length === 0 ||
    !entry.thinking.every(isReasoningEffort)
  ) {
    throw new Error(
      `Model ${entry.id} on router "${routerId}" has invalid thinking levels; use off, minimal, low, medium, high, xhigh, or max.`,
    );
  }
  return { id: entry.id, thinking: [...new Set(entry.thinking)] };
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be true or false.`);
  return value;
}

function optionalRetries(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 5) {
    throw new Error(`${field} must be an integer from 0 to 5.`);
  }
  return value;
}
