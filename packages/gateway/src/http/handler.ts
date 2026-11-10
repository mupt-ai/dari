import {
  handleResponses,
  handleResponsesWebSocketFallback,
} from "../ingress/codex.js";
import { handleModels } from "../ingress/models.js";
import { handleMuseCodeModels } from "../ingress/muse_models.js";
import { handleChatCompletions } from "../ingress/chat_completions.js";
import { handleAnthropicMessages } from "../ingress/anthropic_messages.js";
import { bindGatewayPlatform, type GatewayPlatform } from "../platform/platform.js";
import { DEFAULT_ROUTER_ALIAS } from "../platform/routing_contract.js";
import type { SelectorBackend } from "../strategies/routing.js";
import { errorResponse, HttpError } from "./errors.js";

export type GatewayHandlerOptions = {
  platform: GatewayPlatform;
  selectorBackend: SelectorBackend;
};

/**
 * The gateway's routed HTTP surface: `/v1/{chat/completions,responses,
 * messages,models}` on the default router and `/{router_id}/v1/...` on a
 * named one. Binds `options.platform` for every request it serves.
 */
export function createRequestHandler(options: GatewayHandlerOptions) {
  const { selectorBackend } = options;
  bindGatewayPlatform(options.platform);
  return async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      (url.pathname === "/healthz" || url.pathname === "/health")
    ) {
      return Response.json({ status: "ok" });
    }
    // Muse Code reads its model list from its base URL's origin; `dari muse`
    // forwards it to the router's own path.
    const museModels = url.pathname.match(/^(?:\/([^/]+))?\/muse-code\/models$/);
    if (request.method === "GET" && museModels !== null) {
      return await handleMuseCodeModels(request, museModels[1] ?? DEFAULT_ROUTER_ALIAS);
    }
    // Claude Code probes this first-party endpoint before its Messages call
    // when ANTHROPIC_BASE_URL points at a compatible gateway.
    if (request.method === "HEAD" && url.pathname === "/api/hello") {
      return new Response(null, { status: 200 });
    }

    const endpoint = routedEndpoint(url.pathname);
    if (endpoint?.protocol === "chat" && request.method === "POST") {
      return await handleChatCompletions(
        request,
        endpoint.routerId,
        selectorBackend,
      );
    }
    if (endpoint?.protocol === "responses") {
      if (request.method === "GET") return handleResponsesWebSocketFallback();
      if (request.method === "POST") {
        return await handleResponses(
          request,
          endpoint.routerId,
          selectorBackend,
        );
      }
    }
    if (endpoint?.protocol === "messages" && request.method === "POST") {
      return await handleAnthropicMessages(
        request,
        endpoint.routerId,
        selectorBackend,
      );
    }
    if (endpoint?.protocol === "models" && request.method === "GET") {
      return await handleModels(request, endpoint.routerId);
    }

    return errorResponse(new HttpError(404, "Not found", "not_found"));
  };
}

type RoutedEndpoint = {
  routerId: string;
  protocol: "chat" | "responses" | "messages" | "models";
};

function routedEndpoint(pathname: string): RoutedEndpoint | null {
  const defaultProtocol = protocolForSuffix(pathname, "/v1");
  if (defaultProtocol !== null) {
    return { routerId: DEFAULT_ROUTER_ALIAS, protocol: defaultProtocol };
  }
  const match = pathname.match(
    /^\/([^/]+)(?:\/v1)?\/(chat\/completions|responses|messages|models)$/,
  );
  if (match === null) return null;
  return {
    routerId: match[1],
    protocol: protocolForRoute(match[2]),
  };
}

function protocolForSuffix(
  pathname: string,
  prefix: string,
): RoutedEndpoint["protocol"] | null {
  if (pathname === `${prefix}/chat/completions`) return "chat";
  if (pathname === `${prefix}/responses`) return "responses";
  if (pathname === `${prefix}/messages`) return "messages";
  if (pathname === `${prefix}/models`) return "models";
  return null;
}

function protocolForRoute(route: string): RoutedEndpoint["protocol"] {
  if (route === "chat/completions") return "chat";
  if (route === "responses") return "responses";
  if (route === "messages") return "messages";
  if (route === "models") return "models";
  throw new Error(`Unsupported routed endpoint: ${route}`);
}
