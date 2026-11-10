import { providerForModel } from "@mupt-ai/dari-router/policy-engine";
import type { ProviderKeySource, ResolvedRouter } from "../types.js";

/** Actual serving provider for a canonical model on a resolved managed router. */
export function executionProviderForModel(
  credentials: ResolvedRouter,
  model: string,
): string {
  const configured = credentials.model_configs?.[model]?.provider?.trim();
  return configured || providerForModel(model);
}

/**
 * The key that serves a model on a resolved router: a platform-supplied
 * credential first, then the resolved provider key. Missing declarations are
 * user-owned so unknown platform data cannot trigger managed-key billing.
 */
export function keySourceForModel(
  credentials: ResolvedRouter,
  model: string,
): ProviderKeySource {
  const supplied = credentials.provider_credentials?.[model];
  if (supplied) return supplied.subscription ? "subscription" : "user";
  return credentials.provider_key_sources?.[executionProviderForModel(credentials, model)] ?? "user";
}
