import type { ChatCompletionRequest } from "@mupt-ai/dari-router/policy-engine";
import { bearerToken } from "../http/auth.js";
import { errorResponse } from "../http/errors.js";
import { captureRequestError } from "../observability/errors.js";
import { chatCompletionResponse, chatCompletionsSseStream } from "../protocol/output/chat_completions.js";
import { chatCompletionsToInteraction } from "../protocol/input/chat_completions.js";
import { handleRoutedCompletion } from "../runtime/routed_completion.js";
import type { SelectorBackend } from "../strategies/routing.js";
import {
  chatCompletionsConversationIdentity,
  openCodeRequestContext,
  piRequestContext,
} from "../runtime/harness_identity/index.js";
import { parseJsonRequest } from "./json.js";
import { museCodeClientId } from "./muse_code.js";

export async function handleChatCompletions(
  request: Request,
  routerId: string,
  selectorBackend: SelectorBackend,
): Promise<Response> {
  try {
    const apiKey = bearerToken(request.headers);
    const payload = await parseJsonRequest<ChatCompletionRequest>(request);
    const interaction = chatCompletionsToInteraction({ ...payload, source_protocol: "openai_chat" });
    const agentContext = piRequestContext(request.headers) ?? openCodeRequestContext(request.headers);
    const museClientId = museCodeClientId(request.headers);
    return await handleRoutedCompletion({
      request,
      routerId,
      apiKey,
      payload: {
        ...interaction,
        ...(agentContext === undefined ? {} : { agentContext }),
        ...(museClientId === undefined ? {} : { museCodeClientId: museClientId }),
      },
      responseBody: chatCompletionResponse,
      streamBody: chatCompletionsSseStream,
      errorResponse,
      selectorBackend,
      clientHarness: museClientId === undefined ? undefined : "muse_code",
      harnessConversationIdentity: chatCompletionsConversationIdentity(
        request.headers,
        payload.prompt_cache_key,
      ),
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
