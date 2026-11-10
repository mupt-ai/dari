// Dari Auto Router — a hosted routing policy for self-hosted createRouter
// users. Dari bills the calling org per selection call.

import { RouterFrameworkError } from "./framework_error.js";
import {
  createDariRoutingPolicyInternal,
  type DariRoutingPolicyOptions,
} from "./dari_policy.js";
import type { RoutingPolicy } from "./framework_types.js";

export const DEFAULT_AUTO_ROUTER_ENDPOINT = "https://routing.dari.dev/v1/auto-router";
export const DEFAULT_AUTO_ROUTER_MODEL = "dari/auto-router";
export const DEFAULT_AUTO_ROUTER_CONTEXT_WINDOW_CHARS = 32_000;

export type CreateAutoRouterOptions<Metadata = unknown> = {
  apiKey: string;
  endpoint?: string;
} & Omit<
  DariRoutingPolicyOptions<Metadata>,
  | "selector"
  | "selectorModel"
  | "selectorContextWindowChars"
  | "strategy"
  | "customConfig"
  | "pricing"
  | "averageOutputTokensByModel"
> & {
  pricing?: DariRoutingPolicyOptions<Metadata>["pricing"];
  averageOutputTokensByModel?: DariRoutingPolicyOptions<Metadata>["averageOutputTokensByModel"];
};

export function createAutoRouter<Metadata = unknown>(
  options: CreateAutoRouterOptions<Metadata>,
): RoutingPolicy<Metadata> {
  if (!options.apiKey?.trim()) {
    throw new RouterFrameworkError(
      "configuration",
      "createAutoRouter requires an apiKey.",
      "auto_router_api_key_missing",
    );
  }
  // The hosted Auto Router serves only the default routing policy and drops
  // custom rules server-side, so accepting them here would silently ignore
  // them. Reject loudly instead of routing with rules the user thinks apply.
  const unsupported = options as { strategy?: unknown; customConfig?: unknown };
  if (unsupported.strategy !== undefined || unsupported.customConfig !== undefined) {
    throw new RouterFrameworkError(
      "configuration",
      "createAutoRouter does not support custom routing rules (strategy/customConfig): " +
        "the hosted Dari Auto Router serves only the default policy. Use " +
        "createDariRoutingPolicy with a self-hosted selector or the Dari managed " +
        "platform for custom routing.",
      "auto_router_custom_rules_unsupported",
    );
  }
  const endpoint = (options.endpoint ?? DEFAULT_AUTO_ROUTER_ENDPOINT)
    .replace(/\/+$/, "")
    .replace(/\/select$/, "");
  const {
    apiKey,
    endpoint: _endpoint,
    ...policyOptions
  } = options;

  return createDariRoutingPolicyInternal<Metadata>({
    ...policyOptions,
    selectorModel: DEFAULT_AUTO_ROUTER_MODEL,
    selectorContextWindowChars: DEFAULT_AUTO_ROUTER_CONTEXT_WINDOW_CHARS,
    selector: async (request, signal) => {
      let response: Response;
      try {
        response = await fetch(`${endpoint}/select`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
          signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new RouterFrameworkError(
          "policy",
          `Dari Auto Router request failed: ${error instanceof Error ? error.message : String(error)}`,
          "auto_router_request_failed",
          undefined,
          { cause: error },
        );
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new RouterFrameworkError(
          "policy",
          `Dari Auto Router returned HTTP ${response.status}: ${body}`,
          "auto_router_http_error",
        );
      }
      return await response.text();
    },
  }, false);
}
