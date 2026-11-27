import type { RoutingDecision } from "@mupt-ai/dari-router/policy-engine";

import type { InteractionOutput, InteractionRequest } from "../../interaction/types.js";
import {
  anthropicContent,
  anthropicMessageId,
  anthropicRouting,
  anthropicStopReason,
  anthropicUsage,
} from "./anthropic_messages_output.js";

export function anthropicMessagesResponse(args: {
  id: string;
  model: string;
  output: InteractionOutput;
  modelCost?: number | null;
  request: InteractionRequest;
  routing: RoutingDecision;
  conversationId?: string;
  private?: boolean;
}): Record<string, unknown> {
  return {
    id: anthropicMessageId(args.id),
    type: "message",
    role: "assistant",
    model: args.model,
    content: anthropicContent(args.output),
    stop_reason: anthropicStopReason(args.output),
    stop_sequence: null,
    // As on Chat Completions. Null means unpriced, never a fabricated free request.
    usage: { ...anthropicUsage(args.output), cost: args.modelCost ?? null },
    ...(args.output.safeguardResults ? { safeguard_results: args.output.safeguardResults } : {}),
    dari_routing: anthropicRouting(args.routing, args.id, args.conversationId, args.private),
  };
}
