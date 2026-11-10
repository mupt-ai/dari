import { gatewayFor } from "./gateways.js";

// Built-in model provider presentation and endpoint defaults; gateways carry
// their own. Mirrors the hosted Dari model catalog's provider defaults; keep
// the two in sync when adding a provider.

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  fireworks: "Fireworks",
  meta: "Meta",
  xai: "xAI",
  dari: "Dari",
  "amazon-bedrock": "Amazon Bedrock",
  azure: "Microsoft Azure",
};

/** Display label for a provider slug; custom slugs title-case per segment. */
export function providerLabel(provider: string): string {
  const known = PROVIDER_LABELS[provider.toLowerCase()] ?? gatewayFor(provider)?.label;
  if (known) return known;
  return (
    provider
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || provider
  );
}

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  fireworks: "https://api.fireworks.ai/inference/v1",
  xai: "https://api.x.ai/v1",
  // Meta's Model API serves OpenAI Responses and Chat Completions here, and
  // Anthropic Messages at https://api.meta.ai.
  meta: "https://api.meta.ai/v1",
  // Pi-ai derives the effective AWS region from the endpoint unless the
  // model config overrides base_url or the native id is an inference profile
  // ARN, so this default only pins us-east-1 when nothing else is configured.
  "amazon-bedrock": "https://bedrock-runtime.us-east-1.amazonaws.com",
  // Microsoft Azure has no default: the platform derives each model's base
  // URL from the credential's resource endpoint at resolve time.
};

/** Endpoint fallback when neither the resolved config nor the registry has one. */
export function defaultBaseUrl(provider: string): string | null {
  return PROVIDER_BASE_URLS[provider.toLowerCase()] ?? gatewayFor(provider)?.baseUrl ?? null;
}
