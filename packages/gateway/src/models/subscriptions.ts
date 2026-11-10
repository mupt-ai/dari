import {
  nativeModelId,
  providerForModel,
  type RouterModelPrice,
} from "@mupt-ai/dari-router/policy-engine";

import type { ClientHarness, ResolvedRouterModelConfig, SubscriptionKind } from "../types.js";

const CODEX_BACKEND_URL = "https://chatgpt.com/backend-api";

// The model provider whose models each kind of plan serves.
const SUBSCRIPTION_MODEL_PROVIDERS: Record<SubscriptionKind, string> = {
  openai_codex: "openai",
  anthropic_claude_code: "anthropic",
  meta_muse: "meta",
};

// The client each plan is limited to, as its provider limits it: a Claude Code
// plan serves only Claude Code, and a Muse Code plan only Muse Code.
const SUBSCRIPTION_CLIENTS: Partial<Record<SubscriptionKind, ClientHarness>> = {
  anthropic_claude_code: "claude_code",
  meta_muse: "muse_code",
};

/**
 * Whether a plan may serve a model for this client: each plan serves only its
 * own provider's models, and only to the client its provider allows.
 */
export function subscriptionServes(
  kind: SubscriptionKind,
  model: string,
  clientHarness: ClientHarness | undefined,
): boolean {
  if (SUBSCRIPTION_MODEL_PROVIDERS[kind] !== providerForModel(model)) return false;
  const client = SUBSCRIPTION_CLIENTS[kind];
  return client === undefined || clientHarness === client;
}

// A ChatGPT plan serves OpenAI models as the `openai-codex` provider through
// the Codex backend.
export function codexModelConfig(
  modelId: string,
  price: RouterModelPrice | null,
): ResolvedRouterModelConfig {
  return {
    provider: "openai-codex",
    native_model_id: nativeModelId(modelId),
    api: "openai-codex-responses",
    base_url: CODEX_BACKEND_URL,
    // A plan bills no tokens; the catalog price only feeds cost estimates.
    cost: price ?? { input: 0, output: 0 },
    fast_mode: false,
  };
}
