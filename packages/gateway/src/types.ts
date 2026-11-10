import type {
  CustomRouterConfig,
  Provider,
  ReasoningEffort,
  RouterEval,
  RouterEvalScore,
  RouterModelPrice,
  RouterPrefixHit,
  RoutingDecision,
  RoutingStrategy,
} from "@mupt-ai/dari-router/policy-engine";
// The router resolution contract between the gateway runtime and its
// platform. All algorithmic routing types live in @mupt-ai/dari-router.

// "subscription" is a personal Codex/Claude Code plan serving the request in
// place of the router's configured key. It bills no tokens, so it never takes
// the managed-key billing path, and telemetry reports it as its own source.
export type ProviderKeySource = "user" | "managed" | "subscription";

export type BearerProviderAuth = {
  type: "bearer";
  apiKey: string;
};

export type AwsSigV4ProviderAuth = {
  type: "aws_sigv4";
  access_key_id: string;
  secret_access_key: string;
  session_token?: string | null;
  region: string;
};

// A customer IAM role the routing runtime assumes with Dari's own AWS
// identity before signing Bedrock requests; the resolve payload carries no
// customer secret for this type.
export type AwsAssumeRoleProviderAuth = {
  type: "aws_assume_role";
  role_arn: string;
  external_id: string;
  region: string;
};

// Authentication a provider call can use directly.
export type ResolvedProviderAuth = BearerProviderAuth | AwsSigV4ProviderAuth;

// A personal plan whose access token serves its provider's models in place of
// an API key:
// - "openai_codex": a ChatGPT plan; the token is Codex's auth.json
//   `tokens.access_token`, served through the Codex backend.
// - "anthropic_claude_code": a Claude Code plan; the token is the OAuth token
//   `claude setup-token` prints. It serves Claude Code clients only.
// - "meta_muse": a Meta (Muse) sign-in; the token is the Model API key the
//   sign-in mints (Pi's Meta OAuth `access`).
export type SubscriptionKind = "openai_codex" | "anthropic_claude_code" | "meta_muse";

// A bearer credential an embedding platform supplies for one request through
// GatewayPlatform.resolveProviderCredential, optionally with its own endpoint.
// With `subscription`, `apiKey` is that plan's access token; the platform keeps
// it fresh.
export type ProviderCredential = {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  subscription?: SubscriptionKind;
};

export type ProviderAuth = ResolvedProviderAuth | AwsAssumeRoleProviderAuth;

export type AwsProviderAuth = AwsSigV4ProviderAuth | AwsAssumeRoleProviderAuth;

export type PublicEvalCatalogScore = RouterEvalScore & {
  source_row_name?: string | null;
  source_date?: string | null;
  last_synced_at?: string | null;
  sample_count?: number | null;
};

export type PublicEvalCatalogCard = Omit<RouterEval, "scores"> & {
  source_id: string;
  source_name: string;
  source_url: string;
  harness: string;
  updated_at: string | null;
  scores: PublicEvalCatalogScore[];
};

// A decision as served: session-pinned decisions say so in response headers
// and Anthropic routing metadata.
export type ServedDecision = RoutingDecision & { sessionPinned?: boolean };

export type ClientHarness = "claude_code" | "muse_code";

export type ResolvedRouterModelConfig = {
  provider: string;
  native_model_id: string;
  api: string;
  base_url?: string | null;
  context_window?: number | null;
  standard_context_limit?: number | null;
  allow_long_context?: boolean;
  max_output_tokens?: number | null;
  supported_thinking_levels?: ReasoningEffort[] | null;
  default_thinking_level?: ReasoningEffort | null;
  average_output_tokens?: Partial<Record<ReasoningEffort, number>> | null;
  cost: RouterModelPrice;
  supports_managed_key?: boolean;
  fast_mode?: boolean;
  fast_mode_cost?: RouterModelPrice | null;
  // Copied from the router at execution time, like allow_long_context.
  zdr?: boolean;
};

export type ResolvedRouter = {
  router_id: string;
  organization_id: string;
  api_key_id: string | null;
  attributed_user_id: string | null;
  enabled_models: string[];
  provider_keys: Partial<Record<Provider, string>>;
  provider_auth?: Partial<Record<Provider, AwsProviderAuth>>;
  provider_key_sources?: Partial<Record<Provider, ProviderKeySource>>;
  // Model -> the platform-supplied credential that replaces the provider key
  // above for this request. Filled from resolveProviderCredential.
  provider_credentials?: Record<string, ProviderCredential>;
  // Execution provider -> the user's subscription credential serving it.
  subscription_credential_ids?: Partial<Record<Provider, string>>;
  zdr?: boolean;
  allow_long_context?: boolean;
  speculative_routing?: boolean;
  // Route each session's (and each subagent's) first turn, then serve that
  // pair for the rest of the session instead of selecting or leasing.
  session_pinning?: boolean;
  primary_retries?: number;
  // Serve only the requested `dari/model/<id>` at the requested thinking
  // level: no selector, lease, or personal subscription the platform did not
  // supply through resolveProviderCredential, and an error for anything
  // else, whatever the client sends.
  strict?: boolean;
  // On strict routers only, allow requested catalog models of these providers.
  // Requires dari/model/<provider>/<id>.
  strict_providers?: string[];
  evals?: RouterEval[];
  // When true, fill missing eval scores using thinking-level ratios or an
  // explicitly mapped predecessor model.
  eval_score_imputation?: boolean;
  // Absent means ON: image-bearing requests exclude candidates whose model
  // cannot accept image input before strategy resolution.
  image_capability_filtering?: boolean;
  // Absent means ON — deliberate: resolutions captured before the key existed
  // must keep lease-context behavior, so platforms send an explicit value
  // (the self-hosted platform sends false). When off, selector
  // inputs carry no task or lease_history keys and no lease history is
  // reconstructed, matching the pre-lease-context wire shape exactly.
  lease_context_enabled?: boolean;
  // Absent means OFF: the selector sees `<image omitted>` placeholders. When
  // true, request images are numbered in the selector prompt and attached to
  // the policy call as image parts, provided the deployed policy accepts them.
  selector_image_input_enabled?: boolean;
  public_eval_catalog?: PublicEvalCatalogCard[] | null;
  prefix_hits?: RouterPrefixHit[];
  routing_strategy?: RoutingStrategy;
  custom_config?: CustomRouterConfig | null;
  model_thinking_levels?: Record<string, ReasoningEffort[]>;
  fast_models?: string[];
  model_prices?: Record<string, RouterModelPrice>;
  model_configs?: Record<string, ResolvedRouterModelConfig>;
  // The organization's credits are exhausted: only models a personal
  // subscription serves keep serving; every other billable request is refused.
  credit_exhausted?: boolean;
  // False when the organization is not on the Autorouting plan. A missing
  // value is treated as enabled.
  autorouting_enabled?: boolean;
};
