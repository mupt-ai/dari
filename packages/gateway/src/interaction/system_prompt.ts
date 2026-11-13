import type { InteractionItem, InteractionRequest } from "./types.js";

/* Appends text to the end of the system prompt: after the client's
   instructions and its leading system or developer messages, before the
   conversation. The text is the same on every turn, so the provider's cached
   prefix stays stable. */
export function withSystemPromptSuffix(
  interaction: InteractionRequest,
  suffix: string | undefined,
): InteractionRequest {
  if (!suffix) return interaction;
  const isPreamble = (item: InteractionItem) =>
    item.type === "message" && (item.role === "system" || item.role === "developer");
  const at = interaction.items.findIndex((item) => !isPreamble(item));
  const index = at === -1 ? interaction.items.length : at;
  const message: InteractionItem = {
    type: "message",
    role: "system",
    content: [{ type: "text", text: suffix }],
    contentShape: "string",
  };
  return {
    ...interaction,
    items: [...interaction.items.slice(0, index), message, ...interaction.items.slice(index)],
  };
}
