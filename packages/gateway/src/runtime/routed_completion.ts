import { randomUUID } from "node:crypto";

import { isBackgroundRequest, type InteractionRequest } from "../interaction/types.js";
import { PRIVATE_HEADER } from "../platform/routing_contract.js";
import { explicitModelId } from "../protocol/input/router_model.js";
import { captureRequestError } from "../observability/errors.js";
import type { SelectorBackend } from "../strategies/routing.js";
import type { ClientHarness, ResolvedRouter } from "../types.js";
import { assertAutoroutingAllowed, assertCreditAvailableBeforeRouting, routerSelectsModels } from "../telemetry/usage.js";
import type { HarnessConversationIdentity } from "./harness_identity/index.js";
import { CustomerDisconnectedError } from "./customer_disconnect.js";
import { clientHeaders } from "../ingress/client_harness.js";
import { withModelMenuHint } from "./model_menu_hint.js";
import { prepareRoutedCompletion } from "./prepare_routed_completion.js";
import type { RoutedProtocol } from "./routed_protocol.js";
import { runPreparedRoutedCompletion } from "./routed_runtime.js";

export async function handleRoutedCompletion(args: {
  request: Request;
  routerId: string;
  apiKey: string;
  payload: InteractionRequest;
  responseBody: RoutedProtocol["responseBody"];
  streamBody: RoutedProtocol["streamBody"];
  errorResponse: (error: unknown) => Response;
  selectorBackend: SelectorBackend;
  clientHarness?: ClientHarness;
  harnessConversationIdentity?: HarnessConversationIdentity;
  // Headers the client reads from a successful response, from its router.
  responseHeaders?: (router: ResolvedRouter) => Record<string, string>;
}): Promise<Response> {
  const requestId = randomUUID();
  const clientRequestId = normalizedClientRequestId(args.request.headers.get("x-request-id"));
  const receivedAt = new Date();
  const startedMs = Date.now();
  const prepared = await prepareRoutedCompletion({
    routerId: args.routerId,
    apiKey: args.apiKey,
    interaction: args.payload,
    protocol: { responseBody: args.responseBody, streamBody: args.streamBody },
    receivedAt,
    startedMs,
    requestId,
    clientRequestId,
    tagsHeader: args.request.headers.get("x-dari-tags"),
    privateRequest: args.request.headers.get(PRIVATE_HEADER) === "true",
    clientHarness: args.clientHarness,
    clientHeaders: clientHeaders(args.request.headers),
    harnessConversationIdentity: args.harnessConversationIdentity,
  }).catch((error: unknown) => ({ error }));
  if ("error" in prepared) {
    const response = args.errorResponse(withModelMenuHint(prepared.error, args.clientHarness));
    captureRequestError(prepared.error, {
      request: args.request,
      routerId: args.routerId,
      requestId,
      sourceProtocol: args.payload.sourceProtocol,
      status: response.status,
    });
    return responseWithRequestId(response, requestId);
  }

  try {
    // Only auto-selection needs the plan: an explicitly requested model and
    // background work are served without the selector.
    const selects =
      prepared.credentials.strict !== true &&
      explicitModelId(prepared.interaction.model) === null &&
      !isBackgroundRequest(prepared.interaction) &&
      routerSelectsModels(prepared.credentials);
    assertAutoroutingAllowed(prepared.credentials, selects);
    assertCreditAvailableBeforeRouting(prepared.billable, prepared.credentials);
    const response = await runPreparedRoutedCompletion({
      prepared,
      selectorBackend: args.selectorBackend,
      clientSignal: args.request.signal,
    });
    for (const [name, value] of Object.entries(args.responseHeaders?.(prepared.credentials) ?? {})) {
      response.headers.set(name, value);
    }
    // Its X-Request-Id is the request the client is told it made.
    return response;
  } catch (error) {
    const terminal = prepared.reporter.freezeFailure(error);
    terminal.report();
    let response = args.errorResponse(withModelMenuHint(error, args.clientHarness));
    // Provider retries may already have consumed tokens before the HTTP error.
    // Return the same model-only cost as successful OpenAI-compatible responses.
    if (args.payload.sourceProtocol === "openai_chat") {
      const body = await response.json();
      response = Response.json({ ...body, usage: { cost: prepared.reporter.modelCost() } },
        { status: response.status, headers: response.headers });
    }
    captureRequestError(error, {
      request: args.request,
      routerId: prepared.routerId,
      requestId,
      sourceProtocol: args.payload.sourceProtocol,
      status: response.status,
    });
    return responseWithRequestId(response, requestId);
  }
}

function normalizedClientRequestId(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 200) : null;
}

function responseWithRequestId(response: Response, requestId: string): Response {
  response.headers.set("X-Request-Id", requestId);
  return response;
}
