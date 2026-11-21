import { nativeModelId, providerForModel, type RouterModelPrice } from "@mupt-ai/dari-router/policy-engine";

import { providerModel } from "./canonical.js";
import type { ClientHarness, ResolvedRouterModelConfig, SubscriptionKind } from "../types.js";

const CODEX_BACKEND_URL = "https://chatgpt.com/backend-api";

// The execution providers whose models each kind of plan serves; a ChatGPT
// plan's OpenAI models execute as `openai-codex` once resolve points them at
// the Codex backend.
//
// The order is the order a model's plans serve it in, maker plans first, then
// the router's API credential. It matches the control plane's
// SUBSCRIPTION_OAUTH_PROVIDERS; keep the two in sync.
const SUBSCRIPTION_MODEL_PROVIDERS: Record<SubscriptionKind, readonly string[]> = {
  anthropic_claude_code: ["anthropic"],
  openai_codex: ["openai", "openai-codex"],
  xai_grok: ["xai"],
  meta_muse: ["meta"],
  opencode_go: ["opencode-go"],
  github_copilot: ["github-copilot"],
  vercel_token_pass: ["vercel-token-pass"],
};

// The client each plan is limited to, as its provider limits it: a Claude Code
// plan serves only Claude Code, and a Muse Code plan only Muse Code.
const SUBSCRIPTION_CLIENTS: Partial<Record<SubscriptionKind, ClientHarness>> = {
  anthropic_claude_code: "claude_code",
  meta_muse: "muse_code",
};

/** The model provider whose models a plan serves, such as `openai`. */
export function subscriptionModelProvider(kind: SubscriptionKind): string {
  return SUBSCRIPTION_MODEL_PROVIDERS[kind][0]!;
}

/**
 * The plans that can serve a model, in the order they serve it: each whose
 * provider is the model's maker or serves it as its own model.
 */
export function modelSubscriptions(modelId: string): SubscriptionKind[] {
  const maker = providerForModel(modelId);
  return (Object.keys(SUBSCRIPTION_MODEL_PROVIDERS) as SubscriptionKind[]).filter((kind) => {
    const provider = subscriptionModelProvider(kind);
    return provider === maker || providerModel(modelId, provider) !== undefined;
  });
}

/**
 * The only client a plan may serve, or undefined when it serves any client:
 * ChatGPT plans serve any client through the Codex backend.
 */
export function subscriptionClient(kind: SubscriptionKind): ClientHarness | undefined {
  return SUBSCRIPTION_CLIENTS[kind];
}

/**
 * Whether a plan may serve a model executed by `provider` for this client:
 * each plan serves only its own provider's models, and only to the client its
 * provider allows.
 */
export function subscriptionServes(
  kind: SubscriptionKind,
  provider: string,
  clientHarness: ClientHarness | undefined,
): boolean {
  if (!SUBSCRIPTION_MODEL_PROVIDERS[kind].includes(provider)) return false;
  const client = SUBSCRIPTION_CLIENTS[kind];
  return client === undefined || clientHarness === client;
}

// A ChatGPT plan serves OpenAI models as the `openai-codex` provider through
// the Codex backend.
export function codexModelConfig(
  modelId: string,
  price: RouterModelPrice | null,
  baseUrl = CODEX_BACKEND_URL,
): ResolvedRouterModelConfig {
  return {
    provider: "openai-codex",
    native_model_id: nativeModelId(modelId),
    api: "openai-codex-responses",
    base_url: baseUrl,
    // A plan bills no tokens; the catalog price only feeds cost estimates.
    cost: price ?? { input: 0, output: 0 },
    fast_mode: false,
  };
}
