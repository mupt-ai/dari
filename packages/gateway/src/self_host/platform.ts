import { activityError } from "../activity/params.js";
import { bearerToken } from "../http/auth.js";
import { errorCode } from "../http/errors.js";
import { selfHostedLink } from "../link/self_hosted.js";
import type { GatewayPlatform } from "../platform/platform.js";
import { subscriptionOAuthProviderFor } from "../providers/subscription_limits.js";
import { SELF_HOSTED_BLOB_BUCKET, type ActivityStore } from "./activity_store.js";
import type { PrefixStore } from "./prefix_store.js";
import { servedRouter } from "./router_specs.js";
import type { SessionPinStore } from "./session_pin_store.js";
import {
  gatewayKeyIndex,
  resolveSelfHostedRouter,
  SELF_HOSTED_ORGANIZATION_ID,
  type SelfHostedResolverDeps,
} from "./resolve.js";
import { type SubscriptionStore } from "./subscriptions/index.js";
import { refreshedAccessToken } from "./subscriptions/access.js";
import { hasBankedResets, providerBaseUrls, recoverHeldPlans } from "./subscriptions/resets.js";

/**
 * The self-hosted platform: routers from the config file and router specs,
 * subscriptions, Dari Link grants, prefix-cache state, session pins, and
 * Activity in the gateway's SQLite database, and one content-free log line
 * per request.
 */
export function createSelfHostedPlatform(deps: Omit<SelfHostedResolverDeps, "prefixHits"> & {
  activity: ActivityStore;
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
      deps.prefixes.writePendingLease(write, servedRouter(deps, write.router_id)?.zdr ?? false);
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
        : deps.subscriptions.selectCredential(plan, request.conversationId, new Date(), only, request.model);
      if (next === null) return undefined;
      return {
        credentialId: next.id,
        apiKey: await refreshedAccessToken(deps.subscriptions, next, { fetch: deps.fetch }),
      };
    },
    async markSubscriptionUnavailable({ credentialId, limit, linkGrantId, sources, resetMinHours }) {
      if (credentialId === undefined) return false;
      if (limit.model !== undefined) {
        return deps.subscriptions.holdModel(credentialId, limit.model, limit.resetsAt, limit.reason);
      }
      const another = deps.subscriptions.markUnavailable(credentialId, limit.resetsAt, limit.reason);
      if (linkGrantId === undefined) {
        // The owner's plans may come back early: from the provider's own
        // report, or by spending a banked reset (resets.ts).
        const held = deps.subscriptions.get(credentialId);
        if (held === null || held.owner !== null || !hasBankedResets(held)) return another;
        if (held.provider === "anthropic_claude_code" && another) return another;
        return await recoverHeldPlans({
          store: deps.subscriptions,
          fetch: deps.fetch,
          baseUrls: providerBaseUrls(deps.config.providers),
        }, held, { sources, resetMinHours });
      }
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
      try {
        deps.activity.record(record.row);
      } catch (error) {
        console.error("activity record failed", error instanceof Error ? error.message : String(error));
      }
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
          costUsd: record.link.costUsd,
          credentialId: record.link.credentialId,
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
    // Any gateway key reads the gateway's Activity, as the one organization
    // it serves (`current`).
    activity: {
      db: deps.activity.reads,
      saveSessionGitEvents: (write) => deps.activity.saveSessionGitEvents(write),
      async authorize(request, organizationRef) {
        let key: string;
        try {
          key = bearerToken(request.headers);
        } catch {
          throw activityError(401, "Missing or invalid API key");
        }
        if (gatewayKeyIndex(deps.gatewayKeys, key) === null) throw activityError(401, "Missing or invalid API key");
        if (organizationRef !== "current" && organizationRef !== SELF_HOSTED_ORGANIZATION_ID) {
          throw activityError(404, `Unknown organization ${organizationRef}.`);
        }
        return { organizationId: SELF_HOSTED_ORGANIZATION_ID };
      },
      async readBlob(bucket, key) {
        return bucket === SELF_HOSTED_BLOB_BUCKET ? deps.activity.readBlob(key) : null;
      },
      async importRequest({ organizationId }, report) {
        return deps.activity.importRequest(organizationId, report);
      },
    },
  };
}
