import type {
  InteractionMessage,
  InteractionRequest,
} from "../../../interaction/types.js";
import type { SkillObservation } from "../observations.js";
import {
  codexSkillCapabilityId,
  normalizedCodexSkillName,
} from "./identity.js";

const MAX_SKILL_PATH_CHARS = 16 * 1024;
const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const SKILL_MENTION = /\$([A-Za-z0-9][A-Za-z0-9_:-]*)/gu;

export function codexExplicitSkillObservations(
  request: InteractionRequest,
  currentTurnId: string,
  limit: number,
): SkillObservation[] {
  let currentUserStart = request.items.length;
  while (currentUserStart > 0) {
    const item = request.items[currentUserStart - 1];
    if (item.type !== "message" || item.role !== "user") break;
    currentUserStart -= 1;
  }
  const parsed: Array<{
    message: InteractionMessage;
    skill?: { name: string; path: string };
  }> = [];
  for (let index = currentUserStart; index < request.items.length; index += 1) {
    const message = request.items[index];
    if (message.type !== "message" || message.role !== "user") continue;
    parsed.push({ message, skill: parseCodexSkillMessage(message) });
  }

  const mentionedNames = new Set<string>();
  const observed: SkillObservation[] = [];
  const observedInjections = new Set<string>();
  for (const { message, skill } of parsed) {
    if (skill !== undefined) {
      const injection = skillInjectionKey(skill);
      if (
        (
          message.clientTurnId?.toLowerCase() === currentTurnId.toLowerCase()
          || (
            message.clientTurnId === undefined
            && mentionedNames.has(skill.name)
          )
        )
        && !observedInjections.has(injection)
      ) {
        observedInjections.add(injection);
        observed.push(observation(skill.name));
        if (observed.length === limit) break;
      }
      continue;
    }
    for (const match of textParts(message).join("").matchAll(SKILL_MENTION)) {
      if (match[1] !== undefined) mentionedNames.add(match[1]);
    }
  }
  return observed;
}

function observation(name: string): SkillObservation {
  return {
    eventType: "skill_use",
    toolCallId: null,
    capabilityId: codexSkillCapabilityId(name),
    observedName: name,
    evidenceSource: "skill_content_injection",
  };
}

function parseCodexSkillMessage(
  message: InteractionMessage,
): { name: string; path: string } | undefined {
  if (message.content.length !== 1 || message.content[0].type !== "text") {
    return undefined;
  }
  const text = message.content[0].text;
  const prefix = "<skill>\n<name>";
  if (!text.startsWith(prefix) || !text.endsWith("\n</skill>")) return undefined;

  const nameEnd = text.indexOf("</name>\n<path>", prefix.length);
  if (nameEnd < 0) return undefined;
  const pathStart = nameEnd + "</name>\n<path>".length;
  const pathEnd = text.indexOf("</path>\n", pathStart);
  if (pathEnd < 0) return undefined;
  const bodyStart = pathEnd + "</path>\n".length;
  const bodyEnd = text.length - "\n</skill>".length;
  if (bodyEnd <= bodyStart || text.slice(bodyStart, bodyEnd).trim().length === 0) {
    return undefined;
  }

  const name = normalizedCodexSkillName(text.slice(prefix.length, nameEnd));
  const path = normalizedSkillPath(text.slice(pathStart, pathEnd));
  return name === undefined || path === undefined ? undefined : { name, path };
}

function skillInjectionKey(skill: { name: string; path: string }): string {
  return `${skill.name}\u0000${skill.path}`;
}

function normalizedSkillPath(value: string): string | undefined {
  const normalized = value.normalize("NFC");
  return normalized.length > 0
    && normalized.length <= MAX_SKILL_PATH_CHARS
    && !UNSAFE_DISPLAY_CHARACTERS.test(normalized)
    ? normalized
    : undefined;
}

function textParts(message: InteractionMessage): string[] {
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []);
}
