import type {
  InteractionContent,
  InteractionItem,
  InteractionOutput,
  InteractionRequest,
  ProviderIdentity,
} from "../../../interaction/types.js";
import type { HarnessConversationIdentity } from "../../../runtime/harness_identity/index.js";
import { toolSkillEvents } from "../../tools/observations.js";

export const ANTHROPIC: ProviderIdentity = {
  provider: "anthropic",
  api: "anthropic-messages",
  model: "claude-sonnet-4-6",
};

export const CLAUDE: HarnessConversationIdentity = {
  kind: "claude_code_session",
  value: "11111111-2222-4333-8444-555555555555",
};

export function events(args: {
  request: InteractionRequest;
  output: InteractionOutput;
  identity?: HarnessConversationIdentity;
  zdr?: boolean;
}) {
  return toolSkillEvents({
    routerId: "rtr_1",
    request: args.request,
    output: args.output,
    harnessConversationIdentity: args.identity,
    zdr: args.zdr ?? false,
  });
}

export function request(
  sourceProtocol: InteractionRequest["sourceProtocol"],
  items: InteractionItem[],
): InteractionRequest {
  return {
    sourceProtocol,
    items,
    tools: [],
    generation: {},
    stream: true,
  };
}

export function output(
  source: ProviderIdentity,
  items: InteractionOutput["items"] = [
    message("assistant", [{ type: "text", text: "done" }]),
  ],
): InteractionOutput {
  return {
    source,
    items,
    createdAtMs: 1,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  };
}

export function message(
  role: "system" | "developer" | "user" | "assistant",
  content: InteractionContent[],
  clientTurnId?: string,
): Extract<InteractionItem, { type: "message" }> {
  return {
    type: "message",
    role,
    content,
    contentShape: "parts",
    ...(clientTurnId === undefined ? {} : { clientTurnId }),
  };
}

export function claudeCommand(name: string, args: string): string {
  return `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>\n`;
}

export function claudeExpansion(path: string, body: string): string {
  return `Base directory for this skill: ${path}\n\n${body}`;
}

export function availableSkills(...names: string[]): string {
  return "<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n"
    + names.map((name) => `- ${name}: Test skill`).join("\n")
    + "\n</system-reminder>";
}

export function skillEvent(
  name: string,
  capabilityId: string,
  evidenceSource:
    | "skill_content_injection"
    | "skill_command_expansion"
    | "skill_tool_activation",
  ordinal: number,
) {
  return {
    event_type: "skill_use" as const,
    tool_call_id: null,
    exchange_context_hash: null,
    capability_id: capabilityId,
    observed_name: name,
    skill_version: null,
    evidence_source: evidenceSource,
    ordinal,
  };
}
