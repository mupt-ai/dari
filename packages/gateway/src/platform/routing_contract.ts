// Stable public identity for the standard /v1 router. Platforms resolve it
// to the caller's default router.
export const DEFAULT_ROUTER_ALIAS = "default";

// The most prefix hashes one router resolution looks up.
export const ROUTING_PREFIX_HASHES_MAX_COUNT = 200;

// Names the gateway connected to hosted Dari that sent a request, so a model
// list counts the plans that gateway keeps on its computer.
export const GATEWAY_ID_HEADER = "x-dari-gateway-id";
