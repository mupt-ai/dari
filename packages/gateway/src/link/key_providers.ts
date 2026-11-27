import { getBuiltinProviders } from "@mupt-ai/pi-ai/providers/all";
import { providerForModel } from "@mupt-ai/dari-router/policy-engine";

import { CANONICAL_MODELS } from "../models/canonical.js";
import { LINK_KEY_GATEWAYS, gatewayFor } from "../models/gateways.js";
import type { LinkKeyProvider } from "../platform/platform.js";

/**
 * Whose API key a user can add on the approval page: each provider with
 * catalog models the gateway can call with a key, named for the models'
 * maker, then the gateways.
 */
export const LINK_KEY_PROVIDERS: readonly LinkKeyProvider[] = [
  ...[...new Map(CANONICAL_MODELS.map((model) => [providerForModel(model.id), model.maker]))]
    .filter(([provider]) => (getBuiltinProviders() as readonly string[]).includes(provider))
    .map(([provider, name]) => ({ id: provider, name })),
  ...LINK_KEY_GATEWAYS.map((gateway) => ({ id: gateway, name: gatewayFor(gateway)!.label })),
];

/** What a provider is called where a user's key for it is shown: "OpenRouter". */
export function linkKeyProviderName(provider: string): string {
  return LINK_KEY_PROVIDERS.find((candidate) => candidate.id === provider)?.name ?? provider;
}
