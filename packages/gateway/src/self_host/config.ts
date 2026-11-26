import {
  isReasoningEffort,
  isRecord,
  providerForModel,
  type ReasoningEffort,
} from "@mupt-ai/dari-router/policy-engine";

import { CLIENT_HARNESSES } from "../ingress/client_harness.js";
import { checkSources, DEFAULT_RESET_MIN_HOURS, type Source } from "../models/sources.js";
import { otherModelProviders, providerModel } from "../models/canonical.js";
import type { ClientHarness, RouterRole, RouterRoleModels, RouterRolePrompts } from "../types.js";

/**
 * The self-hosted gateway's configuration file (YAML or JSON):
 *
 * ```yaml
 * routers:
 *   default:
 *     models:
 *       - anthropic/claude-sonnet-5-5
 *       - id: openai/gpt-6.2-sol
 *         thinking: [medium, high]
 *     agentModels:          # optional: a coding agent's own list
 *       codex:
 *         - openai/gpt-6.2-sol
 *       - id: anthropic/claude-opus-5-5
 *         sources: [plan, reset, key] # optional; default [plan, key]
 *     resetMinHours: 24     # spend a banked reset only when a plan is out this long
 *     sessionPinning: false # route each session and subagent once, then keep its model
 *     roleModels:           # optional: serve an agent role one model, without routing
 *       main: anthropic/claude-fable-5-2
 *       subagent: openai/gpt-6.2-sol
 *     rolePrompts:          # optional: append to an agent role's system prompt
 *       main: Delegate codebase exploration to subagents.
 *     nativeCompaction: false # let Codex compact server-side with the provider's native compaction
 * link:                     # optional: Dari Link
 *   allowHttpRedirectHosts:  # http (not https) redirect URIs allowed on these
 *     - "*.example.ts.net"   # private dev hosts; `*.` matches any subdomain
 * providers:                # optional: OpenAI-compatible or self-run endpoints
 *   local:
 *     baseUrl: http://localhost:8000/v1
 *     apiKeyEnv: LOCAL_API_KEY
 *   openai-codex:            # optional: where ChatGPT plan requests go (a proxy)
 *     baseUrl: https://chatgpt.com/backend-api
 * ```
 *
 * Secrets never live here: gateway keys come from `DARI_GATEWAY_KEYS`,
 * provider API keys from each provider's standard environment variable, and
 * personal subscriptions from the gateway database. Model lists saved through
 * the gateway's API (`dari gateway models`) live in the database too, and are
 * served in place of this file's. So do router specs (parseRouterSpec), each a
 * whole router, which are served in place of this file's router of their id.
 */
export type GatewayConfig = {
  routers: Record<string, RouterConfig>;
  providers: Record<string, ProviderEndpointConfig>;
  link?: LinkConfig;
};

export type LinkConfig = {
  // Hosts besides loopback an app may register an http redirect URI on: exact
  // names, or `*.suffix`. Default none: https or loopback only.
  allowHttpRedirectHosts: string[];
};

const REDIRECT_HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

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
  // Spend a banked reset only when the plan would otherwise stay out this long.
  resetMinHours: number;
  sessionPinning: boolean;
  nativeCompaction: boolean;
  zdr: boolean;
  // Fixed models for agent roles (subagents include workflow agents); a role
  // without one is routed.
  roleModels: RouterRoleModels;
  // Text appended to the end of each role's system prompt.
  rolePrompts: RouterRolePrompts;
};

export type RouterModelConfig = {
  // Canonical `provider/model` id, e.g. `anthropic/claude-sonnet-5-5`.
  id: string;
  // Thinking levels the router offers; absent offers every level the model
  // supports.
  thinking?: ReasoningEffort[];
  // The provider that serves the model when not the one its id names, such as
  // `opencode-go` for `deepseek-ai/DeepSeek-V4.1-Flash-1017`.
  provider?: string;
  // Where the model is served from, in order (models/sources.ts); absent
  // means SELF_HOSTED_DEFAULT_SOURCES.
  sources?: Source[];
};

/** The provider that serves a router's model, whose credential it needs. */
export function modelProvider(model: RouterModelConfig): string {
  return model.provider ?? providerForModel(model.id);
}

export const ROUTER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
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
        "openai/gpt-6.2-sol",
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
  return { routers, providers, ...(raw.link === undefined ? {} : { link: parseLink(raw.link) }) };
}

function parseLink(raw: unknown): LinkConfig {
  if (!isRecord(raw)) throw new Error("`link` must be a map.");
  const hosts = raw.allowHttpRedirectHosts ?? [];
  if (!Array.isArray(hosts) || !hosts.every((host) => typeof host === "string" && REDIRECT_HOST_PATTERN.test(host.toLowerCase()))) {
    throw new Error("link.allowHttpRedirectHosts must list host names, each optionally starting with `*.`.");
  }
  return { allowHttpRedirectHosts: (hosts as string[]).map((host) => host.toLowerCase()) };
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
  const agentModels = parseAgentModels(id, `routers.${id}.agentModels`, raw.agentModels);
  const models = parseRouterModels(id, "models", raw.models);
  return {
    models,
    agentModels,
    roleModels: parseRoleMap(`routers.${id}.roleModels`, raw.roleModels, (field, model) =>
      roleModel(field, model, [models, ...Object.values(agentModels)].flat())),
    rolePrompts: parseRoleMap(`routers.${id}.rolePrompts`, raw.rolePrompts, rolePrompt),
    retries: optionalRetries(raw.retries, `routers.${id}.retries`) ?? 1,
    resetMinHours: optionalResetMinHours(raw.resetMinHours, `routers.${id}.resetMinHours`),
    sessionPinning: optionalBoolean(raw.sessionPinning, `routers.${id}.sessionPinning`) ?? false,
    nativeCompaction: optionalBoolean(raw.nativeCompaction, `routers.${id}.nativeCompaction`) ?? false,
    zdr: optionalBoolean(raw.zdr, `routers.${id}.zdr`) ?? false,
  };
}

function parseAgentModels(routerId: string, field: string, raw: unknown): RouterConfig["agentModels"] {
  const agentModels: RouterConfig["agentModels"] = {};
  if (raw == null) return agentModels;
  if (!isRecord(raw)) throw new Error(`${field} must map coding agents to model lists.`);
  for (const [agent, models] of Object.entries(raw)) {
    if (!CLIENT_HARNESSES.includes(agent)) {
      throw new Error(
        `Router "${routerId}" has models for an unknown coding agent "${agent}"; use ${CLIENT_HARNESSES.join(", ")}.`,
      );
    }
    agentModels[agent as ClientHarness] = parseRouterModels(routerId, `${field}.${agent}`, models);
  }
  return agentModels;
}

const ROUTER_ROLES: readonly RouterRole[] = ["main", "subagent"];

// A map of main and subagent to values `read` checks, leaving out nulls.
function parseRoleMap(
  field: string,
  raw: unknown,
  read: (field: string, value: unknown) => string,
): Partial<Record<RouterRole, string>> {
  if (raw == null) return {};
  if (!isRecord(raw)) throw new Error(`${field} must map main and subagent.`);
  const roles: Partial<Record<RouterRole, string>> = {};
  for (const [role, value] of Object.entries(raw)) {
    if (!(ROUTER_ROLES as readonly string[]).includes(role)) {
      throw new Error(`${field} has an unknown role "${role}"; use main or subagent.`);
    }
    if (value !== null) roles[role as RouterRole] = read(`${field}.${role}`, value);
  }
  return roles;
}

function roleModel(field: string, model: unknown, models: readonly RouterModelConfig[]): string {
  if (typeof model !== "string" || !models.some((listed) => listed.id === model)) {
    throw new Error(`${field} must be one of the router's models.`);
  }
  return model;
}

export const ROLE_PROMPT_MAX_LENGTH = 4000;

function rolePrompt(field: string, prompt: unknown): string {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > ROLE_PROMPT_MAX_LENGTH) {
    throw new Error(`${field} must be text of at most ${ROLE_PROMPT_MAX_LENGTH} characters.`);
  }
  return prompt.trim();
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
  const model: RouterModelConfig = { id: entry.id };
  if (entry.sources != null) {
    const checked = checkSources(entry.sources);
    if ("error" in checked) throw new Error(`Model ${entry.id} on router "${routerId}": ${checked.error}`);
    model.sources = checked.sources;
  }
  if (entry.thinking != null) {
    if (
      !Array.isArray(entry.thinking) ||
      entry.thinking.length === 0 ||
      !entry.thinking.every(isReasoningEffort)
    ) {
      throw new Error(
        `Model ${entry.id} on router "${routerId}" has invalid thinking levels; use off, minimal, low, medium, high, xhigh, or max.`,
      );
    }
    model.thinking = [...new Set(entry.thinking)];
  }
  if (entry.provider != null && entry.provider !== providerForModel(entry.id)) {
    if (typeof entry.provider !== "string" || providerModel(entry.id, entry.provider) === undefined) {
      const others = otherModelProviders(entry.id);
      throw new Error(
        `Model ${entry.id} on router "${routerId}" cannot be served by provider ${String(entry.provider)} on a self-hosted gateway; `
          + `${others.length > 0 ? `use ${others.join(" or ")}, or ` : ""}leave out \`provider\` to use ${providerForModel(entry.id)}.`,
      );
    }
    model.provider = entry.provider;
  }
  return model;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be true or false.`);
  return value;
}

function optionalResetMinHours(value: unknown, field: string): number {
  if (value === undefined) return DEFAULT_RESET_MIN_HOURS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a number of hours, 0 or more.`);
  }
  return value;
}

function optionalRetries(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 5) {
    throw new Error(`${field} must be an integer from 0 to 5.`);
  }
  return value;
}

/**
 * A router spec: a whole router as one document, the same one hosted Dari
 * applies (`dari router apply`), with no credentials:
 *
 * ```yaml
 * name: Opus 5.5 + DeepSeek Subagents
 * reset_min_hours: 24
 * models:
 *   - id: anthropic/claude-opus-5-5
 *     sources: [plan, reset, key]  # default [plan, key]
 *   - id: deepseek-ai/DeepSeek-V4.1-Flash-1017
 *     thinking: [high]
 *     provider: opencode-go   # served by this provider, not the one its id names
 * roles:
 *   main: { model: anthropic/claude-opus-5-5 }
 *   subagent: { model: deepseek-ai/DeepSeek-V4.1-Flash-1017, prompt: Be brief. }
 * routing: { session_pinning: false, retries: 1 }
 * payment: { allow: [subscription, key, credits] }
 * native_compaction: false
 * agents: { codex: [openai/gpt-6.1-sol] }
 * ```
 *
 * Each model's `sources` decide whether connected plans or provider API keys
 * serve it; the gateway has no credits. `payment` is checked and left unused.
 * `hosted` settings and a model's `fast` apply only on hosted Dari, and are
 * accepted and left unused; `routing.rules` runs only there and is refused.
 */
export type RouterSpec = { name: string; router: RouterConfig };

const SPEC_FIELDS = ["name", "reset_min_hours", "models", "roles", "routing", "payment", "native_compaction", "agents", "hosted"];
const SPEC_MODEL_FIELDS = ["id", "thinking", "provider", "fast", "sources"];
const PAYMENT_KINDS = ["subscription", "key", "credits"];
const SPEC_NAME_MAX_LENGTH = 120;

/** Read a router spec's YAML (or JSON) text; YAML 1.2, so `off` stays a thinking level. */
export function parseRouterSpecText(text: string): unknown {
  try {
    return Bun.YAML.parse(text);
  } catch (error) {
    throw new Error(`The router spec is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Check a router spec and read it as the router `id` serves it. */
export function parseRouterSpec(id: string, raw: unknown): RouterSpec {
  const spec = specMap("The router spec", raw, SPEC_FIELDS);
  if (typeof spec.name !== "string" || !spec.name.trim() || spec.name.length > SPEC_NAME_MAX_LENGTH) {
    throw new Error(`name must be text of at most ${SPEC_NAME_MAX_LENGTH} characters.`);
  }
  if (Array.isArray(spec.models)) {
    for (const [index, model] of spec.models.entries()) {
      if (!isRecord(model)) continue;
      specMap(`models[${index}]`, model, SPEC_MODEL_FIELDS);
      optionalBoolean(model.fast ?? undefined, `models[${index}].fast`);
    }
  }
  const models = parseRouterModels(id, "models", spec.models);
  const agentModels = parseAgentModels(id, "agents", spec.agents);
  const roles = specMap("roles", spec.roles, ROUTER_ROLES);
  const roleSpecs = Object.fromEntries(
    ROUTER_ROLES.map((role) => [role, specMap(`roles.${role}`, roles[role], ["model", "prompt"])]),
  );
  const roleValues = (key: string) =>
    Object.fromEntries(ROUTER_ROLES.map((role) => [role, roleSpecs[role]![key] ?? null]));
  const routing = specMap("routing", spec.routing, ["session_pinning", "retries", "rules"]);
  if (routing.rules != null && (!Array.isArray(routing.rules) || routing.rules.length > 0)) {
    throw new Error("routing.rules runs only on hosted Dari; remove it to serve this router on a self-hosted gateway.");
  }
  const payment = specMap("payment", spec.payment, ["allow"]);
  const allow = payment.allow ?? PAYMENT_KINDS;
  if (!Array.isArray(allow) || !allow.every((kind) => PAYMENT_KINDS.includes(kind))) {
    throw new Error(`payment.allow must list ${PAYMENT_KINDS.join(", ")}.`);
  }
  if (allow.length === 0) throw new Error("payment.allow needs at least one way to pay.");
  if (spec.hosted != null && !isRecord(spec.hosted)) throw new Error("hosted must be a map.");
  return {
    name: spec.name.trim(),
    router: {
      models,
      agentModels,
      roleModels: parseRoleMap("roles", roleValues("model"), (field, model) =>
        roleModel(`${field}.model`, model, [models, ...Object.values(agentModels)].flat())),
      rolePrompts: parseRoleMap("roles", roleValues("prompt"), (field, prompt) => rolePrompt(`${field}.prompt`, prompt)),
      retries: optionalRetries(routing.retries ?? undefined, "routing.retries") ?? 1,
      resetMinHours: optionalResetMinHours(spec.reset_min_hours ?? undefined, "reset_min_hours"),
      sessionPinning: optionalBoolean(routing.session_pinning ?? undefined, "routing.session_pinning") ?? false,
      nativeCompaction: optionalBoolean(spec.native_compaction ?? undefined, "native_compaction") ?? false,
      zdr: false,
    },
  };
}

/** The spec of a router, such as one from the config file. */
export function routerSpecFor(name: string, router: RouterConfig): Record<string, unknown> {
  const roles = Object.fromEntries(ROUTER_ROLES.flatMap((role) => {
    const model = router.roleModels[role];
    const prompt = router.rolePrompts[role];
    if (model == null && prompt == null) return [];
    return [[role, { ...(model == null ? {} : { model }), ...(prompt == null ? {} : { prompt }) }]];
  }));
  const agents = Object.entries(router.agentModels);
  return {
    name,
    reset_min_hours: router.resetMinHours,
    models: router.models.map(specModel),
    ...(Object.keys(roles).length > 0 ? { roles } : {}),
    routing: { session_pinning: router.sessionPinning, retries: router.retries },
    // The gateway pays with plans and API keys; it has no credits.
    payment: { allow: ["subscription", "key"] },
    native_compaction: router.nativeCompaction,
    ...(agents.length > 0
      ? { agents: Object.fromEntries(agents.map(([agent, models]) => [agent, models!.map(specModel)])) }
      : {}),
  };
}

/** A spec as YAML text. */
export function routerSpecYaml(spec: unknown): string {
  // Bun writes "key: " before a nested value; strings never span lines.
  return `${Bun.YAML.stringify(spec, null, 2).replace(/: $/gm, ":")}\n`;
}

function specModel(model: RouterModelConfig): string | Record<string, unknown> {
  return model.thinking === undefined && model.provider === undefined && model.sources === undefined ? model.id : { ...model };
}

// A spec section as a map, refusing fields the spec does not have; absent is empty.
function specMap(field: string, raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (raw == null) return {};
  if (!isRecord(raw)) throw new Error(`${field} must be a map.`);
  const unknown = Object.keys(raw).filter((key) => !fields.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${field} has unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; use ${fields.join(", ")}.`);
  }
  return raw;
}
