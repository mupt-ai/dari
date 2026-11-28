import type {
  AgentRequestContext,
  InteractionRequestPurpose,
  SourceProtocol,
} from "../interaction/types.js";
import {
  claudeCodeConversationIdentity,
  claudeCodeRequestContext,
  isClaudeCodeRequest,
} from "../harnesses/claude_code.js";
import { codexConversationIdentity, codexRequestContext, codexRequestPurpose } from "../harnesses/codex.js";
import { museCodeClientId, museCodeConversationIdentity } from "../harnesses/muse_code.js";
import { openCodeRequestContext } from "../harnesses/opencode.js";
import { piRequestContext } from "../harnesses/pi.js";
import {
  chatCompletionsConversationIdentity,
  type HarnessConversationIdentity,
} from "../runtime/harness_identity/index.js";
import type { ClientHarness } from "../types.js";
import { claimedClientHarness } from "./client_harness.js";

/** The coding agent a request comes from, and what the agent says of it. */
export type HarnessRequest = {
  clientHarness?: ClientHarness;
  // What the request is for: the main agent's turn, a subagent's, compaction.
  agentContext?: AgentRequestContext;
  // The agent's own session, and the subagent within it.
  conversationIdentity?: HarnessConversationIdentity;
  requestPurpose?: InteractionRequestPurpose;
  museCodeClientId?: string;
};

/**
 * Read the coding agent from its own headers.
 *
 * An agent speaks one API, but its headers reach two more: a gateway
 * connected to hosted Dari has hosted Dari serve a model over that model's
 * API (Anthropic's for Claude, Responses for the rest), with the agent's
 * headers passed on (`CLIENT_HEADERS`). So Claude Code's headers arrive on
 * the Responses API when it runs a GPT model, and OpenCode's on Anthropic's
 * when it runs Claude, and each must still be the same agent, request class,
 * and session. Chat completions only ever carries the agents that speak it.
 */
export function harnessRequest(headers: Headers, body: {
  sourceProtocol: SourceProtocol;
  payload: Record<string, unknown>;
  promptCacheKey?: string;
}): HarnessRequest {
  const chat = body.sourceProtocol === "openai_chat";
  if (!chat && isClaudeCodeRequest(headers)) {
    return {
      clientHarness: "claude_code",
      agentContext: claudeCodeRequestContext(headers),
      conversationIdentity: claudeCodeConversationIdentity(
        headers,
        // Only Claude Code's own request body names its session.
        body.sourceProtocol === "anthropic_messages" ? body.promptCacheKey : undefined,
      ),
    };
  }
  const museClientId = museCodeClientId(headers);
  // Codex describes every request in its turn metadata.
  const codexContext = chat ? undefined : codexRequestContext(headers, body.payload);
  const piContext = codexContext === undefined ? piRequestContext(headers) : undefined;
  const openCodeContext = openCodeRequestContext(headers);
  const agentContext = codexContext ?? piContext ?? openCodeContext;
  const requestPurpose = chat ? undefined : codexRequestPurpose(headers, body.payload);
  // Any chat completions caller may name its session; on the other APIs only
  // Pi and OpenCode, whose own headers do.
  const session = chat || piContext !== undefined || openCodeContext !== undefined
    ? chatCompletionsConversationIdentity(headers, chat ? body.promptCacheKey : undefined)
    : undefined;
  const conversationIdentity = chat ? session
    : codexConversationIdentity(headers, body.payload)
      ?? (museClientId === undefined ? undefined : museCodeConversationIdentity(headers))
      ?? session;
  // OpenClaw and Hermes send nothing of their own that tells them apart, so
  // the Dari CLI sets them up to name themselves.
  const clientHarness: ClientHarness | undefined = museClientId !== undefined ? "muse_code"
    : codexContext !== undefined ? "codex"
    : piContext !== undefined ? "pi"
    : openCodeContext !== undefined ? "opencode"
    : claimedClientHarness(headers);
  return {
    ...(clientHarness === undefined ? {} : { clientHarness }),
    ...(agentContext === undefined ? {} : { agentContext }),
    ...(conversationIdentity === undefined ? {} : { conversationIdentity }),
    ...(requestPurpose === undefined ? {} : { requestPurpose }),
    ...(museClientId === undefined ? {} : { museCodeClientId: museClientId }),
  };
}
