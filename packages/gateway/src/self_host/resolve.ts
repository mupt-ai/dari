import { timingSafeEqual } from "node:crypto";

import {
  isReasoningEffort,
  nativeModelId,
  providerForModel,
  type ReasoningEffort,
  type RouterModelPrice,
  type RouterPrefixHit,
} from "@mupt-ai/dari-router/policy-engine";
import { HttpError } from "../http/errors.js";
import type { ResolveRouterRequest } from "../platform/platform.js";
import { DEFAULT_ROUTER_ALIAS, HOSTED_DARI_PROVIDER } from "../platform/routing_contract.js";
import { explicitModelSlug } from "../protocol/input/router_model.js";
import { CLIENT_HARNESS_HEADER } from "../ingress/client_harness.js";
import {
  codexModelConfig,
  modelSubscriptions,
  subscriptionClient,
  subscriptionModelProvider,
} from "../models/subscriptions.js";
import { CANONICAL_MODELS, otherModelProviders, providerModel } from "../models/canonical.js";
import { gatewayFor } from "../models/gateways.js";
import { candidatesFor, DEFAULT_RESET_MIN_HOURS, SELF_HOSTED_DEFAULT_SOURCES, type PlanOption, type Source } from "../models/sources.js";
import { linkNothingServed, plansExhausted, providersUnavailable } from "../link/errors.js";
import { buildModel, pi, registeredModelPrice } from "../providers/pi.js";
import type {
  LinkUnavailable,
  ModelFallback,
  ResolvedRouter,
  ResolvedRouterModelConfig,
} from "../types.js";
import {
  allRouterModels,
  modelProvider,
  routerModelsFor,
  type GatewayConfig,
  type RouterConfig,
  type RouterModelConfig,
} from "./config.js";
import type { ActiveLinkGrant } from "../link/grants.js";
import type { HostedConnection } from "./connected.js";
import type { SqliteLinkStore } from "../link/sqlite_store.js";
import { linkSubscription } from "../link/self_hosted.js";
import { linkTokenGrant } from "../link/service.js";
import type { RouterModelStore } from "./router_models.js";
import { servedRouter, type RouterSpecStore } from "./router_specs.js";
import { refreshedAccessToken } from "./subscriptions/access.js";
import {
  activeModelHolds,
  freshAccessToken,
  type OAuthFetch,
  type SubscriptionCredential,
  type SubscriptionProvider,
  type SubscriptionStore,
} from "./subscriptions/index.js";

// A self-hosted gateway is one tenant; these stand in for the hosted
// organization and the user a personal subscription belongs to.
export const SELF_HOSTED_ORGANIZATION_ID = "self-hosted";
export const SELF_HOSTED_USER_ID = "self-hosted";

export type SelfHostedResolverDeps = {
  config: GatewayConfig;
  // Model lists saved through the API, served in place of the config's.
  routerModels: RouterModelStore;
  // Router specs, each served in place of the config's router of its id.
  routerSpecs: RouterSpecStore;
  gatewayKeys: readonly string[];
  subscriptions: SubscriptionStore;
  links: SqliteLinkStore;
  prefixHits: (args: {
    routerId: string;
    prefixHashes: readonly string[];
    conversationId?: string;
  }) => RouterPrefixHit[];
  // The provider's API key from its standard environment variable.
  providerApiKey: (provider: string) => Promise<string | undefined>;
  // Dari Auto Routing chooses among models. Without it `dari/routing` serves
  // the first available model, so model lists leave it out.
  autoRouting: boolean;
  env: Record<string, string | undefined>;
  fetch: OAuthFetch;
  // Set on a gateway connected to hosted Dari (connected.ts).
  hosted?: HostedConnection;
};

// One way to serve a model: a connected plan, its provider's API key, or
// hosted Dari, with the user's Dari key and the endpoint that serves it.
type Candidate =
  | { provider: string; plan: SubscriptionCredential }
  | { provider: string; key: string }
  | { provider: string; key: string; config: ResolvedRouterModelConfig };

/**
 * Resolve a configured router for one request. Each model is served by the
 * connected personal subscriptions that serve it, when the router allows them,
 * in plan order (see models/subscriptions.ts), then by its provider's API key
 * (on a connected gateway, by hosted Dari): the first available serves and
 * the rest fail over within the request. Models nothing can serve are left
 * out. A coding agent with its own model list on the router is served that
 * list.
 *
 * A Dari Link token is served apart from any router, on its grant's plans and
 * API keys alone: `dari/routing` chooses among every catalog model they
 * serve, which a request may also name explicitly. It comes in on the default
 * router's path. A child token serves only its models.
 */
export async function resolveSelfHostedRouter(
  deps: SelfHostedResolverDeps,
  request: ResolveRouterRequest,
): Promise<ResolvedRouter> {
  const keyIndex = gatewayKeyIndex(deps.gatewayKeys, request.apiKey);
  const grant = keyIndex === null ? await linkTokenGrant(deps.links, { plansWithIds: async (ids) => deps.subscriptions.withIds(new Set(ids)).map(linkSubscription) }, request.apiKey) : null;
  if (keyIndex === null && grant === null) {
    throw new HttpError(401, "Missing or invalid gateway key or Dari Link access token.", "authentication_error");
  }
  if (grant !== null && request.routerId !== DEFAULT_ROUTER_ALIAS) {
    throw new HttpError(403, "Dari Link tokens serve only the default router.", "permission_denied");
  }
  const router = grant === null ? servedRouter(deps, request.routerId) : undefined;
  if (grant === null && router === undefined) {
    throw new HttpError(404, `Router ${request.routerId} is not configured on this gateway.`, "router_not_found");
  }

  const routed = router === undefined ? [] : routerModelsFor(router, request.clientHarness);
  const granted = grant === null
    ? []
    : deps.subscriptions.withIds(grant.credentialIds);
  // A grant's API keys, by the provider or gateway each is a key for.
  const grantKeys = grant === null ? [] : deps.links.keysWithIds(grant.credentialIds);
  const grantedKeys = new Map(grantKeys.map((key) => [key.provider, key.apiKey]));
  const listed = grant === null ? routed : grantModels(grant, routed, granted, grantedKeys);
  const now = new Date();
  const servable = grant === null ? undefined : new Set(grant.credentialIds);
  // The plan of each kind that serves this conversation, chosen once.
  const conversationPlans = new Map<SubscriptionProvider, SubscriptionCredential | null>();
  const conversationPlan = (kind: SubscriptionProvider) => {
    if (!conversationPlans.has(kind)) {
      conversationPlans.set(kind, deps.subscriptions.selectCredential(kind, request.conversationId, now, servable));
    }
    return conversationPlans.get(kind)!;
  };
  // The conversation's plan of a kind for a model, or with that model held at
  // its own limit there, another plan of the kind that serves it.
  const planFor = (kind: SubscriptionProvider, modelId: string) => {
    const active = conversationPlan(kind);
    if (active !== null && !activeModelHolds(active, now).some((hold) => hold.model === modelId)) return active;
    return deps.subscriptions.selectCredential(kind, undefined, now, servable, modelId);
  };
  const tokens = new Map<string, Promise<string>>();
  const planToken = (plan: SubscriptionCredential) => {
    // A provisional resolve's credentials never serve, so it neither marks
    // the plan used nor refreshes its token.
    if (request.provisional === true) return Promise.resolve(plan.accessToken);
    if (!tokens.has(plan.id)) {
      tokens.set(plan.id, conversationPlans.get(plan.provider)?.id === plan.id
        ? freshAccessToken(deps.subscriptions, plan, { fetch: deps.fetch })
        // A model-only failover must not move the provider-wide rotation anchor.
        : refreshedAccessToken(deps.subscriptions, plan, { fetch: deps.fetch }));
    }
    return tokens.get(plan.id)!;
  };
  const apiKeys = new Map<string, Promise<string | undefined>>();
  const apiKey = (provider: string) => {
    if (grant !== null) return Promise.resolve(grantedKeys.get(provider));
    if (!apiKeys.has(provider)) apiKeys.set(provider, configuredProviderApiKey(deps, provider));
    return apiKeys.get(provider)!;
  };

  const resolved: ResolvedRouter = {
    // A grant's requests and prefix state are its own, apart from any router.
    router_id: grant?.id ?? request.routerId,
    organization_id: SELF_HOSTED_ORGANIZATION_ID,
    api_key_id: grant === null ? `gateway_key_${keyIndex! + 1}` : grant.id,
    attributed_user_id: SELF_HOSTED_USER_ID,
    enabled_models: [],
    routing_listed: deps.autoRouting,
    provider_keys: {},
    provider_key_sources: {},
    provider_credentials: {},
    model_fallbacks: {},
    link_grant_id: grant?.id ?? null,
    zdr: router?.zdr ?? false,
    speculative_routing: false,
    session_pinning: router?.sessionPinning ?? false,
    native_compaction: router?.nativeCompaction ?? false,
    ...(router === undefined ? {} : { primary_retries: router.retries }),
    routing_strategy: "dari",
    custom_config: null,
    // A grant's request is served the model it named, never a role's.
    ...(router === undefined ? {} : { role_models: router.roleModels, role_prompts: router.rolePrompts }),
    evals: [],
    model_thinking_levels: thinkingLevels(listed),
    model_prices: {},
    model_configs: {},
    model_sources: {},
    reset_min_hours: router?.resetMinHours ?? DEFAULT_RESET_MIN_HOURS,
  };

  // Each model is served by the user's plans that serve it, in order, then by
  // its provider's API key; the first serves and the rest are its fallbacks.
  // A model nothing can serve is left out.
  const exhausted = new Set<SubscriptionProvider>();
  // The providers of models nothing serves.
  const unserved = new Set<string>();
  // A model held at its own limit on every plan that serves it.
  const modelsUnavailable: Record<string, LinkUnavailable> = {};
  const models: RouterModelConfig[] = [];
  for (const model of listed) {
    const base = modelProvider(model);
    const heldKinds: SubscriptionProvider[] = [];
    const modelHolds: Date[] = [];
    // A grant serves its plans, then its keys; a router model its own list.
    let sources: readonly Source[] = model.sources ?? SELF_HOSTED_DEFAULT_SOURCES;
    if (grant !== null) sources = SELF_HOSTED_DEFAULT_SOURCES;
    const plans: PlanOption<Candidate>[] = [];
    for (const kind of modelSubscriptions(model.id)) {
      const client = subscriptionClient(kind);
      plans.push({
        servesClient: client === undefined || client === request.clientHarness,
        candidate: async () => {
          const plan = planFor(kind, model.id);
          if (plan !== null) return { provider: subscriptionModelProvider(kind), plan };
          // Held at its limit: remember why, for the error when nothing serves.
          const connected = grant === null ? deps.subscriptions.list(kind) : deps.subscriptions.withIds(grant.credentialIds, kind);
          if (connected.length > 0) heldKinds.push(kind);
          for (const credential of connected) {
            for (const hold of activeModelHolds(credential, now)) {
              if (hold.model === model.id) modelHolds.push(hold.until);
            }
          }
          return null;
        },
      });
    }
    let keyCandidate = async (): Promise<Candidate | null> => {
      const key = await apiKey(base);
      if (key === undefined) return null;
      return { provider: base, key };
    };
    // A self-hosted gateway has no managed keys.
    let managedCandidate = async (): Promise<Candidate | null> => null;
    // On a gateway connected to hosted Dari, Dari serves what no plan on this
    // computer does: its own plans after this computer's, the router's key,
    // and managed credits.
    const hosted = deps.hosted;
    if (hosted !== undefined) {
      const dari = async () => hostedCandidate(hosted, request, model.id);
      plans.push({ servesClient: true, candidate: dari });
      keyCandidate = dari;
      managedCandidate = dari;
    }
    const candidates = await candidatesFor(sources, plans, { key: keyCandidate, managed: managedCandidate });
    // Dari walks the model's sources itself from there, so its one candidate
    // ends the list.
    const dariAt = candidates.findIndex((candidate) => candidate.provider === HOSTED_DARI_PROVIDER);
    if (dariAt !== -1) candidates.splice(dariAt + 1);

    if (candidates.length === 0) {
      for (const kind of heldKinds) exhausted.add(kind);
      unserved.add(base);
      // A granted plan may serve another maker's model: name the plan's provider too.
      if (grant !== null) for (const kind of heldKinds) unserved.add(subscriptionModelProvider(kind));
      if (modelHolds.length > 0) {
        modelsUnavailable[model.id] = plansExhausted(heldKinds, new Date(Math.min(...modelHolds.map((until) => until.getTime()))));
      }
      continue;
    }
    models.push(model);
    resolved.model_sources![model.id] = [...sources];
    const [first, ...rest] = candidates;
    const firstConfig = candidateConfig(deps, model.id, first!);
    const price = priceFor(model.id, first!.provider);
    if (price !== null) resolved.model_prices![model.id] = price;
    if (firstConfig !== undefined) resolved.model_configs![model.id] = firstConfig;
    if ("plan" in first!) {
      resolved.provider_credentials![model.id] = {
        apiKey: await planToken(first.plan),
        subscription: first.plan.provider,
        credentialId: first.plan.id,
      };
    } else {
      resolved.provider_keys[first!.provider] = first!.key;
      resolved.provider_key_sources![first!.provider] = "user";
    }
    const fallbacks = rest.flatMap((candidate): ModelFallback[] => {
      const config = candidateConfig(deps, model.id, candidate) ?? registryConfig(model.id, candidate.provider);
      if (config === undefined) return [];
      if ("plan" in candidate) return [{ config, subscription: candidate.plan.provider }];
      resolved.provider_keys[candidate.provider] = candidate.key;
      resolved.provider_key_sources![candidate.provider] = "user";
      return [{ config }];
    });
    if (fallbacks.length > 0) resolved.model_fallbacks![model.id] = fallbacks;
  }

  // A grant's keys are all the user's: a gateway key serves any model of its
  // gateway a request names, listed or not.
  for (const [provider, key] of grantedKeys) {
    resolved.provider_keys[provider] = key;
    resolved.provider_key_sources![provider] = "user";
  }
  // A provider the request wanted that no granted plan served.
  const linkUnavailable = grant === null
    ? {}
    : {
        ...providersUnavailable(
          granted.map((credential) => ({ kind: credential.provider, unavailableUntil: credential.unavailableUntil })),
          unserved,
          request.clientHarness,
          now,
        ),
        ...modelsUnavailable,
      };

  const gatewayKeyed = [...grantedKeys.keys()].some((provider) => gatewayFor(provider) !== undefined);
  if (models.length === 0 && !gatewayKeyed) {
    if (grant !== null) throw linkNothingServed(linkUnavailable, grant.pins);
    throw unavailableRouterError(request.routerId, exhausted, [...unserved]);
  }
  resolved.enabled_models = models.map((model) => model.id);
  if (grant !== null) {
    Object.assign(resolved, {
      link_models: models.map((model) => model.id),
      link_key_credential_ids: Object.fromEntries(grantKeys.map((key) => [key.provider, key.id])),
      link_key_gateways: Object.fromEntries(
        [...grantedKeys.keys()].filter((provider) => gatewayFor(provider) !== undefined).map((gateway) => {
          const endpoint = deps.config.providers[gateway];
          return [gateway, endpoint === undefined ? null : { api: endpoint.api, base_url: endpoint.baseUrl }];
        }),
      ),
      link_unavailable: linkUnavailable,
      link_pins: grant.pins === undefined
        ? null
        : grant.pins.map((pin) => ({ model: pin.model, thinking: isReasoningEffort(pin.thinking) ? pin.thinking : null })),
      link_tags: grant.tags ?? null,
    });
  }
  resolved.prefix_hits = deps.prefixHits({
    routerId: grant?.id ?? request.routerId,
    prefixHashes: request.prefixHashes ?? [],
    ...(request.conversationId ? { conversationId: request.conversationId } : {}),
  });
  return resolved;
}

// The grant a live link token belongs to, or null for a token that is not
// one. A dead token is refused with the reason.

/**
 * The models a grant's request may be served: a child token's one model, or
 * the router's own models followed by every other catalog model of the
 * providers its API keys serve and every one a granted plan has an offering
 * of, whoever makes it (every OpenCode Go model is another maker's).
 */
function grantModels(
  grant: ActiveLinkGrant,
  routed: readonly RouterModelConfig[],
  granted: readonly SubscriptionCredential[],
  grantedKeys: ReadonlyMap<string, string>,
): RouterModelConfig[] {
  const providers = new Set([
    ...granted.map((credential) => subscriptionModelProvider(credential.provider)),
    ...grantedKeys.keys(),
  ]);
  const kinds = new Set(granted.map((credential) => credential.provider));
  const routedIds = new Set(routed.map((model) => model.id));
  const models = [
    ...routed,
    ...CANONICAL_MODELS.flatMap((model): RouterModelConfig[] => {
      if (routedIds.has(model.id)) return [];
      if (providers.has(providerForModel(model.id))) return registeredModelPrice(model.id) !== null ? [{ id: model.id }] : [];
      if (!modelSubscriptions(model.id).some((kind) => kinds.has(kind))) return [];
      // The plans serve it first, then a granted key of a provider that runs it.
      const keyed = otherModelProviders(model.id).find((provider) => grantedKeys.has(provider) && gatewayFor(provider) === undefined);
      return [keyed === undefined ? { id: model.id } : { id: model.id, provider: keyed }];
    }),
  ];
  if (grant.pins === undefined) return models;
  // A pinned level replaces the router's own choice of levels for the model.
  const pinned = new Set(grant.pins.map((pin) => pin.model));
  return models.filter((model) => pinned.has(model.id)).map((model) => ({ id: model.id }));
}

// Configured endpoints read their own key variable, or send a placeholder
// when they take none; known providers use their standard variable.
export async function configuredProviderApiKey(
  deps: Pick<SelfHostedResolverDeps, "config" | "providerApiKey" | "env">,
  provider: string,
): Promise<string | undefined> {
  const endpoint = deps.config.providers[provider];
  if (endpoint === undefined) return (await deps.providerApiKey(provider))?.trim() || undefined;
  if (endpoint.apiKeyEnv === undefined) return "no-key";
  return deps.env[endpoint.apiKeyEnv]?.trim() || undefined;
}

export function gatewayKeyIndex(keys: readonly string[], presented: string): number | null {
  const candidate = Buffer.from(presented);
  for (const [index, key] of keys.entries()) {
    const expected = Buffer.from(key);
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
      return index;
    }
  }
  return null;
}

// How a candidate runs a model: hosted Dari's endpoint, a ChatGPT plan
// through the Codex backend, a provider that serves another maker's model as
// its own model, a configured endpoint, or (undefined) the model's own
// provider as the catalog has it.
function candidateConfig(
  deps: Pick<SelfHostedResolverDeps, "config">,
  modelId: string,
  candidate: Candidate,
): ResolvedRouterModelConfig | undefined {
  if ("config" in candidate) return candidate.config;
  const { provider } = candidate;
  const price = priceFor(modelId, provider);
  if ("plan" in candidate && candidate.plan.provider === "openai_codex") {
    return codexModelConfig(modelId, price, deps.config.providers["openai-codex"]?.baseUrl);
  }
  const served = providerModel(modelId, provider);
  const endpoint = deps.config.providers[provider];
  const limits = {
    ...(endpoint?.contextWindow !== undefined ? { context_window: endpoint.contextWindow } : {}),
    ...(endpoint?.maxOutputTokens !== undefined ? { max_output_tokens: endpoint.maxOutputTokens } : {}),
  };
  if (served !== undefined) {
    return {
      provider,
      ...limits,
      native_model_id: served.native_model_id,
      api: endpoint?.api ?? served.api,
      base_url: endpoint?.baseUrl ?? served.base_url,
      cost: price ?? { input: 0, output: 0 },
    };
  }
  if (endpoint === undefined) return undefined;
  return {
    provider,
    ...limits,
    native_model_id: nativeModelId(modelId),
    api: endpoint.api,
    base_url: endpoint.baseUrl,
    cost: price ?? { input: 0, output: 0 },
  };
}

/**
 * Hosted Dari as the provider of a model: the request's router on hosted Dari,
 * called for `dari/model/<id>` with the user's Dari key, in Anthropic's API
 * for Anthropic's models and OpenAI's Responses API for the rest, with the
 * client's own identifying headers and the coding agent it named, so hosted
 * sees the same client. Hosted Dari bills and logs what it serves.
 */
function hostedCandidate(hosted: HostedConnection, request: ResolveRouterRequest, modelId: string): Candidate {
  let routerUrl = hosted.url;
  if (request.routerId !== DEFAULT_ROUTER_ALIAS) routerUrl = `${hosted.url}/${encodeURIComponent(request.routerId)}`;
  let api = "openai-responses";
  let baseUrl = `${routerUrl}/v1`;
  // Anthropic's client adds /v1 itself.
  if (providerForModel(modelId) === "anthropic") {
    api = "anthropic-messages";
    baseUrl = routerUrl;
  }
  const headers: Record<string, string> = { ...request.clientHeaders };
  if (request.clientHarness !== undefined) headers[CLIENT_HARNESS_HEADER] = request.clientHarness;
  return {
    provider: HOSTED_DARI_PROVIDER,
    key: hosted.apiKey,
    config: {
      provider: HOSTED_DARI_PROVIDER,
      native_model_id: explicitModelSlug(modelId),
      api,
      base_url: baseUrl,
      headers,
      cost: registeredModelPrice(modelId) ?? { input: 0, output: 0 },
    },
  };
}

// A fallback names its endpoint even on the model's own provider, as the
// catalog has it; undefined when the catalog has none.
function registryConfig(modelId: string, provider: string): ResolvedRouterModelConfig | undefined {
  try {
    const model = buildModel(pi, modelId, null);
    if (typeof model.api !== "string" || typeof model.baseUrl !== "string") return undefined;
    return {
      provider,
      native_model_id: nativeModelId(modelId),
      api: model.api,
      base_url: model.baseUrl,
      cost: priceFor(modelId, provider) ?? { input: 0, output: 0 },
    };
  } catch {
    return undefined;
  }
}

// A model's price as a provider serves it, for estimates; a plan bills no
// tokens.
function priceFor(modelId: string, provider: string): RouterModelPrice | null {
  const served = providerModel(modelId, provider);
  return served === undefined
    ? registeredModelPrice(modelId)
    : registeredModelPrice(`${provider}/${served.native_model_id}`);
}

function thinkingLevels(models: readonly RouterModelConfig[]): Record<string, ReasoningEffort[]> {
  return Object.fromEntries(
    models.flatMap((model) => model.thinking ? [[model.id, model.thinking]] : []),
  );
}

const SUBSCRIPTION_PLAN_NAMES: Record<SubscriptionProvider, string> = {
  anthropic_claude_code: "Claude Code",
  openai_codex: "ChatGPT",
  meta_muse: "Muse Code",
  opencode_go: "OpenCode Go",
  xai_grok: "Grok",
  vercel_token_pass: "Vercel Token Pass",
};

/**
 * Providers a router lists models of that no credential can serve: no API key
 * and no connected subscription the router allows that serves them. Startup
 * uses this, so it counts a held subscription as connected (the request-time
 * 424 reports holds) and ignores which client a plan is limited to, since
 * startup does not know the client.
 */
export async function providersWithoutCredentials(
  deps: Pick<SelfHostedResolverDeps, "subscriptions" | "providerApiKey" | "config" | "env">,
  router: RouterConfig,
): Promise<string[]> {
  const missing = new Set<string>();
  for (const model of allRouterModels(router)) {
    const provider = modelProvider(model);
    if (missing.has(provider)) continue;
    const sources = model.sources ?? SELF_HOSTED_DEFAULT_SOURCES;
    const plans = sources.includes("plan") ? modelSubscriptions(model.id) : [];
    if (plans.some((plan) => deps.subscriptions.list(plan).length > 0)) continue;
    if (await configuredProviderApiKey(deps, provider) === undefined) missing.add(provider);
  }
  return [...missing];
}

function unavailableRouterError(
  routerId: string,
  exhausted: ReadonlySet<SubscriptionProvider>,
  missing: readonly string[],
): HttpError {
  const missingNote = missing.length > 0 ? ` Missing providers: ${missing.join(", ")}.` : "";
  if (exhausted.size > 0) {
    const plans = [...exhausted]
      .map((provider) => SUBSCRIPTION_PLAN_NAMES[provider])
      .join(" and ");
    return new HttpError(
      424,
      `Every connected ${plans} subscription is at its usage limit for the models router ${routerId} lists, and no API key can serve them instead.${missingNote}`,
      "personal_subscription_unavailable",
    );
  }
  return new HttpError(
    424,
    `No credentials can serve router ${routerId}.${missingNote} Set each provider's API key or connect a subscription that can serve it.`,
    "provider_credentials_missing",
  );
}
