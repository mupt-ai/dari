import { HttpError } from "../http/errors.js";
import type { InteractionTool, ProviderIdentity } from "./types.js";

export const TOOL_CALL_ID_MAX_LENGTH = 512;

export function isProtocolToolCallId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= TOOL_CALL_ID_MAX_LENGTH
  );
}

export function toolWireName(namespace: string | undefined, name: string): string {
  return namespace ? `${namespace}__${name}` : name;
}

export function toolsByWireName(tools: InteractionTool[]): Map<string, InteractionTool> {
  const indexed = new Map<string, InteractionTool>();
  for (const tool of tools) {
    if (tool.kind === "hosted" || tool.kind === "server_tool") continue;
    const wireName = tool.kind === "client_tool" ? tool.name : toolWireName(tool.namespace, tool.name);
    if (indexed.has(wireName)) {
      throw new HttpError(
        400,
        `Tool names must remain unique after namespace encoding; '${wireName}' is ambiguous.`,
        "invalid_request_error",
        "tools"
      );
    }
    indexed.set(wireName, tool);
  }
  return indexed;
}

export function providerToolCallId(
  callId: string,
  itemId: string | undefined,
  providerApi: string | null
): string {
  if (!itemId || !usesResponsesToolCallIds(providerApi)) return callId;
  return `${callId}|${itemId}`;
}

export function providerToolCallIdentity(
  id: string,
  source: ProviderIdentity
): { callId: string; itemId?: string } {
  const separator = usesResponsesToolCallIds(source.api) ? id.indexOf("|") : -1;
  const identity = separator > 0 && separator < id.length - 1
    ? { callId: id.slice(0, separator), itemId: id.slice(separator + 1) }
    : { callId: id };
  if (!isProtocolToolCallId(identity.callId)) {
    throw new HttpError(
      502,
      `Provider output tool call ID must be a non-empty string no longer than ${TOOL_CALL_ID_MAX_LENGTH} characters.`,
      "provider_output_invalid"
    );
  }
  return identity;
}

function usesResponsesToolCallIds(api: string | null): boolean {
  return api === "openai-responses" || api === "azure-openai-responses";
}
