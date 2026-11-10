import { isRecord } from "@mupt-ai/dari-router/policy-engine";

// Gateways are the other kind of execution provider next to model providers:
// marketplaces that serve many owners' models behind one key and
// owner-prefixed ids ("openai/gpt-6-astra"). Mirrors the hosted Dari model
// catalog's gateways; keep the two in sync when adding a gateway.
//
// Every gateway speaks OpenAI chat completions with the nested
// `reasoning: { effort }` object and translates it for the upstream it picks,
// so the gateway's dialect, not the model's native one, decides the wire
// format. Gateways differ in endpoint and in the request fields that steer
// their routing.
export type Gateway = {
  label: string;
  baseUrl: string;
  // Pi compat that replaces model-level wire-format overrides.
  compat: Record<string, unknown>;
  // Routing fields merged into every request body; `zdr` restricts upstream
  // routing to zero-data-retention providers.
  requestFields(options: { zdr: boolean }): Record<string, unknown>;
};

function gateway(spec: Omit<Gateway, "compat"> & { compat?: Record<string, unknown> }): Gateway {
  return { ...spec, compat: { thinkingFormat: "openrouter", ...spec.compat } };
}

const GATEWAYS: Record<string, Gateway> = {
  openrouter: gateway({
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    requestFields: ({ zdr }) =>
      zdr ? { provider: { data_collection: "deny", zdr: true } } : {},
  }),
  // https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
  "vercel-ai-gateway": gateway({
    label: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    // Pi detects OpenRouter's role, caching, and session conventions from its
    // URL but not Vercel's: the system role reaches every upstream, and
    // x-session-affinity keeps prompt-cache locality.
    compat: {
      supportsDeveloperRole: false,
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openai",
    },
    // Vercel passes requests through untouched unless asked to place the
    // cache breakpoints Anthropic models need.
    requestFields: ({ zdr }) => ({
      providerOptions: {
        gateway: { caching: "auto", ...(zdr ? { zeroDataRetention: true } : {}) },
      },
    }),
  }),
};

export function gatewayFor(provider: unknown): Gateway | undefined {
  return typeof provider === "string" ? GATEWAYS[provider.toLowerCase()] : undefined;
}

/** Deep-merges gateway routing fields into a provider request body. */
export function payloadWithGatewayFields(
  payload: Record<string, unknown>,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...payload };
  for (const [key, value] of Object.entries(fields)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value)
      ? payloadWithGatewayFields(current, value)
      : value;
  }
  return merged;
}
