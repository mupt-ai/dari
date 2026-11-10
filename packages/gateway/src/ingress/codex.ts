import { explicitModelId } from "../protocol/input/router_model.js";
import { bearerToken } from "../http/auth.js";
import { errorResponse } from "../http/errors.js";
import { captureRequestError } from "../observability/errors.js";
import { openAIResponsesResponse } from "../protocol/output/openai_responses.js";
import { openAIResponsesSseStream } from "../protocol/output/openai_responses_stream.js";
import { openAIResponsesToInteraction } from "../protocol/input/openai_responses.js";
import { parseJsonRequest } from "./json.js";
import { museCodeClientId } from "./muse_code.js";
import { handleRoutedCompletion } from "../runtime/routed_completion.js";
import type { SelectorBackend } from "../strategies/routing.js";
import {
  codexConversationIdentity,
  codexRequestPurpose,
  codexRequestContext,
  museCodeConversationIdentity,
} from "../runtime/harness_identity/index.js";

export async function handleResponses(
  request: Request,
  routerId: string,
  selectorBackend: SelectorBackend,
): Promise<Response> {
  try {
    const apiKey = bearerToken(request.headers);
    const rawPayload = await parseJsonRequest<Record<string, unknown>>(request);
    const interaction = openAIResponsesToInteraction(rawPayload);
    const requestPurpose = codexRequestPurpose(request.headers, rawPayload);
    const agentContext = codexRequestContext(request.headers, rawPayload);
    const museClientId = museCodeClientId(request.headers);
    const payload = {
      ...interaction,
      ...(requestPurpose === undefined ? {} : { requestPurpose }),
      ...(agentContext === undefined ? {} : { agentContext }),
      ...(museClientId === undefined ? {} : { museCodeClientId: museClientId }),
    };
    const codexIdentity = codexConversationIdentity(request.headers, rawPayload);
    // Codex and Muse Code apply their session effort to custom model
    // providers. That preference describes a direct model, not a heterogeneous
    // router, so let Dari select the reasoning effort for their routed turns;
    // a `dari/model/<id>` keeps the chosen effort. Parsing above still
    // validates malformed Responses reasoning controls.
    const harness = codexIdentity !== undefined || museClientId !== undefined;
    if (harness && explicitModelId(payload.model) === null) {
      // Keep only an explicit thinking-off; a session effort must not force thinking on.
      payload.reasoning = payload.reasoning?.enabled === false ? { enabled: false } : undefined;
    }
    const harnessConversationIdentity = codexIdentity
      ?? (museClientId === undefined ? undefined : museCodeConversationIdentity(request.headers));
    return await handleRoutedCompletion({
      request,
      routerId,
      apiKey,
      payload,
      responseBody: openAIResponsesResponse,
      streamBody: openAIResponsesSseStream,
      errorResponse,
      selectorBackend,
      clientHarness: museClientId === undefined ? undefined : "muse_code",
      harnessConversationIdentity,
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

