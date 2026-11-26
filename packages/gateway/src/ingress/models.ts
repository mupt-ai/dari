/* Shared GET /models discovery route. One URL serves two client protocols:
   Codex reads the Codex catalog; Anthropic-SDK clients (Claude Desktop /
   Cowork gateway probes, Claude Code) read the Anthropic list shape. The
   handler detects the caller, authenticates in that protocol's auth shape,
   and selects the matching catalog adapter. `?detail=1` instead returns the
   model catalog (models/catalog.ts), optionally narrowed with
   `provider=<id>[,<id>...]`. */

import { anthropicToken, bearerToken } from "../http/auth.js";
import { errorResponse, HttpError } from "../http/errors.js";
import { LINK_GRANT_ERROR_CODES } from "../link/errors.js";
import { captureRequestError } from "../observability/errors.js";
import { anthropicErrorResponse } from "./anthropic_messages.js";
import { listModelCatalog } from "../models/catalog.js";
import { modelSupportsImageInput, modelSupportsNativeCompaction } from "../providers/model_capabilities.js";
import { modelMetadataLookup } from "../providers/pi.js";
import { resolveRouter } from "../strategies/routing.js";
import { anthropicModelsResponse } from "./anthropic_models.js";
import { namedClientHarness } from "./client_harness.js";
import { codexModelsEtag, codexModelsResponse } from "./codex_models.js";
import { CANONICAL_ROUTER_MODEL, explicitModelSlug, LINK_CHILD_TOKEN_PREFIX } from "../protocol/input/router_model.js";
import { GATEWAY_ID_HEADER } from "../platform/routing_contract.js";

export async function handleModels(request: Request, routerId: string): Promise<Response> {
  // Anthropic SDK clients always send anthropic-version, and API-key probes
  // authenticate via x-api-key instead of a bearer Authorization header.
  // Codex sends neither.
  const anthropicClient =
    request.headers.has("anthropic-version") ||
    (!request.headers.get("authorization") && request.headers.has("x-api-key"));
  try {
    const apiKey = anthropicClient ? anthropicToken(request.headers) : bearerToken(request.headers);
    // Resolution authenticates the key and confirms the router exists even
    // when the response body (Anthropic shape) does not depend on it.
    // A model list is for the agent the Dari CLI names: it changes only what
    // is listed, and each request is still recognized by its own headers.
    const query = new URL(request.url).searchParams;
    // Codex itself reads this URL as its provider's `model_catalog_url`, and
    // refreshes from it while it runs. It cannot send the CLI's header; it
    // names its own version in the query, as only Codex does.
    const codexDirect = !anthropicClient && query.has("client_version");
    const clientHarness = namedClientHarness(request.headers) ?? (codexDirect ? "codex" : undefined);
    const gatewayId = request.headers.get(GATEWAY_ID_HEADER)?.trim();
    let router;
    try {
      router = await resolveRouter({
        routerId,
        apiKey,
        ...(clientHarness ? { clientHarness } : {}),
        ...(gatewayId ? { gatewayId } : {}),
      });
    } catch (error) {
      // A Dari Link grant that can serve this client nothing now lists no
      // models; a child token still lists its one model.
      if (error instanceof HttpError && isLinkGrantErrorCode(error.code)) {
        return linkModelsResponse(await childTokenModels(routerId, apiKey), false);
      }
      throw error;
    }
    if (query.get("detail") === "1") {
      const providers = query.get("provider")?.split(",").map((id) => id.trim()).filter(Boolean);
      const data = await listModelCatalog({
        ...(providers?.length ? { providers } : {}),
        signal: request.signal,
      });
      return Response.json({ object: "list", data }, { headers: { "Cache-Control": "no-store" } });
    }
    if (anthropicClient) {
      return Response.json(anthropicModelsResponse(), {
        headers: {
          "Cache-Control": "no-store",
        },
      });
    }
    // Apps on a Dari Link grant read the OpenAI list of the models it serves.
    if (router.link_grant_id) {
      // A child token serves only its models and never routes.
      const routes = router.enabled_models.length > 0 && !router.link_pins;
      return linkModelsResponse(router.link_models ?? router.enabled_models, routes);
    }
    const metadataLookup = modelMetadataLookup(router.model_configs);
    const imageInputFor = (model: string) => modelSupportsImageInput(metadataLookup(model));
    const nativeCompactionFor = (model: string) => modelSupportsNativeCompaction(metadataLookup(model));
    return Response.json(codexModelsResponse(router, imageInputFor, nativeCompactionFor, codexDirect), {
      headers: {
        "Cache-Control": "no-store",
        "X-Models-Etag": codexModelsEtag(router),
      },
    });
  } catch (error) {
    // Each protocol's clients parse their own error envelope: Anthropic's
    // {type:"error",error:{type,message}} vs the OpenAI {error:{...}} shape.
    const response = anthropicClient ? anthropicErrorResponse(error) : errorResponse(error);
    captureRequestError(error, {
      request,
      routerId,
      sourceProtocol: anthropicClient ? "anthropic_models" : "openai_models",
      status: response.status,
    });
    return response;
  }
}

// A child token's one model, when it serves only Claude Code or Muse Code.
async function childTokenModels(routerId: string, apiKey: string): Promise<string[]> {
  if (!apiKey.startsWith(LINK_CHILD_TOKEN_PREFIX)) return [];
  for (const clientHarness of ["claude_code", "muse_code"] as const) {
    try {
      const router = await resolveRouter({ routerId, apiKey, clientHarness, provisional: true });
      return router.link_models ?? router.enabled_models;
    } catch (error) {
      if (!(error instanceof HttpError && isLinkGrantErrorCode(error.code))) throw error;
    }
  }
  return [];
}

function isLinkGrantErrorCode(code: string): boolean {
  return (LINK_GRANT_ERROR_CODES as readonly string[]).includes(code);
}

// The OpenAI model list: `dari/routing` when the router's own models are
// served, and each model the grant serves by its explicit id.
function linkModelsResponse(models: readonly string[], routes: boolean): Response {
  const ids = [...(routes ? [CANONICAL_ROUTER_MODEL] : []), ...models.map(explicitModelSlug)];
  return Response.json(
    { object: "list", data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "dari" })) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
