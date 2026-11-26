import { explicitModelId, linkTokenModel } from "../protocol/input/router_model.js";
import { bearerToken } from "../http/auth.js";
import { errorResponse } from "../http/errors.js";
import { captureRequestError } from "../observability/errors.js";
import { openAIResponsesResponse } from "../protocol/output/openai_responses.js";
import { openAIResponsesSseStream } from "../protocol/output/openai_responses_stream.js";
import { openAIResponsesToInteraction } from "../protocol/input/openai_responses.js";
import { codexModelsEtag } from "./codex_models.js";
import { harnessRequest } from "./harness_request.js";
import { parseJsonRequest } from "./json.js";
import { handleRoutedCompletion } from "../runtime/routed_completion.js";
import type { SelectorBackend } from "../strategies/routing.js";

export async function handleResponses(
  request: Request,
  routerId: string,
  selectorBackend: SelectorBackend,
): Promise<Response> {
  try {
    const apiKey = bearerToken(request.headers);
    const rawPayload = await parseJsonRequest<Record<string, unknown>>(request);
    const interaction = openAIResponsesToInteraction({ ...rawPayload, model: linkTokenModel(apiKey, rawPayload.model) });
    // Pi's turns arrive as chat completions; the Dari extension's web search
    // tool sends an OpenAI hosted search here, marked as Pi's.
    const harness = harnessRequest(request.headers, { sourceProtocol: "openai_responses", payload: rawPayload });
    const payload = {
      ...interaction,
      ...(harness.requestPurpose === undefined ? {} : { requestPurpose: harness.requestPurpose }),
      ...(harness.agentContext === undefined ? {} : { agentContext: harness.agentContext }),
      ...(harness.museCodeClientId === undefined ? {} : { museCodeClientId: harness.museCodeClientId }),
    };
    // Codex and Muse Code apply their session effort to custom model
    // providers. That preference describes a direct model, not a heterogeneous
    // router, so let Dari select the reasoning effort for their routed turns;
    // a `dari/model/<id>` keeps the chosen effort. Parsing above still
    // validates malformed Responses reasoning controls.
    const sessionEffort = harness.conversationIdentity?.kind === "codex_thread" || harness.museCodeClientId !== undefined;
    if (sessionEffort && explicitModelId(payload.model) === null) {
      // Keep only an explicit thinking-off; a session effort must not force thinking on.
      payload.reasoning = payload.reasoning?.enabled === false ? { enabled: false } : undefined;
    }
    const clientHarness = harness.clientHarness;
    const harnessConversationIdentity = harness.conversationIdentity;
    return await handleRoutedCompletion({
      request,
      routerId,
      apiKey,
      payload,
      responseBody: openAIResponsesResponse,
      streamBody: openAIResponsesSseStream,
      errorResponse,
      selectorBackend,
      clientHarness,
      harnessConversationIdentity,
      // A running Codex re-reads its /model list when this changes.
      ...(clientHarness === "codex"
        ? { responseHeaders: (router) => ({ "X-Models-Etag": codexModelsEtag(router) }) }
        : {}),
    });
  } catch (error) {
    const response = errorResponse(error);
    captureRequestError(error, {
      request,
      routerId,
      sourceProtocol: "openai_responses",
      status: response.status,
    });
    return response;
  }
}

export function handleResponsesWebSocketFallback(): Response {
  return Response.json(
    {
      error: {
        message: "Responses WebSocket is not supported by this router endpoint; use HTTP Responses.",
        type: "unsupported_transport",
        code: "unsupported_transport",
      },
    },
    {
      status: 426,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

