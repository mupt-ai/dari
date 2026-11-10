/* Shared GET /models discovery route. One URL serves two client protocols:
   Codex reads the Codex catalog; Anthropic-SDK clients (Claude Desktop /
   Cowork gateway probes, Claude Code) read the Anthropic list shape. The
   handler detects the caller, authenticates in that protocol's auth shape,
   and selects the matching catalog adapter. `?detail=1` instead returns the
   model catalog (models/catalog.ts), optionally narrowed with
   `provider=<id>[,<id>...]`. */

import { anthropicToken, bearerToken } from "../http/auth.js";
import { errorResponse } from "../http/errors.js";
import { captureRequestError } from "../observability/errors.js";
import { anthropicErrorResponse } from "./anthropic_messages.js";
import { listModelCatalog } from "../models/catalog.js";
import { modelSupportsImageInput } from "../providers/model_capabilities.js";
import { modelMetadataLookup } from "../providers/pi.js";
import { resolveRouter } from "../strategies/routing.js";
import { anthropicModelsResponse } from "./anthropic_models.js";
import { codexModelsResponse } from "./codex_models.js";

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
    const router = await resolveRouter({ routerId, apiKey });
    const query = new URL(request.url).searchParams;
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
    const metadataLookup = modelMetadataLookup(router.model_configs);
    const imageInputFor = (model: string) => modelSupportsImageInput(metadataLookup(model));
    return Response.json(codexModelsResponse(router, imageInputFor), {
      headers: {
        "Cache-Control": "no-store",
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
