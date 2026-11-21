import type { ActivityPlatform } from "../activity/http.js";
import type {
  Provider,
  ReasoningEffort,
  RoutingStrategy,
} from "@mupt-ai/dari-router/policy-engine";
import type { HarnessConversationIdentity } from "../runtime/harness_identity/index.js";
import type { InteractionRequest, SourceProtocol } from "../interaction/types.js";
import type { SubscriptionUsage, SubscriptionUsageLimit } from "../providers/subscription_limits.js";
import type {
  ClientHarness,
  ProviderCredential,
  ProviderKeySource,
  ResolvedRouter,
  SubscriptionKind,
} from "../types.js";

/**
 * Everything the gateway runtime needs from the deployment around it: router
 * configuration and credentials, durable routing state, accounting sinks, and
 * error reporting. The self-hosted gateway implements it with a local config
 * file and SQLite (`self_host/`); other deployments supply their own.
 *
 * Methods may throw. Call sites that must not fail a served request catch,
 * log, and continue.
 */
export type GatewayPlatform = {
  /**
   * Optional. The web page where users manage their subscriptions; usage-limit
   * errors link to it, with `?buy=<provider>` to add another plan. Without
   * one they point at `dari accounts`.
   */
  accountsUrl?: string;
  /**
   * Authenticate the request's key and return the router it may use, with
   * decrypted provider credentials and the prefix-cache evidence matching
   * `prefixHashes`. Throws HttpError(401) for an unknown key.
   */
  resolveRouter(request: ResolveRouterRequest): Promise<ResolvedRouter>;
  /**
   * Optional. Supply the credential for one enabled model of this request,
   * consulted after `resolveRouter` and before its provider keys (for the
   * self-hosted gateway, its environment keys), so an embedder can serve
   * per-tenant keys from its own store. Undefined keeps the resolved key. A
   * credential with `subscription` serves the model on that plan, even on a
   * strict router; a plan that cannot serve the model for this client (see
   * SubscriptionKind) is ignored.
   */
  resolveProviderCredential?(
    request: ProviderCredentialRequest,
  ): Promise<ProviderCredential | undefined>;
  /** Persist one completed turn's prefix entry and/or refresh a read entry. */
  writePrefixState(write: PrefixStateWrite): Promise<void>;
  /** Set or clear a conversation's prefetched routing lease. */
  writePendingLease(write: PendingLeaseWrite): Promise<void>;
  /** The pair a session pinned on a session-pinning router, or null. */
  readSessionPin(request: SessionPinKey): Promise<SessionPin | null>;
  /** Pin a session to a pair, replacing any earlier pin. */
  writeSessionPin(write: SessionPinKey & SessionPin): Promise<void>;
  /**
   * Hold an exhausted personal subscription until it resets. Resolves whether
   * another connected subscription for the same provider can serve a retry.
   * A limit naming a `model` holds only that model on the subscription, which
   * keeps serving the router's other models; it resolves whether the hold
   * landed, since those models then serve a retry.
   */
  markSubscriptionUnavailable(hold: SubscriptionHold): Promise<boolean>;
  /**
   * Optional. Record how much of a personal subscription's quota a successful
   * response reports used, so the platform can move new conversations to
   * plans with headroom before one runs out.
   */
  recordSubscriptionUsage?(report: SubscriptionUsageReport): Promise<void>;
  /**
   * Optional. After `markSubscriptionUnavailable` reports another plan can
   * serve, the plan that serves this conversation next, so the gateway
   * retries the request on it at once instead of failing it. Undefined when
   * none can.
   */
  nextSubscription?(request: NextSubscriptionRequest): Promise<NextSubscription | undefined>;
  /**
   * Account one call served on a platform-managed provider key. Only reached
   * when `resolveRouter` reports a "managed" key source.
   */
  recordUsage(usage: Record<string, unknown>): Promise<void>;
  /** Receive the finished request's log row. Must not throw. */
  recordRequest(record: RequestRecord): void;
  captureRequestError(error: unknown, context: RequestErrorContext): void;
  captureOperationalError(error: unknown, context: OperationalErrorContext): void;
  /**
   * Optional. Dari Link: OAuth grants that let a registered app send one
   * user's requests through the gateway on the subscriptions the user chose,
   * and nothing else. Without it the `/v1/link/...` endpoints answer 404.
   */
  link?: LinkPlatform;
  /**
   * Optional. Activity: the routed requests' usage, spend, conversations, and
   * tools, read under `/v1/organizations/{organization}/routing/activity/`.
   * Without it those endpoints answer 404.
   */
  activity?: ActivityPlatform;
};

/**
 * Dari Link as the gateway's endpoints use it. A platform builds it with
 * `linkPlatform` (link/service.ts) from its storage and its users, so the
 * rules are the same everywhere.
 *
 * Methods throw HttpError(401) for a key that cannot act, HttpError(401,
 * `invalid_client`) for a confidential client without its secret, and
 * HttpError(400) with code `invalid_grant`, `refresh_race`, `invalid_client`,
 * or `invalid_request` for a request the protocol refuses.
 *
 * A link token is a gateway key for `resolveRouter`: the platform checks it
 * with `linkTokenGrant` (live, within its budget) and serves it the default
 * router on only the grant's subscriptions, never an API key or credits, and
 * sets `link_grant_id` and `link_models`. It fails the request with 424
 * `subscription_exhausted` (and `resets_at`), `subscription_client_mismatch`,
 * or `model_not_granted` when no granted plan can serve. A revoked grant's
 * tokens stop at once.
 */
export type LinkPlatform = {
  /** What the gateway's approval and connections pages need. */
  approval: LinkApprovalPage;
  /**
   * Hosts, besides loopback, an app may register an http (not https) redirect
   * URI on: exact names, or `*.suffix` for any subdomain. For private dev hosts
   * on a self-hosted gateway; absent or empty allows none.
   */
  httpRedirectHosts?: readonly string[];
  /**
   * Register an app. With `apiKey`, as that user; without, as an open dynamic
   * registration (RFC 7591), which the gateway rate-limits. A confidential
   * app gets a client secret, returned this once.
   */
  registerApp(request: {
    apiKey?: string;
    name: string;
    redirectUris: string[];
    confidential?: boolean;
  }): Promise<LinkApp & { clientSecret?: string }>;
  /** The registered app, or null for an unknown client id. */
  app(clientId: string): Promise<LinkApp | null>;
  /** Redeem a code once for the grant's first tokens. */
  exchangeCode(request: LinkCodeExchange): Promise<LinkTokens>;
  /**
   * A new access token. A public client's refresh token rotates: the one
   * presented stops working, presenting it again within a minute is refused
   * with `refresh_race`, and later reuse revokes the grant. A confidential
   * client keeps its refresh token.
   */
  refresh(request: LinkClient & { refreshToken: string }): Promise<LinkTokens>;
  /**
   * Trade a grant's access token for a child token (RFC 8693) that serves only
   * its models, cannot refresh, mint, or read the grant, and dies with the grant.
   */
  exchangeToken(request: LinkTokenExchange): Promise<LinkChildToken>;
  /**
   * The live grant an access token belongs to. Throws the 401 a dead token
   * gets, and 403 for a child token.
   */
  grant(accessToken: string): Promise<LinkGrantDetail>;
  /**
   * What a grant's requests used, by every token of it (child tokens
   * included), filtered to requests carrying every given tag and received in
   * the time range. Authenticates like `grant`: a child token gets 403.
   */
  usage(request: LinkUsageQuery): Promise<LinkUsage>;
  /**
   * Revoke the grant a token (access, refresh, or child) belongs to when it
   * is the client's (RFC 7009). Unknown tokens are ignored.
   */
  revokeToken(request: LinkClient & { token: string }): Promise<void>;
  /**
   * The user's grants that are not revoked, app connections and personal
   * endpoints alike, each with every granted credential's spend this month.
   * `apiKey` is a personal management key, or on hosted Dari the user's session.
   */
  grants(apiKey: string): Promise<LinkManagedGrant[]>;
  /** The plans and API keys the user can grant. */
  plans(apiKey: string): Promise<LinkSubscription[]>;
  /**
   * A personal endpoint: a grant the user makes for themselves on their chosen
   * plans and keys, and its key, returned this once, which an app that takes
   * the user's own key calls with. Throws HttpError(400) for a plan or key the
   * user does not have, or for bad limits.
   */
  createEndpoint(request: {
    apiKey: string;
    name: string;
    credentialIds: string[];
    limits: LinkLimit[];
  }): Promise<{ grant: LinkManagedGrant; key: string }>;
  /** Rename one of the user's endpoints or change its plans; false when they have none by that id. */
  updateEndpoint(request: { apiKey: string; grantId: string; name?: string; credentialIds?: string[] }): Promise<boolean>;
  /** Another key for one of the user's endpoints, returned this once; null when they have none by that id. */
  issueEndpointKey(request: { apiKey: string; grantId: string }): Promise<string | null>;
  /**
   * Replace one of the user's grants' monthly spend limits (empty removes
   * them); false when the user has no grant by that id.
   */
  setLimits(request: { apiKey: string; grantId: string; limits: LinkLimit[] }): Promise<boolean>;
  /** Revoke one of the user's grants; false when it has none by that id. */
  revokeGrant(request: { apiKey: string; grantId: string }): Promise<boolean>;
  /**
   * Replace one of the user's grants' budget (empty removes it); false when
   * the user has no grant by that id.
   */
  setBudget(request: { apiKey: string; grantId: string; budget: LinkBudget[] }): Promise<boolean>;
};

/**
 * What the gateway's approval and connections pages need. The gateway
 * remembers the user in a signed cookie as a subject, so their plans are there
 * the next time an app asks and they manage their connections there. With
 * `signIn` the subject is the account they signed in with; without it the
 * pages need no account, and a user's first plan makes their subject.
 */
export type LinkApprovalPage = {
  /**
   * The secret that signs the pages' cookies. Throws HttpError(503,
   * `link_not_configured`) when the platform has none.
   */
  sessionSecret(): string;
  /**
   * Set on a platform whose users have accounts: the page then acts only for
   * a user who signed in with one, so their plans follow them to any browser.
   */
  signIn?: LinkSignIn;
  /** The kinds of plan a user can connect on the page, in the order offered. */
  connectable: readonly SubscriptionKind[];
  /** The providers and gateways a user can add an API key for, in the order offered. */
  keyProviders: readonly LinkKeyProvider[];
  /**
   * Add the user's API key for one of `keyProviders`, replacing their earlier
   * key for it; without a subject, the key makes a new user. Throws
   * HttpError(400) for a key the provider refuses.
   */
  addKey(subject: string | null, provider: string, apiKey: string): Promise<LinkPlanAdded>;
  /** The plans this user connected and the API keys they added, which an approval chooses among. */
  subscriptions(subject: string): Promise<LinkSubscription[]>;
  /** Start the provider's sign-in for a plan of this kind. */
  startConnect(kind: SubscriptionKind): Promise<LinkConnect>;
  /**
   * Finish a sign-in `startConnect` began: with the code the provider showed
   * the user, or for a provider that shows the user a code to enter, with
   * nothing. Without a subject, the plan makes a new user. Null while the
   * provider still waits on the user. Throws HttpError(400) for a code the
   * provider refuses or a sign-in that ended.
   */
  completeConnect(subject: string | null, session: string, authorizationResponse: string): Promise<LinkPlanAdded | null>;
  /**
   * Forget one of the user's plans or API keys: its stored tokens or key are
   * deleted, every app loses it, and a grant left with nothing is revoked.
   * False when the user has none by that id.
   */
  remove(subject: string, credentialId: string): Promise<boolean>;
  /**
   * One of the user's live grants for this app, which an update request edits
   * in place; null when the user has none by that id.
   */
  grant(subject: string, grantId: string, clientId: string): Promise<Pick<LinkGrant, "credentialIds" | "budget"> | null>;
  /** Create a grant on the chosen subscriptions and return its one-time code. */
  approve(request: LinkApproval): Promise<{ code: string }>;
  /** The user's live grants, oldest first, as the connections page shows them. */
  connections(subject: string): Promise<LinkConnection[]>;
  /** The user ends one of their grants; false when they have none by that id. */
  disconnect(subject: string, grantId: string): Promise<boolean>;
  /** Replace one of the user's grants' monthly spend limits; false when they have none by that id. */
  setLimits(subject: string, grantId: string, limits: LinkLimit[]): Promise<boolean>;
};

/**
 * The platform's own sign-in. The page sends the user to `url()` with `state`
 * and `next`; the platform signs them in and returns them to
 * `/v1/link/session` with the same `next` and a ticket for that state.
 * Signing out sends the user to `signOutUrl()` with `next`; the platform ends
 * its own sign-in and returns them to `next`, so the next sign-in can be
 * another account.
 */
export type LinkSignIn = {
  /** Throws HttpError(503, `link_not_configured`) when the platform has none. */
  url(): string;
  /** Throws HttpError(503, `link_not_configured`) when the platform has none. */
  signOutUrl(): string;
  /** Who a ticket signed in, for which state, and when (epoch ms); null for no ticket. */
  redeem(ticket: string): Promise<{ subject: string; state: string; issuedAt: number } | null>;
};

/** A plan or API key the user added, and who they are now. */
export type LinkPlanAdded = { subject: string; credentialId: string };

/** One of a user's grants on the connections page. */
export type LinkConnection = LinkGrantDetail & { usage: LinkUsageTotals };

/** A model provider or gateway whose API key a user can add on the approval page. */
export type LinkKeyProvider = { id: string; name: string };

/** A provider sign-in under way on the approval page. */
export type LinkConnect = {
  // Names the sign-in to `completeConnect`.
  session: string;
  // Where the user signs in to the provider.
  authorizationUrl: string;
  // The code the user enters at the provider; null when the provider instead
  // shows the user a code to bring back.
  userCode: string | null;
};

/**
 * The most tokens a grant's app may use in a rolling window, across all of
 * the grant's plans and API keys. See link/budget.ts for how tokens
 * are counted.
 */
export type LinkBudget = { windowMinutes: number; maxTokens: number };

/**
 * The most a grant may spend on one of its plans or API keys in a calendar
 * month (UTC), in US dollars. A plan's spend is what its requests would have
 * cost at API prices. See link/budget.ts.
 */
export type LinkLimit = { credentialId: string; monthlyUsd: number };

/** A granted plan or key's spend this month, and its limit when it has one. */
export type LinkSpend = {
  credentialId: string;
  spentUsd: number;
  monthlyUsd: number | null;
  // At its limit: the grant leaves it out until the month ends.
  reached: boolean;
};

/** A budget window as it stands for a grant. */
export type LinkBudgetStanding = {
  windowMinutes: number;
  maxTokens: number;
  usedTokens: number;
  // At the cap: when enough of the window rolls off to be under it; else null.
  resetsAt: string | null;
};

/** A client as it authenticates at the token and revocation endpoints. */
export type LinkClient = {
  clientId: string;
  // The secret a confidential client sent with HTTP Basic.
  clientSecret?: string;
};

export type LinkApp = {
  clientId: string;
  name: string;
  redirectUris: string[];
  // A confidential client holds a secret; a public one relies on PKCE alone.
  confidential: boolean;
};

/** One quota window of a plan: its length, share used (0 to 1), and reset. */
export type LinkUsageWindow = {
  modelFamily?: "fable";
  minutes: number;
  utilization: number;
  resetsAt: string;
};

export type LinkSubscription = {
  id: string;
  // The plan, such as `anthropic_claude_code` or `openai_codex`; `api_key`
  // for an API key.
  provider: string;
  // For an API key: the model provider or gateway it is a key for, such as
  // `anthropic` or `openrouter`. It serves that provider's models to any app.
  apiKeyProvider?: string;
  name: string;
  label: string | null;
  // The account the plan belongs to, when the provider reported it.
  accountEmail: string | null;
  // When the plan is held at its usage limit, the time the hold ends.
  unavailableUntil: string | null;
  // Quota windows the plan last reported, shortest first; empty when unknown.
  usage: LinkUsageWindow[];
};

export type LinkApproval = {
  subject: string;
  // Update mode: edit this grant of the user's in place (same id, its tokens
  // keep working) instead of creating one.
  grantId?: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  credentialIds: string[];
  budget: LinkBudget[];
};

export type LinkCodeExchange = LinkClient & {
  code: string;
  redirectUri: string;
  // The S256 challenge of the code verifier the client presented.
  codeChallenge: string;
};

export type LinkTokens = {
  accessToken: string;
  refreshToken: string;
  // Seconds until the access token expires.
  expiresIn: number;
};

export type LinkTokenExchange = LinkClient & {
  // The grant's access token.
  subjectToken: string;
  // The catalog models the child token serves, such as `openai/gpt-5.5`, each
  // with the thinking level every request for it is served at, when pinned.
  models: Array<{ model: string; thinking?: string }>;
  // Seconds the child token lives.
  expiresIn: number;
  // Attribution labels the child token carries onto its requests.
  tags: Record<string, string>;
};

export type LinkChildToken = {
  accessToken: string;
  expiresIn: number;
  grantId: string;
};

export type LinkGrant = {
  id: string;
  clientId: string;
  // The app's name, or a personal endpoint's own.
  appName: string;
  // A grant the user made for themselves, called with a key (see `createEndpoint`).
  endpoint: boolean;
  credentialIds: string[];
  createdAt: string;
  budget: LinkBudget[];
  limits: LinkLimit[];
};

/** A grant as its user manages it. */
export type LinkManagedGrant = LinkGrant & { spend: LinkSpend[] };

/** A grant as its app sees it: the granted subscriptions themselves. */
export type LinkUsageQuery = {
  accessToken: string;
  // Each must equal the request's tag of that key.
  tags: Record<string, string>;
  // Inclusive lower and exclusive upper bound on when a request was received.
  since?: Date;
  until?: Date;
  // Also total by this tag's values.
  groupByTag?: string;
  // Only this request, by the id its response's `X-Request-Id` named.
  requestId?: string;
};

/** Token counts in one shape for every protocol: input excludes cache reads and writes. */
export type LinkUsageTotals = {
  requests: number;
  // Requests the provider or Dari failed (status provider_error or
  // selector_error); they count in `requests` too.
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type LinkUsage = LinkUsageTotals & {
  // One entry per model and thinking level served, by most requests first.
  byModel: Array<LinkUsageTotals & { model: string; thinking: string | null }>;
  // With `groupByTag`: one entry per value of that tag (null: requests without it), most requests first.
  byTag?: Array<LinkUsageTotals & { value: string | null }>;
  // Every request of the grant received before this time is counted; null
  // when the platform cannot tell (see the README).
  completeThrough: string | null;
};

export type LinkGrantDetail = Omit<LinkGrant, "credentialIds" | "budget" | "limits"> & {
  budget: LinkBudgetStanding[];
  spend: LinkSpend[];
  subscriptions: LinkSubscription[];
};

export type ResolveRouterRequest = {
  routerId: string;
  apiKey: string;
  prefixHashes?: string[];
  conversationId?: string;
  includePublicEvalCatalog?: boolean;
  clientHarness?: ClientHarness;
  // A later resolve with this request's `conversationId` replaces this one's
  // credentials, so none from it serve the request: a platform should not
  // mark a credential used or refresh it for this resolve.
  provisional?: boolean;
};

export type ProviderCredentialRequest = {
  provider: Provider;
  model: string;
  routerId: string;
  organizationId: string;
  // The gateway key the request authenticated with.
  apiKey: string;
  clientHarness?: ClientHarness;
};

export type PrefixStateWrite = {
  organization_id: string;
  router_id: string;
  received_at: string;
  zdr: boolean;
  prefix_entry: Record<string, unknown> | null;
  touched_prefix_hash: string | null;
};

export type PendingLeaseWrite = {
  router_id: string;
  conversation_id: string;
  // Conversation depth this write was decided at; writes decided shallower
  // than the last applied one are fenced out.
  decided_at_depth: number;
  pending_lease: {
    model: string;
    reasoning_effort: string;
    turns: number;
    reason: string;
    output_text: string | null;
  } | null;
};

// A main agent and each of its subagents have their own pin key.
export type SessionPinKey = {
  routerId: string;
  pinKey: string;
};

export type SessionPin = {
  model: string;
  reasoningEffort: ReasoningEffort;
};

export type SubscriptionHold = {
  userId: string;
  credentialId: string | undefined;
  limit: SubscriptionUsageLimit;
  // The Dari Link grant the request ran under; another plan serves a retry
  // only when the grant may use it.
  linkGrantId?: string;
};

export type NextSubscriptionRequest = {
  userId: string;
  provider: Provider;
  model: string;
  conversationId: string;
  // The Dari Link grant the request ran under: the next plan must be one of
  // its subscriptions.
  linkGrantId?: string;
};

export type NextSubscription = {
  credentialId: string;
  // The plan's access token, sent as the bearer credential.
  apiKey: string;
};

export type SubscriptionUsageReport = {
  userId: string;
  credentialId: string;
  usage: SubscriptionUsage;
};

export type RequestRecord = {
  // The full request log row: routing decision, usage, costs, and (outside
  // ZDR) request and response content.
  row: Record<string, unknown>;
  // A content-free summary of the same request.
  summary: RequestSummary;
  distinctId: string;
  interaction: InteractionRequest;
  isNewConversation: boolean;
  zdr: boolean;
  harnessConversationIdentity?: HarnessConversationIdentity;
  // Parsed from the request's X-Dari-Tags header, plus a Dari Link child
  // token's tags; empty when absent.
  tags: RequestTags;
  // Set for a Dari Link token's request: its grant, and the thinking the
  // provider was sent (as X-Dari-Thinking-Level reports it).
  link?: { grantId: string; thinking: string | null; costUsd: number | null; credentialId: string | null };
  // The router's non-secret routing settings, for embedders that compare or
  // replay routing decisions.
  router: RequestRecordRouter;
  // The model and reasoning pairs this request could be routed to, after
  // capability, custom-rule, and cost pruning.
  candidates: Array<{ model: string; reasoningEffort: ReasoningEffort }>;
  // The session pin key this request routed under, when the router pins
  // sessions and the request was pinnable (not strict, explicit, or
  // background). Each harness subagent has its own key.
  sessionPinKey?: string;
};

export type RequestRecordRouter = {
  enabledModels: string[];
  // Each enabled model's selectable reasoning levels: the router's
  // configured levels, else the model's supported levels.
  thinkingLevels: Record<string, ReasoningEffort[]>;
  // The level a requested dari/model/<id> uses when the request sets none.
  defaultThinkingLevels: Record<string, ReasoningEffort>;
  strict: boolean;
  speculativeRouting: boolean;
  sessionPinning: boolean;
};

// Caller-supplied attribution labels (run, trial, setting), opaque to the
// gateway.
export type RequestTags = Record<string, string>;

export type RequestSummary = {
  request_id: string;
  organization_id: string;
  router_id: string;
  api_key_id: string | null;
  source_protocol: SourceProtocol;
  request_kind: "user_message" | "tool_continuation" | "other";
  status: "completed" | "provider_error" | "selector_error" | "aborted";
  error_code: string | null;
  stream: boolean;
  zdr: boolean;
  strategy: RoutingStrategy;
  selected_model: string | null;
  selected_provider: Provider | null;
  selected_reasoning_effort: ReasoningEffort | null;
  next_model: string | null;
  next_reasoning_effort: ReasoningEffort | null;
  provider_key_source: ProviderKeySource | null;
  message_count: number;
  tool_count: number;
  candidate_count: number;
  provider_attempt_count: number;
  prefix_match_depth: number | null;
  prefix_warm_tokens: number | null;
  selector_latency_ms: number | null;
  provider_latency_ms: number | null;
  total_latency_ms: number;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  // Provider-reported cost when the provider returns one (OpenRouter, Vercel
  // AI Gateway), otherwise priced from the model's rates when known.
  total_cost_usd: number | null;
  cost_source: "provider" | "pricing" | null;
  pricing_known: boolean | null;
};

export type RequestErrorContext = {
  request: Request;
  routerId: string;
  requestId?: string;
  sourceProtocol: SourceProtocol | "openai_models" | "anthropic_models";
  status: number;
};

export type OperationalErrorCode =
  | "background_drain_timeout"
  | "billing_usage_report_failed"
  | "routing_report_assembly_failed"
  | "routing_report_barrier_failed"
  | "server_force_stop_failed"
  | "session_pin_write_failed"
  | "stream_report_finalization_failed"
  | "subscription_unavailable_ingest_failed"
  | "subscription_usage_record_failed"
  | "next_subscription_lookup_failed";

export type OperationalErrorContext = {
  code: OperationalErrorCode;
  requestId?: string;
  routerId?: string;
};

let bound: GatewayPlatform | null = null;

/** Bind the platform every request uses. The latest binding wins. */
export function bindGatewayPlatform(platform: GatewayPlatform): void {
  bound = platform;
}

export function gatewayPlatform(): GatewayPlatform {
  if (bound === null) {
    throw new Error("No gateway platform is bound; create the request handler first.");
  }
  return bound;
}
