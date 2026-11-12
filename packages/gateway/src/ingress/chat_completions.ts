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
import type { ClientHarness } from "../types.js";
import { claimedClientHarness } from "./client_harness.js";
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
    const piContext = piRequestContext(request.headers);
    const openCodeContext = openCodeRequestContext(request.headers);
    const agentContext = piContext ?? openCodeContext;
    const museClientId = museCodeClientId(request.headers);
    // OpenClaw and Hermes send nothing of their own that tells them apart,
    // so the Dari CLI sets them up to name themselves.
    const clientHarness: ClientHarness | undefined = museClientId !== undefined ? "muse_code"
      : piContext !== undefined ? "pi"
      : openCodeContext !== undefined ? "opencode"
      : claimedClientHarness(request.headers);
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
      clientHarness,
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
