// Public entry points. Every module is also importable by path
// (`@mupt-ai/dari-gateway/<dir>/<module>`) for deployments that compose the
// gateway with their own platform. This entry needs no Bun APIs; the Bun
// server and the SQLite-backed self-hosted gateway live in `./bun`.
export { createRequestHandler, type GatewayHandlerOptions } from "./http/handler.js";
export type {
  GatewayPlatform,
  OperationalErrorContext,
  PendingLeaseWrite,
  PrefixStateWrite,
  ProviderCredentialRequest,
  RequestErrorContext,
  RequestRecord,
  RequestSummary,
  RequestTags,
  ResolveRouterRequest,
  SubscriptionHold,
} from "./platform/platform.js";
export {
  DEFAULT_CATALOG_PROVIDERS,
  listModelCatalog,
  type CatalogModel,
  type CatalogModelPrice,
  type CatalogPriceTier,
  type ModelCatalogOptions,
} from "./models/catalog.js";
export { createAutoRoutingSelectorBackend } from "./strategies/auto_routing_selector.js";
export { createPrioritySelectorBackend } from "./strategies/priority_selector.js";
export { createLlmSelectorBackend, type SelectorBackend } from "./strategies/routing.js";
export type { ProviderCredential, ResolvedRouter, SubscriptionKind } from "./types.js";
