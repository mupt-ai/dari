import { isRecord } from "@mupt-ai/dari-router/policy-engine";
import { anthropicMessagesResponse } from "../protocol/output/anthropic_messages.js";
import { anthropicMessagesSseStream } from "../protocol/output/anthropic_messages_stream.js";
import { anthropicToken } from "../http/auth.js";
import { errorResponseHeaders, normalizeError } from "../http/errors.js";
import { captureRequestError } from "../observability/errors.js";
import { anthropicMessagesToInteraction } from "../protocol/input/anthropic_messages.js";
import { explicitModelId } from "../protocol/input/router_model.js";
import { handleRoutedCompletion } from "../runtime/routed_completion.js";
import type { SelectorBackend } from "../strategies/routing.js";
import { claudeCodeRequestContext } from "./claude_code/request_context.js";
import {
  claudeCodeConversationIdentity,
} from "../runtime/harness_identity/index.js";
import { parseJsonRequest } from "./json.js";
import type { AnthropicSafeguards, ReasoningControls } from "../interaction/types.js";

type AnthropicErrorType =
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "api_error"
  | "invalid_request_error";

const LEGACY_CLAUDE_CODE_BETA = "claude-code-20250219";
const SAFEGUARDS_BETA_PREFIX = "dangerous-tool-use-";

export async function handleAnthropicMessages(
  request: Request,
  routerId: string,
  selectorBackend: SelectorBackend,
): Promise<Response> {
  try {
    const apiKey = anthropicToken(request.headers);
    const rawPayload = await parseJsonRequest<Record<string, unknown>>(request);
    const interaction = anthropicMessagesToInteraction(rawPayload);
    const isClaudeCode = isClaudeCodeRequest(request.headers);
    const anthropicSafeguards = safeguardsFrom(rawPayload, request.headers);
    const forwarded = anthropicSafeguards === undefined
      ? interaction
      : { ...interaction, anthropicSafeguards };
    const payload = isClaudeCode
      ? {
          ...forwarded,
          reasoning: routedReasoning(forwarded),
          agentContext: claudeCodeRequestContext(request.headers),
          // Native tool results may be followed by harness-injected text.
          // Preserve their structural continuation semantics, not prompt inference.
          ...(latestMessageHasToolResult(rawPayload.messages)
            ? { requestPurpose: "tool_continuation" as const } : {}),
          claudeCodeUserAgent: request.headers.get("user-agent")!.trim(),
        }
      : forwarded;
    return await handleRoutedCompletion({
      request,
      routerId,
      apiKey,
      payload,
      responseBody: anthropicMessagesResponse,
      streamBody: anthropicMessagesSseStream,
      errorResponse: anthropicErrorResponse,
      selectorBackend,
      clientHarness: isClaudeCode ? "claude_code" : undefined,
      harnessConversationIdentity: isClaudeCode
        ? claudeCodeConversationIdentity(
            request.headers,
            payload.promptCacheKey,
          )
        : undefined,
    });
  } catch (error) {
    const response = anthropicErrorResponse(error);
    captureRequestError(error, {
      request,
      routerId,
      sourceProtocol: "anthropic_messages",
      status: response.status,
    });
    return response;
  }
}

// Claude Code sends its session effort on every turn. That preference
// describes a direct model, not a heterogeneous router, so let Dari select the
// effort when the router routes; a `dari/model/<id>` keeps the chosen effort.
function routedReasoning(
  interaction: ReturnType<typeof anthropicMessagesToInteraction>,
): ReasoningControls | undefined {
  const reasoning = interaction.reasoning;
  if (reasoning === undefined || explicitModelId(interaction.model) !== null) return reasoning;
  // Keep only an explicit "thinking off"; effort alone must not force thinking on.
  return reasoning.enabled === false ? { enabled: false } : undefined;
}

function latestMessageHasToolResult(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  const message = messages.at(-1);
  return isRecord(message) && message.role === "user" && Array.isArray(message.content)
    && message.content.some((block) => isRecord(block) && block.type === "tool_result");
}

// A safeguards body field only works with its paired beta, so forward the two
// together or not at all.
function safeguardsFrom(
  payload: Record<string, unknown>,
  headers: Headers,
): AnthropicSafeguards | undefined {
  if (!Array.isArray(payload.safeguards) || payload.safeguards.length === 0) {
    return undefined;
  }
  const betas = [...anthropicBetas(headers)].filter((beta) =>
    beta.startsWith(SAFEGUARDS_BETA_PREFIX)
  );
  return betas.length === 0 ? undefined : { safeguards: payload.safeguards, betas };
}

function anthropicBetas(headers: Headers): Set<string> {
  return new Set(
    (headers.get("anthropic-beta") ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isClaudeCodeRequest(headers: Headers): boolean {
  const userAgent = headers.get("user-agent")?.trim().toLowerCase() ?? "";
  const app = headers.get("x-app")?.trim().toLowerCase();
  const betas = anthropicBetas(headers);
  return (
    userAgent.startsWith("claude-cli/") &&
    (app === "cli" || app === "cli-bg") &&
    (
      Boolean(headers.get("x-claude-code-session-id")?.trim()) ||
      betas.has(LEGACY_CLAUDE_CODE_BETA)
    )
  );
}

// Dari-specific codes clients act on; every other code stays internal.
const CLIENT_VISIBLE_ERROR_CODES = new Set([
  "personal_subscription_unavailable",
  "subscription_switched",
  "subscription_usage_limit",
]);

export function anthropicErrorResponse(error: unknown): Response {
  const { status, message, code } = normalizeError(error);
  return Response.json(
    {
      type: "error",
      error: {
        type: anthropicErrorType(status),
        message,
        ...(CLIENT_VISIBLE_ERROR_CODES.has(code) ? { code } : {}),
      },
    },
    { status, headers: errorResponseHeaders(error) },
  );
}

function anthropicErrorType(status: number): AnthropicErrorType {
  switch (status) {
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 429:
      return "rate_limit_error";
    default:
      return status >= 500 ? "api_error" : "invalid_request_error";
  }
}
