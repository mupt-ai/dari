import { isBackgroundRequest, type InteractionOutput, type InteractionRequest } from "../../interaction/types.js";
import type { HarnessConversationIdentity } from "../../runtime/harness_identity/index.js";
import {
  piStyleAutomaticSkillObservations,
  piStyleExplicitSkillObservations,
} from "./pi.js";
import { claudeFileReadObservations } from "./claude/file_reads.js";
import { claudeSkillObservations } from "./claude/observations.js";
import { codexExplicitSkillObservations } from "./codex/explicit.js";
import { codexAutomaticSkillObservations } from "./codex/file_reads.js";

export type SkillEvidenceSource =
  | "skill_content_injection"
  | "skill_command_expansion"
  | "skill_tool_activation"
  | "skill_file_read";

export type SkillObservation = {
  eventType: "skill_use" | "skill_load";
  toolCallId: string | null;
  capabilityId: string;
  observedName: string;
  evidenceSource: SkillEvidenceSource;
};

export function inputSkillObservations(args: {
  request: InteractionRequest;
  harnessConversationIdentity?: HarnessConversationIdentity;
  limit: number;
}): SkillObservation[] {
  if (args.limit <= 0 || isBackgroundRequest(args.request)) return [];
  if (
    args.request.requestPurpose === undefined
    && args.request.sourceProtocol === "openai_chat"
  ) {
    return piStyleExplicitSkillObservations(args.request, args.limit);
  }
  if (
    args.request.requestPurpose === undefined
    && args.request.sourceProtocol === "openai_responses"
    && args.harnessConversationIdentity?.kind === "codex_thread"
    && args.harnessConversationIdentity.userTurnId !== undefined
  ) {
    return codexExplicitSkillObservations(
      args.request,
      args.harnessConversationIdentity.userTurnId,
      args.limit,
    );
  }
  if (
    args.request.sourceProtocol === "anthropic_messages"
    && args.harnessConversationIdentity?.kind === "claude_code_session"
  ) {
    return claudeSkillObservations(args.request, args.limit);
  }
  return [];
}

export function outputSkillObservations(args: {
  request: InteractionRequest;
  output: InteractionOutput;
  harnessConversationIdentity?: HarnessConversationIdentity;
  limit: number;
}): SkillObservation[] {
  if (args.limit <= 0 || isBackgroundRequest(args.request)) return [];
  if (args.request.sourceProtocol === "openai_chat") {
    return piStyleAutomaticSkillObservations(
      args.request,
      args.output,
      args.limit,
    );
  }
  if (
    args.request.sourceProtocol === "openai_responses"
    && args.harnessConversationIdentity?.kind === "codex_thread"
  ) {
    return codexAutomaticSkillObservations(
      args.request,
      args.output,
      args.limit,
    );
  }
  if (
    args.request.sourceProtocol === "anthropic_messages"
    && args.harnessConversationIdentity?.kind === "claude_code_session"
  ) {
    return claudeFileReadObservations(
      args.request,
      args.output,
      args.limit,
    );
  }
  return [];
}
