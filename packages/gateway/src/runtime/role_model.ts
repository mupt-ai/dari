import { isBackgroundRequest, type InteractionRequest } from "../interaction/types.js";
import { EXPLICIT_MODEL_PREFIX } from "../protocol/input/router_model.js";
import type { ResolvedRouter, RouterRole } from "../types.js";

/* The agent role a request comes from: subagents include workflow agents, and
   anything else that is not background work (compaction, auxiliary requests,
   side replies) is the main agent. Background work has no role. */
export function requestRole(interaction: InteractionRequest): RouterRole | null {
  if (isBackgroundRequest(interaction)) return null;
  const requestClass = interaction.agentContext?.requestClass;
  return requestClass === "subagent" || requestClass === "workflow" ? "subagent" : "main";
}

/* A router can fix the model for an agent role. A request from a fixed role
   is served that model as if it had asked for `dari/model/<id>`, whatever
   model it did ask for. */
export function withRoleModel(
  credentials: ResolvedRouter,
  interaction: InteractionRequest,
): { interaction: InteractionRequest; role?: RouterRole } {
  const role = requestRole(interaction);
  const model = role === null ? null : credentials.role_models?.[role];
  if (!role || !model) return { interaction };
  return { interaction: { ...interaction, model: `${EXPLICIT_MODEL_PREFIX}${model}` }, role };
}

/* The router's prompt for a request's role, or undefined. */
export function rolePrompt(
  credentials: ResolvedRouter,
  interaction: InteractionRequest,
): string | undefined {
  const role = requestRole(interaction);
  const prompt = role === null ? undefined : credentials.role_prompts?.[role]?.trim();
  return prompt || undefined;
}
