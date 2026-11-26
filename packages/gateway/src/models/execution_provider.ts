import { providerForModel } from "@mupt-ai/dari-router/policy-engine";
import type {
  ProviderCredential,
  ProviderKeySource,
  ResolvedRouter,
  ResolvedRouterModelConfig,
} from "../types.js";

/** Actual serving provider for a canonical model on a resolved managed router. */
export function executionProviderForModel(
  credentials: ResolvedRouter,
  model: string,
): string {
  const configured = credentials.model_configs?.[model]?.provider?.trim();
  return configured || providerForModel(model);
}

/**
 * Who pays for the key that serves a model: a supplied plan, Dari's managed
 * key (billed to credits), or otherwise the router's own saved key.
 */
export function keySourceForModel(
  credentials: ResolvedRouter,
  model: string,
): ProviderKeySource {
  const supplied = credentials.provider_credentials?.[model];
  if (supplied?.subscription) return "subscription";
  if (supplied?.managed) return "managed";
  return "user";
}

/**
 * The router as one of a model's fallbacks serves it: the fallback's config,
 * and its plan's credential or, without one, the router's API credential.
 */
export function credentialsServedBy(
  credentials: ResolvedRouter,
  model: string,
  config: ResolvedRouterModelConfig,
  plan: ProviderCredential | undefined,
): ResolvedRouter {
  const { [model]: _replaced, ...others } = credentials.provider_credentials ?? {};
  return {
    ...credentials,
    model_configs: { ...credentials.model_configs, [model]: config },
    provider_credentials: plan === undefined ? others : { ...others, [model]: plan },
  };
}
