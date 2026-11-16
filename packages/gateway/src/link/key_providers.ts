import { getBuiltinProviders } from "@mupt-ai/pi-ai/providers/all";
import { providerForModel } from "@mupt-ai/dari-router/policy-engine";

import { CANONICAL_MODELS } from "../models/canonical.js";
import { LINK_KEY_GATEWAYS, gatewayFor } from "../models/gateways.js";
import type { LinkKeyProvider } from "../platform/platform.js";

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  meta: "Meta",
  moonshotai: "Moonshot AI",
  xai: "xAI",
};

/**
 * Whose API key a user can add on the approval page: each provider with
 * catalog models the gateway can call with a key, then the gateways.
 */
export const LINK_KEY_PROVIDERS: readonly LinkKeyProvider[] = [
  ...[...new Set(CANONICAL_MODELS.map((model) => providerForModel(model.id)))]
    .filter((provider) => (getBuiltinProviders() as readonly string[]).includes(provider))
    .map((provider) => ({ id: provider, name: PROVIDER_NAMES[provider] ?? provider })),
  ...LINK_KEY_GATEWAYS.map((gateway) => ({ id: gateway, name: gatewayFor(gateway)!.label })),
];
