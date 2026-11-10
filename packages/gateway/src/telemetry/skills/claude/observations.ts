import { isRecord } from "@mupt-ai/dari-router/policy-engine";

import type {
  InteractionMessage,
  InteractionRequest,
  InteractionToolCall,
  InteractionToolResult,
} from "../../../interaction/types.js";
import type {
  SkillEvidenceSource,
  SkillObservation,
} from "../observations.js";
import {
  claudeAvailableSkillNames,
  claudeSkillCapabilityId,
  normalizedClaudeSkillName,
} from "./catalog.js";

const MAX_SKILL_PATH_CHARS = 16 * 1024;
const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const BUDGET_REMINDER_PREFIX = "\n\n<system-reminder>\nUSD budget: ";
const BUDGET_REMINDER_SUFFIX = "\n</system-reminder>";

export function claudeSkillObservations(
  request: InteractionRequest,
  limit: number,
): SkillObservation[] {
  return request.requestPurpose === "tool_continuation"
    ? confirmedSkillObservations(request, limit)
    : request.requestPurpose === undefined
      ? directSkillObservations(request, limit)
      : [];
}

function directSkillObservations(
  request: InteractionRequest,
  limit: number,
): SkillObservation[] {
  const message = latestUserMessage(request);
  if (message === undefined) return [];
  const availableSkills = claudeAvailableSkillNames(request);
  return directSkillNames(message, availableSkills)
    .slice(0, limit)
    .map((name) => observation(name, null, "skill_command_expansion"));
}

function confirmedSkillObservations(
  request: InteractionRequest,
  limit: number,
): SkillObservation[] {
  const confirmedGroups: SkillObservation[][] = [];
  let confirmedCount = 0;
  const skillCallsByResultIndex = callsByResultIndex(request);
  const availableSkills = claudeAvailableSkillNames(request);
  let index = request.items.length - 1;
  while (index >= 0) {
    while (index >= 0 && isBudgetStatusMessage(request.items[index])) index -= 1;
    if (index < 0) break;
    const expansionEvidence = skillExpansionEvidence(request.items[index]);
    let resultStart = expansionEvidence === undefined ? index + 1 : index;
    while (resultStart > 0) {
      const item = request.items[resultStart - 1];
      if (item.type !== "tool_result") break;
      resultStart -= 1;
    }
    const resultEnd = expansionEvidence === undefined ? index + 1 : index;
    if (resultStart === resultEnd) break;

    const remaining = limit - confirmedCount;
    const group: SkillObservation[] = [];
    let inlineCount = 0;
    let forkedCount = 0;
    for (let resultIndex = resultStart; resultIndex < resultEnd; resultIndex += 1) {
      const item = request.items[resultIndex];
      if (item.type !== "tool_result") break;
      const call = skillCallsByResultIndex.get(resultIndex);
      const output = toolResultText(item);
      if (call === undefined || item.isError === true || output === undefined) continue;
      if (isInlineSkillResult(output, call.name)) {
        if (expansionEvidence !== undefined) {
          const evidence = expansionEvidence[inlineCount];
          if (evidence?.name !== undefined && evidence.name !== call.name) {
            return orderedGroups(confirmedGroups);
          }
          const redundantDirectInvocation = evidence?.name !== undefined
            && latestUserBeforeCallIncludesDirectSkill(
              request,
              call.callIndex,
              call.name,
              availableSkills,
            );
          if (!redundantDirectInvocation && group.length < remaining) {
            group.push(observation(
              call.name,
              item.callId,
              "skill_tool_activation",
            ));
          }
        }
        inlineCount += 1;
        continue;
      }
      if (isForkedSkillResult(output, call.name)) {
        forkedCount += 1;
        if (group.length < remaining) {
          group.push(observation(
            call.name,
            item.callId,
            "skill_tool_activation",
          ));
        }
      }
    }
    if (expansionEvidence === undefined) {
      if (forkedCount === 0) break;
    } else if (inlineCount !== expansionEvidence.length) {
      break;
    }

    confirmedGroups.push(group);
    confirmedCount += group.length;
    if (confirmedCount === limit) break;
    index = resultStart - 1;
  }
  return orderedGroups(confirmedGroups);
}

function isBudgetStatusMessage(
  item: InteractionRequest["items"][number],
): boolean {
  if (
    item.type !== "message"
    || (item.role !== "system" && item.role !== "developer")
    || item.content.length !== 1
    || item.content[0].type !== "text"
  ) {
    return false;
  }
  const lines = item.content[0].text.split("\n\n");
  return lines.length > 0 && lines.every((line) => {
    if (!line.startsWith("USD budget: ")) return false;
    const value = line.slice("USD budget: ".length);
    return value.length > 0 && value.length <= 256 && !/[\n<>]/u.test(value);
  });
}

function orderedGroups(groups: SkillObservation[][]): SkillObservation[] {
  groups.reverse();
  return groups.flat();
}

function skillCallName(item: InteractionToolCall): string | undefined {
  const input = item.input;
  if (
    item.kind !== "function"
    || item.namespace !== undefined
    || item.name !== "Skill"
    || !isRecord(input)
  ) {
    return undefined;
  }

  const inputKeys = Object.keys(input);
  if (
    inputKeys.some((key) => key !== "skill" && key !== "args")
    || (input.args !== undefined && typeof input.args !== "string")
  ) {
    return undefined;
  }
  return normalizedClaudeSkillName(input.skill);
}

function callsByResultIndex(
  request: InteractionRequest,
): Map<number, { name: string; callIndex: number }> {
  const latestCalls = new Map<string, { name: string; callIndex: number } | null>();
  const resultCalls = new Map<number, { name: string; callIndex: number }>();
  for (let index = 0; index < request.items.length; index += 1) {
    const item = request.items[index];
    if (item.type === "tool_call") {
      const name = skillCallName(item);
      latestCalls.set(item.callId, name === undefined ? null : { name, callIndex: index });
      continue;
    }
    if (item.type !== "tool_result") continue;
    const call = latestCalls.get(item.callId);
    if (call !== undefined && call !== null) resultCalls.set(index, call);
  }
  return resultCalls;
}

function skillExpansionEvidence(
  item: InteractionRequest["items"][number],
): Array<{ name?: string }> | undefined {
  if (item.type !== "message" || item.role !== "user" || item.content.length === 0) {
    return undefined;
  }
  const evidence: Array<{ name?: string }> = [];
  for (const part of item.content) {
    if (part.type !== "text") return undefined;
    if (isSkillExpansion(part.text)) {
      evidence.push({});
      continue;
    }
    const name = alreadyLoadedSkillName(part.text);
    if (name === undefined) return undefined;
    evidence.push({ name });
  }
  return evidence;
}

function isForkedSkillResult(output: string, name: string): boolean {
  const normalized = withoutBudgetReminders(output);
  if (normalized === undefined) return false;
  const launched = `Skill "${name}" launched (forked execution, running in the background).`;
  if (
    normalized === launched
    || normalized === `${launched}\n\nRunning in the background as @${name}`
  ) {
    return true;
  }
  const completed = `Skill "${name}" completed (forked execution).\n\nResult:\n`;
  return normalized.startsWith(completed)
    && normalized.slice(completed.length).trim().length > 0;
}

function isInlineSkillResult(output: string, name: string): boolean {
  return withoutBudgetReminders(output) === `Launching skill: ${name}`;
}

function withoutBudgetReminders(output: string): string | undefined {
  const firstReminder = output.indexOf(BUDGET_REMINDER_PREFIX);
  if (firstReminder < 0) return output;
  let cursor = firstReminder;
  while (cursor < output.length) {
    if (!output.startsWith(BUDGET_REMINDER_PREFIX, cursor)) return undefined;
    const valueStart = cursor + BUDGET_REMINDER_PREFIX.length;
    const valueEnd = output.indexOf(BUDGET_REMINDER_SUFFIX, valueStart);
    if (valueEnd < 0) return undefined;
    const value = output.slice(valueStart, valueEnd);
    if (value.length === 0 || value.length > 256 || /[\n<>]/u.test(value)) {
      return undefined;
    }
    cursor = valueEnd + BUDGET_REMINDER_SUFFIX.length;
  }
  return output.slice(0, firstReminder);
}

function latestUserBeforeCallIncludesDirectSkill(
  request: InteractionRequest,
  callIndex: number,
  name: string,
  availableSkills: Set<string>,
): boolean {
  for (let index = callIndex - 1; index >= 0; index -= 1) {
    const item = request.items[index];
    if (item.type !== "message" || item.role !== "user") continue;
    return directSkillNames(item, availableSkills).includes(name);
  }
  return false;
}

function alreadyLoadedSkillName(text: string): string | undefined {
  const prefix = "Skill /";
  const marker = " is already loaded above; instructions unchanged.";
  if (!text.startsWith(prefix)) return undefined;
  const markerIndex = text.indexOf(marker, prefix.length);
  if (markerIndex < 0) return undefined;
  const suffix = text.slice(markerIndex + marker.length);
  if (suffix !== "" && !suffix.startsWith(" Arguments:")) return undefined;
  return normalizedClaudeSkillName(text.slice(prefix.length, markerIndex));
}

function directSkillNames(
  message: InteractionMessage,
  availableSkills: Set<string>,
): string[] {
  const names: string[] = [];
  for (let index = 0; index < message.content.length; index += 1) {
    const command = message.content[index];
    const expansion = message.content[index + 1];
    if (command.type === "text" && expansion?.type === "text") {
      const name = commandName(command.text);
      if (
        name !== undefined
        && (
          isSkillExpansion(expansion.text)
          || (availableSkills.has(name) && isLegacyCommandBody(expansion.text))
        )
      ) {
        names.push(name);
        index += 1;
        continue;
      }
    }

    const backgroundName = directBackgroundSkillName(message, index);
    if (backgroundName !== undefined) names.push(backgroundName);
  }
  return names;
}

function isLegacyCommandBody(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0
    && !trimmed.startsWith("<system-reminder>")
    && !trimmed.startsWith("<local-command-")
    && !trimmed.startsWith("<command-");
}

function directBackgroundSkillName(
  message: InteractionMessage,
  index: number,
): string | undefined {
  const current = message.content[index];
  const previous = message.content[index - 1];
  if (current?.type !== "text" || previous?.type !== "text") return undefined;

  const lines = current.text.trimEnd().split("\n");
  if (lines.length !== 2) return undefined;
  const stdoutPrefix = "<local-command-stdout>Running in the background as @";
  const stdoutSuffix = "</local-command-stdout>";
  if (!lines[0]?.startsWith(stdoutPrefix) || !lines[0].endsWith(stdoutSuffix)) {
    return undefined;
  }
  const stdoutName = normalizedClaudeSkillName(
    lines[0].slice(stdoutPrefix.length, -stdoutSuffix.length),
  );

  const launchPrefix = "<forked-skill-launch>";
  const launchSuffix = "</forked-skill-launch>";
  const launchLine = lines[1];
  if (!launchLine?.startsWith(launchPrefix) || !launchLine.endsWith(launchSuffix)) {
    return undefined;
  }

  let launch: unknown;
  try {
    launch = JSON.parse(launchLine.slice(launchPrefix.length, -launchSuffix.length));
  } catch {
    return undefined;
  }
  if (!isRecord(launch) || Object.keys(launch).some(
    (key) => key !== "agentId" && key !== "skillName" && key !== "description",
  )) {
    return undefined;
  }
  const name = normalizedClaudeSkillName(launch.skillName);
  if (
    name === undefined
    || stdoutName !== name
    || typeof launch.agentId !== "string"
    || !/^[a-f0-9]{16,64}$/u.test(launch.agentId)
    || typeof launch.description !== "string"
    || (launch.description !== `/${name}` && !launch.description.startsWith(`/${name} `))
  ) {
    return undefined;
  }

  const command = previous.text.trimEnd();
  return command === `/${name}` || command.startsWith(`/${name} `)
    ? name
    : undefined;
}

function toolResultText(result: InteractionToolResult): string | undefined {
  if (typeof result.output === "string") return result.output;
  if (
    Array.isArray(result.output)
    && result.output.length === 1
    && result.output[0].type === "text"
  ) {
    return result.output[0].text;
  }
  return undefined;
}

function latestUserMessage(
  request: InteractionRequest,
): InteractionMessage | undefined {
  for (let index = request.items.length - 1; index >= 0; index -= 1) {
    const item = request.items[index];
    if (item.type === "message" && (item.role === "system" || item.role === "developer")) {
      continue;
    }
    return item.type === "message" && item.role === "user" ? item : undefined;
  }
  return undefined;
}

function commandName(text: string): string | undefined {
  const firstBreak = text.indexOf("\n");
  const secondBreak = firstBreak < 0 ? -1 : text.indexOf("\n", firstBreak + 1);
  if (firstBreak < 0 || secondBreak < 0) return undefined;

  const firstLine = text.slice(0, firstBreak);
  const secondLine = text.slice(firstBreak + 1, secondBreak);
  const rest = text.slice(secondBreak + 1);
  const name = exactTagValue(firstLine, "command-message");
  const hasExactArguments = rest.startsWith("<command-args>")
    && (rest.endsWith("</command-args>") || rest.endsWith("</command-args>\n"));
  if (
    name === undefined
    || secondLine !== `<command-name>/${name}</command-name>`
    || (rest !== "" && !hasExactArguments)
  ) {
    return undefined;
  }
  return normalizedClaudeSkillName(name);
}

function isSkillExpansion(text: string): boolean {
  const prefix = "Base directory for this skill: ";
  if (!text.startsWith(prefix)) return false;
  const pathEnd = text.indexOf("\n", prefix.length);
  if (pathEnd < 0 || !text.slice(pathEnd).startsWith("\n\n")) return false;
  const path = normalizedSkillPath(text.slice(prefix.length, pathEnd));
  return path !== undefined && text.slice(pathEnd + 2).trim().length > 0;
}

function exactTagValue(line: string, tag: string): string | undefined {
  const prefix = `<${tag}>`;
  const suffix = `</${tag}>`;
  return line.startsWith(prefix) && line.endsWith(suffix)
    ? line.slice(prefix.length, -suffix.length)
    : undefined;
}

function observation(
  name: string,
  toolCallId: string | null,
  evidenceSource: SkillEvidenceSource,
): SkillObservation {
  return {
    eventType: "skill_use",
    toolCallId,
    capabilityId: claudeSkillCapabilityId(name),
    observedName: name,
    evidenceSource,
  };
}

function normalizedSkillPath(value: string): string | undefined {
  const normalized = value.normalize("NFC");
  return normalized.length > 0
    && normalized.length <= MAX_SKILL_PATH_CHARS
    && !UNSAFE_DISPLAY_CHARACTERS.test(normalized)
    ? normalized
    : undefined;
}
