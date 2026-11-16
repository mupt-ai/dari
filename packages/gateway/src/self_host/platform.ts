import { errorCode } from "../http/errors.js";
import { selfHostedLink } from "../link/self_hosted.js";
import type { GatewayPlatform } from "../platform/platform.js";
import { subscriptionOAuthProviderFor } from "../providers/subscription_limits.js";
import type { PrefixStore } from "./prefix_store.js";
import type { SessionPinStore } from "./session_pin_store.js";
import { resolveSelfHostedRouter, type SelfHostedResolverDeps } from "./resolve.js";
import { freshAccessToken, type SubscriptionStore } from "./subscriptions/index.js";

/**
 * The self-hosted platform: routers from the config file, subscriptions,
 * Dari Link grants, prefix-cache state, and session pins in the gateway's
 * SQLite database, and one content-free log line per request.
 */
export function createSelfHostedPlatform(deps: Omit<SelfHostedResolverDeps, "prefixHits"> & {
  prefixes: PrefixStore;
  sessionPins: SessionPinStore;
  subscriptions: SubscriptionStore;
}): GatewayPlatform {
  const resolver: SelfHostedResolverDeps = {
    ...deps,
    prefixHits: (args) => deps.prefixes.hits(args),
  };
  return {
    resolveRouter: (request) => resolveSelfHostedRouter(resolver, request),
    writePrefixState: async (write) => {
      deps.prefixes.write(write);
    },
    writePendingLease: async (write) => {
      deps.prefixes.writePendingLease(write, deps.config.routers[write.router_id]?.zdr ?? false);
    },
    readSessionPin: async (key) => deps.sessionPins.read(key),
    writeSessionPin: async (write) => {
      deps.sessionPins.write(write);
    },
    recordSubscriptionUsage: async (report) => {
      deps.subscriptions.recordUsage(report.credentialId, report.usage);
    },
    async nextSubscription(request) {
      const plan = subscriptionOAuthProviderFor(request.provider, "subscription");
      const only = request.linkGrantId === undefined
        ? undefined
        : deps.links.credentialIds(request.linkGrantId);
      const next = plan === null
        ? null
        : deps.subscriptions.selectCredential(plan, request.conversationId, new Date(), only);
      if (next === null) return undefined;
      return {
        credentialId: next.id,
        apiKey: await freshAccessToken(deps.subscriptions, next, { fetch: deps.fetch }),
      };
    },
    async markSubscriptionUnavailable({ credentialId, limit, linkGrantId }) {
      if (credentialId === undefined) return false;
      if (limit.model !== undefined) {
        return deps.subscriptions.holdModel(credentialId, limit.model, limit.resetsAt, limit.reason);
      }
      const another = deps.subscriptions.markUnavailable(credentialId, limit.resetsAt, limit.reason);
      if (linkGrantId === undefined) return another;
      // A grant's retry may use only its own subscriptions.
      const provider = deps.subscriptions.get(credentialId)?.provider;
      return provider !== undefined && deps.subscriptions.activeCredential(
        provider,
        new Date(),
        deps.links.credentialIds(linkGrantId),
      ) !== null;
    },
    async recordUsage() {
      // Resolution never reports a "managed" key source here.
      throw new Error("The self-hosted gateway has no managed provider keys to account.");
    },
    recordRequest(record) {
      console.info("routing request", JSON.stringify(record.summary));
      if (record.link !== undefined) {
        const { summary } = record;
        deps.links.recordUsage({
          requestId: summary.request_id,
          grantId: record.link.grantId,
          receivedAt: typeof record.row.received_at === "string" ? new Date(record.row.received_at) : new Date(),
          model: summary.selected_model,
          thinking: record.link.thinking,
          tags: record.tags,
          inputTokens: summary.input_tokens ?? 0,
          outputTokens: summary.output_tokens ?? 0,
          cacheReadTokens: summary.cache_read_tokens ?? 0,
          cacheWriteTokens: summary.cache_write_tokens ?? 0,
          status: summary.status,
        });
      }
    },
    captureRequestError(error, context) {
      if (context.status < 500) return;
      console.error(
        "routing request error",
        JSON.stringify({
          router_id: context.routerId,
          request_id: context.requestId ?? null,
          source_protocol: context.sourceProtocol,
          status: context.status,
          error_code: errorCode(error, "internal_error"),
        }),
      );
    },
    captureOperationalError(error, context) {
      console.error(
        "gateway operational error",
        JSON.stringify({
          code: context.code,
          request_id: context.requestId ?? null,
          router_id: context.routerId ?? null,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
    link: selfHostedLink(deps),
  };
}
