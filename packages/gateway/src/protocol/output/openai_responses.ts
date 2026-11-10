import {
  openAIResponsesOutputItems,
  openAIResponsesResponseId,
  openAIResponsesRouting,
  openAIResponsesTerminal,
  openAIResponsesUsage,
} from "./openai_responses_output.js";
import type { InteractionOutput, InteractionRequest } from "../../interaction/types.js";

export function openAIResponsesResponse(args: {
  id: string;
  model: string;
  output: InteractionOutput;
  request: InteractionRequest;
  routing: RoutingDecision;
  conversationId?: string;
}): Record<string, unknown> {
  return {
    id: openAIResponsesResponseId(args.id),
    object: "response",
    created_at: Math.floor(args.output.createdAtMs / 1000),
    ...openAIResponsesTerminal(args.output),
    model: args.model,
    output: openAIResponsesOutputItems(args.output),
    usage: openAIResponsesUsage(args.output),
    parallel_tool_calls: args.request.parallelToolCalls ?? true,
    dari_routing: openAIResponsesRouting(args.routing, args.id, args.conversationId),
  };
}
import type { RoutingDecision } from "@mupt-ai/dari-router/policy-engine";
