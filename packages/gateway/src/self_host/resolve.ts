import { timingSafeEqual } from "node:crypto";

import {
  isReasoningEffort,
  nativeModelId,
  providerForModel,
  type ReasoningEffort,
  type RouterPrefixHit,
} from "@mupt-ai/dari-router/policy-engine";
import { HttpError } from "../http/errors.js";
import type { ResolveRouterRequest } from "../platform/platform.js";
import { DEFAULT_ROUTER_ALIAS } from "../platform/routing_contract.js";
import { codexModelConfig, subscriptionClient, subscriptionModelProvider } from "../models/subscriptions.js";
import { CANONICAL_MODELS } from "../models/canonical.js";
import { gatewayFor } from "../models/gateways.js";
import {
  linkGrantUnavailableError,
  modelNotServed,
  plansExhausted,
  plansForAnotherClient,
} from "../link/errors.js";
import { registeredModelPrice } from "../providers/pi.js";
import type { LinkUnavailable, ProviderCredential as SuppliedProviderCredential, ProviderKeySource, ResolvedRouter } from "../types.js";
import {
  allRouterModels,
  routerModelsFor,
  type GatewayConfig,
  type RouterConfig,
  type RouterModelConfig,
} from "./config.js";
import type { ActiveLinkGrant } from "../link/grants.js";
import type { SqliteLinkStore } from "../link/sqlite_store.js";
import { linkTokenGrant } from "../link/service.js";
import type { RouterModelStore } from "./router_models.js";
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
};

type ProviderCredential = {
  key: string;
  source: ProviderKeySource;
  subscription?: SubscriptionCredential;
};

/**
 * Resolve a configured router for one request. Each provider is served by a
 * connected personal subscription when the router allows it and one is
 * available, otherwise by the provider's API key; models whose provider has
 * neither are left out. A coding agent with its own model list on the router
 * is served that list.
 *
 * A Dari Link token resolves only the default router, served on its grant's
 * subscriptions alone and never an API key. Its `enabled_models` are the
 * router's models a granted plan serves, and `link_models` adds every other
 * catalog model of those plans' providers, which a request may name
 * explicitly. A child token serves only its one model.
 */
export async function resolveSelfHostedRouter(
  deps: SelfHostedResolverDeps,
  request: ResolveRouterRequest,
): Promise<ResolvedRouter> {
  const keyIndex = gatewayKeyIndex(deps.gatewayKeys, request.apiKey);
  const grant = keyIndex === null ? await linkTokenGrant(deps.links, request.apiKey) : null;
  if (keyIndex === null && grant === null) {
    throw new HttpError(401, "Missing or invalid gateway key.", "authentication_error");
  }
  if (grant !== null && request.routerId !== DEFAULT_ROUTER_ALIAS) {
    throw new HttpError(403, "Dari Link tokens serve only the default router.", "permission_denied");
  }
  const configured = deps.config.routers[request.routerId];
  if (configured === undefined) {
    throw new HttpError(404, `Router ${request.routerId} is not configured on this gateway.`, "router_not_found");
  }
  const router = deps.routerModels.served(request.routerId, configured);

  const routed = routerModelsFor(router, request.clientHarness);
  const granted = grant === null
    ? []
    : deps.subscriptions.withIds(grant.credentialIds);
  // A grant's API keys, by the provider or gateway each is a key for.
  const grantedKeys = new Map(
    (grant === null ? [] : deps.links.keysWithIds(grant.credentialIds)).map((key) => [key.provider, key.apiKey]),
  );
  const listed = grant === null ? routed : grantModels(grant, routed, granted, grantedKeys);
  const now = new Date();
  const servable = grant === null ? undefined : new Set(grant.credentialIds);
  const credentials = new Map<string, ProviderCredential | null>();
  const exhausted = new Set<SubscriptionProvider>();
  for (const provider of new Set(listed.map((model) => providerForModel(model.id)))) {
    // A grant uses the subscriptions its user chose, whatever the router allows.
    const subscription = router.subscriptions || grant !== null
      ? subscriptionProviderFor(provider, request.clientHarness)
      : null;
    const active = subscription === null
      ? null
      : deps.subscriptions.selectCredential(subscription, request.conversationId, now, servable);
    if (active !== null) {
      credentials.set(provider, {
        // A provisional resolve's credentials never serve, so it neither marks
        // the plan used nor refreshes its token.
        key: request.provisional === true
          ? active.accessToken
          : await freshAccessToken(deps.subscriptions, active, { fetch: deps.fetch }),
        source: "subscription",
        subscription: active,
      });
      continue;
    }
    if (grant !== null) {
      // A plan first; else the key the user added for the provider.
      const key = grantedKeys.get(provider);
      credentials.set(provider, key === undefined ? null : { key, source: "user" });
      continue;
    }
    if (subscription !== null && deps.subscriptions.list(subscription).length > 0) exhausted.add(subscription);
    const apiKey = await configuredProviderApiKey(deps, provider);
    credentials.set(provider, apiKey ? { key: apiKey, source: "user" } : null);
  }

  // A model-specific hold tries the pool's other plans before removing the
  // model. Its provider's active plan and conversation pin stay unchanged.
  const modelCredentials: Record<string, SuppliedProviderCredential> = {};
  const linkUnavailable = grant === null
    ? {}
    : grantUnavailable(granted, credentials, request.clientHarness, now);
  const models = [];
  for (const model of listed) {
    const credential = credentials.get(providerForModel(model.id));
    if (credential == null) continue;
    const plan = credential.subscription;
    const hold = plan === undefined ? undefined : activeModelHolds(plan, now).find((held) => held.model === model.id);
    if (plan === undefined || hold === undefined) {
      models.push(model);
      continue;
    }
    const alternate = deps.subscriptions.selectCredential(plan.provider, undefined, now, servable, model.id);
    if (alternate !== null) {
      modelCredentials[model.id] = {
        apiKey: request.provisional === true
          ? alternate.accessToken
          // A model-only failover must not move the provider-wide rotation anchor.
          : await refreshedAccessToken(deps.subscriptions, alternate, { fetch: deps.fetch }),
        subscription: alternate.provider,
        credentialId: alternate.id,
      };
      models.push(model);
      continue;
    }
    exhausted.add(plan.provider);
    linkUnavailable[model.id] = plansExhausted([plan.provider], hold.until);
  }

  // A grant with a gateway key serves the gateway's models by name, listed or not.
  const gatewayKeyed = [...grantedKeys.keys()].some((provider) => gatewayFor(provider) !== undefined);
  if (models.length === 0 && !gatewayKeyed) {
    if (grant !== null) {
      throw grant.pins?.length === 1
        ? modelNotServed({ link_unavailable: linkUnavailable }, grant.pins[0]!.model)
        : linkGrantUnavailableError(linkUnavailable);
    }
    const missing = [...credentials].filter(([, credential]) => credential == null).map(([provider]) => provider);
    throw unavailableRouterError(request.routerId, exhausted, missing);
  }
  // `dari/routing` chooses among the router's own models; a grant may also
  // name any other catalog model its plans serve.
  const routedIds = new Set(routed.map((model) => model.id));
  const enabled = grant === null || grant.pins !== undefined ? models : models.filter((model) => routedIds.has(model.id));

  const resolved: ResolvedRouter = {
    router_id: request.routerId,
    organization_id: SELF_HOSTED_ORGANIZATION_ID,
    api_key_id: grant === null ? `gateway_key_${keyIndex! + 1}` : grant.id,
    attributed_user_id: SELF_HOSTED_USER_ID,
    enabled_models: enabled.map((model) => model.id),
    routing_listed: deps.autoRouting,
    provider_keys: {},
    provider_key_sources: {},
    subscription_credential_ids: {},
    provider_credentials: modelCredentials,
    link_grant_id: grant?.id ?? null,
    ...(grant === null
      ? {}
      : {
          link_models: models.map((model) => model.id),
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
        }),
    zdr: router.zdr,
    speculative_routing: false,
    session_pinning: router.sessionPinning,
    native_compaction: router.nativeCompaction,
    primary_retries: router.retries,
    routing_strategy: "dari",
    custom_config: null,
    // A grant's request is served the model it named, never a role's.
    ...(grant === null ? { role_models: router.roleModels, role_prompts: router.rolePrompts } : {}),
    evals: [],
    model_thinking_levels: thinkingLevels(listed),
    model_prices: {},
    model_configs: {},
    prefix_hits: deps.prefixHits({
      routerId: request.routerId,
      prefixHashes: request.prefixHashes ?? [],
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
    }),
  };
  for (const [provider, credential] of credentials) {
    if (credential == null) continue;
    for (const servingProvider of servingProviders(provider, credential)) {
      resolved.provider_keys[servingProvider] = credential.key;
      resolved.provider_key_sources![servingProvider] = credential.source;
      if (credential.subscription) {
        resolved.subscription_credential_ids![servingProvider] = credential.subscription.id;
      }
    }
  }
  // A gateway key serves any model of its gateway a request names, listed or not.
  for (const [provider, key] of grantedKeys) {
    if (resolved.provider_keys[provider] !== undefined) continue;
    resolved.provider_keys[provider] = key;
    resolved.provider_key_sources![provider] = "user";
  }
  for (const model of models) {
    const price = registeredModelPrice(model.id);
    if (price !== null) resolved.model_prices![model.id] = price;
    const provider = providerForModel(model.id);
    const endpoint = deps.config.providers[provider];
    if (credentials.get(provider)?.subscription?.provider === "openai_codex") {
      resolved.model_configs![model.id] = codexModelConfig(model.id, price, deps.config.providers["openai-codex"]?.baseUrl);
    } else if (endpoint !== undefined) {
      resolved.model_configs![model.id] = {
        provider,
        native_model_id: nativeModelId(model.id),
        api: endpoint.api,
        base_url: endpoint.baseUrl,
        cost: price ?? { input: 0, output: 0 },
      };
    }
  }
  return resolved;
}

// The grant a live link token belongs to, or null for a token that is not
// one. A dead token is refused with the reason.

/**
 * The models a grant's request may be served: a child token's one model, or
 * the router's own models followed by every other catalog model of the
 * providers its plans and API keys serve.
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
  const routedIds = new Set(routed.map((model) => model.id));
  const models = [
    ...routed,
    ...CANONICAL_MODELS
      .filter((model) => !routedIds.has(model.id) && providers.has(providerForModel(model.id)) && registeredModelPrice(model.id) !== null)
      .map((model): RouterModelConfig => ({ id: model.id })),
  ];
  if (grant.pins === undefined) return models;
  // A pinned level replaces the router's own choice of levels for the model.
  const pinned = new Set(grant.pins.map((pin) => pin.model));
  return models.filter((model) => pinned.has(model.id)).map((model) => ({ id: model.id }));
}

/**
 * Why each provider with a granted plan serves nothing now: its plans serve
 * only another client, or are all at their usage limits.
 */
function grantUnavailable(
  granted: readonly SubscriptionCredential[],
  credentials: ReadonlyMap<string, ProviderCredential | null>,
  clientHarness: ResolveRouterRequest["clientHarness"],
  now: Date,
): Record<string, LinkUnavailable> {
  const unavailable: Record<string, LinkUnavailable> = {};
  for (const provider of new Set(granted.map((credential) => subscriptionModelProvider(credential.provider)))) {
    // Only a provider the request wanted and no plan served.
    if (credentials.get(provider) !== null) continue;
    const plans = granted.filter((credential) => subscriptionModelProvider(credential.provider) === provider);
    const usable = plans.filter((credential) => {
      const client = subscriptionClient(credential.provider);
      return client === undefined || client === clientHarness;
    });
    if (usable.length === 0) {
      unavailable[provider] = plansForAnotherClient(plans.map((credential) => credential.provider));
      continue;
    }
    const held = usable.flatMap((credential) =>
      credential.unavailableUntil !== null && credential.unavailableUntil > now ? [credential.unavailableUntil] : []
    );
    unavailable[provider] = plansExhausted(
      usable.map((credential) => credential.provider),
      held.length === usable.length ? new Date(Math.min(...held.map((date) => date.getTime()))) : null,
    );
  }
  return unavailable;
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

// Claude Code plans serve only Claude Code itself and Muse Code plans only
// Muse Code; ChatGPT plans serve any client through the Codex backend.
function subscriptionProviderFor(
  provider: string,
  clientHarness: ResolveRouterRequest["clientHarness"],
): SubscriptionProvider | null {
  if (provider === "anthropic") {
    return clientHarness === "claude_code" ? "anthropic_claude_code" : null;
  }
  if (provider === "meta") return clientHarness === "muse_code" ? "meta_muse" : null;
  if (provider === "openai") return "openai_codex";
  if (provider === "opencode-go") return "opencode_go";
  return null;
}

// A ChatGPT plan serves OpenAI models as the `openai-codex` provider, and the
// runtime looks keys up by serving provider.
function servingProviders(provider: string, credential: ProviderCredential): string[] {
  return credential.subscription?.provider === "openai_codex"
    ? [provider, "openai-codex"]
    : [provider];
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
};

/**
 * Providers a router lists that no credential can serve: no API key and no
 * connected subscription the router allows. Startup uses this, so it counts a
 * held subscription as connected (the request-time 424 reports holds) and
 * checks both harnesses, since startup does not know the client.
 */
export async function providersWithoutCredentials(
  deps: Pick<SelfHostedResolverDeps, "subscriptions" | "providerApiKey" | "config" | "env">,
  router: RouterConfig,
): Promise<string[]> {
  const missing: string[] = [];
  for (const provider of new Set(allRouterModels(router).map((model) => providerForModel(model.id)))) {
    const plans = router.subscriptions
      ? [subscriptionProviderFor(provider, "claude_code"), subscriptionProviderFor(provider, "muse_code")]
      : [];
    const connected = plans.some((plan) => plan !== null && deps.subscriptions.list(plan).length > 0);
    if (connected) continue;
    const apiKey = await configuredProviderApiKey(deps, provider);
    if (apiKey === undefined) missing.push(provider);
  }
  return missing;
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
