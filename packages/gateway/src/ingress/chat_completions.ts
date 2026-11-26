import type { ChatCompletionRequest } from "@mupt-ai/dari-router/policy-engine";
import { bearerToken } from "../http/auth.js";
import { errorResponse } from "../http/errors.js";
import { captureRequestError } from "../observability/errors.js";
import { chatCompletionResponse, chatCompletionsSseStream } from "../protocol/output/chat_completions.js";
import { chatCompletionsToInteraction } from "../protocol/input/chat_completions.js";
import { linkTokenModel } from "../protocol/input/router_model.js";
import { handleRoutedCompletion } from "../runtime/routed_completion.js";
import type { SelectorBackend } from "../strategies/routing.js";
import { harnessRequest } from "./harness_request.js";
import { parseJsonRequest } from "./json.js";

export async function handleChatCompletions(
  request: Request,
  routerId: string,
  selectorBackend: SelectorBackend,
): Promise<Response> {
  try {
    const apiKey = bearerToken(request.headers);
    const payload = await parseJsonRequest<ChatCompletionRequest>(request);
    const interaction = chatCompletionsToInteraction({
      ...payload,
      model: linkTokenModel(apiKey, payload.model),
      source_protocol: "openai_chat",
    });
    const harness = harnessRequest(request.headers, {
      sourceProtocol: "openai_chat",
      payload: payload as unknown as Record<string, unknown>,
      promptCacheKey: payload.prompt_cache_key,
    });
    return await handleRoutedCompletion({
      request,
      routerId,
      apiKey,
      payload: {
        ...interaction,
        ...(harness.agentContext === undefined ? {} : { agentContext: harness.agentContext }),
        ...(harness.museCodeClientId === undefined ? {} : { museCodeClientId: harness.museCodeClientId }),
      },
      responseBody: chatCompletionResponse,
      streamBody: chatCompletionsSseStream,
      errorResponse,
      selectorBackend,
      clientHarness: harness.clientHarness,
      harnessConversationIdentity: harness.conversationIdentity,
    });
  } catch (error) {
    const response = errorResponse(error);
    captureRequestError(error, {
      request,
      routerId,
      sourceProtocol: "openai_chat",
      status: response.status,
    });
    return response;
  }
}
