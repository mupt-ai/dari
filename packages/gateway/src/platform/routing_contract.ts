// Stable public identity for the standard /v1 router. Platforms resolve it
// to the caller's default router.
export const DEFAULT_ROUTER_ALIAS = "default";

// The most prefix hashes one router resolution looks up.
export const ROUTING_PREFIX_HASHES_MAX_COUNT = 200;

// The provider id of hosted Dari when a gateway connected to it calls it for
// a model, as `dari/model/<id>` with the user's Dari key.
export const HOSTED_DARI_PROVIDER = "dari";

// A request with this header set to `true` stays out of Activity: the
// platform keeps only what billing needs. A gateway in private mode sets it on
// every request, and on each it hands hosted Dari.
export const PRIVATE_HEADER = "x-dari-private";
