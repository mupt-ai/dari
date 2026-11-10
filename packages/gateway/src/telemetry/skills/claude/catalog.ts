import type {
  InteractionMessage,
  InteractionRequest,
} from "../../../interaction/types.js";

const MAX_CAPABILITY_ID_CHARS = 512;
const MAX_SKILL_NAME_CHARS = 512;
const CAPABILITY_PREFIX = "claude:name:";
const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const SKILL_NAME = new RegExp(
  "^[A-Za-z0-9][A-Za-z0-9_.@-]*"
  + "(?::[A-Za-z0-9][A-Za-z0-9_.@-]*"
  + "|(?:/[A-Za-z0-9][A-Za-z0-9_.@-]*)+:[A-Za-z0-9][A-Za-z0-9_.@-]*)?$",
);
const AVAILABLE_SKILLS_HEADING = "The following skills are available for use with the Skill tool:";
const REMINDER_SKILLS_HEADER = `<system-reminder>\n${AVAILABLE_SKILLS_HEADING}\n`;
const BARE_SKILLS_HEADER = `${AVAILABLE_SKILLS_HEADING}\n`;
const SYSTEM_REMINDER_END = "\n</system-reminder>";

export function claudeAvailableSkillNames(
  request: InteractionRequest,
): Set<string> {
  return parsedAvailableSkillNames(request, true);
}

/** Read only harness-owned catalogs when attributing model-emitted file reads. */
export function claudeSystemSkillNames(
  request: InteractionRequest,
): Set<string> {
  return parsedAvailableSkillNames(request, false);
}

export function claudeSkillCapabilityId(name: string): string {
  return `${CAPABILITY_PREFIX}${name}`;
}

export function normalizedClaudeSkillName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const withoutLeadingSlash = value.startsWith("/") ? value.slice(1) : value;
  const normalized = withoutLeadingSlash.normalize("NFC").trim();
  return normalized.length > 0
    && normalized.length <= MAX_SKILL_NAME_CHARS
    && normalized.length <= MAX_CAPABILITY_ID_CHARS - CAPABILITY_PREFIX.length
    && SKILL_NAME.test(normalized)
    && !UNSAFE_DISPLAY_CHARACTERS.test(normalized)
    ? normalized
    : undefined;
}

function parsedAvailableSkillNames(
  request: InteractionRequest,
  includeUserMessages: boolean,
): Set<string> {
  let latestNames = new Set<string>();
  for (const item of request.items) {
    if (
      item.type !== "message"
      || (
        item.role !== "system"
        && item.role !== "developer"
        && (!includeUserMessages || item.role !== "user")
      )
    ) continue;
    for (const part of item.content) {
      if (part.type !== "text") continue;
      for (const section of availableSkillsSections(part.text, item.role)) {
        const names = new Set<string>();
        let foundSkill = false;
        for (const line of section.split("\n")) {
          if (line === "" && !foundSkill) continue;
          if (line === "") break;
          if (!line.startsWith("- ")) continue;
          const name = availableSkillName(line);
          if (name === undefined) break;
          names.add(name);
          foundSkill = true;
        }
        latestNames = names;
      }
    }
  }
  return latestNames;
}

function availableSkillsSections(
  text: string,
  role: InteractionMessage["role"],
): string[] {
  const sections: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(REMINDER_SKILLS_HEADER, cursor);
    if (start < 0) break;
    const sectionStart = start + REMINDER_SKILLS_HEADER.length;
    const sectionEnd = text.indexOf(SYSTEM_REMINDER_END, sectionStart);
    if (sectionEnd < 0) break;
    sections.push(text.slice(sectionStart, sectionEnd));
    cursor = sectionEnd + SYSTEM_REMINDER_END.length;
  }
  if (role !== "user") {
    let bareCursor = 0;
    while (bareCursor < text.length) {
      const start = text.indexOf(BARE_SKILLS_HEADER, bareCursor);
      if (start < 0) break;
      const sectionStart = start + BARE_SKILLS_HEADER.length;
      sections.push(text.slice(sectionStart));
      bareCursor = sectionStart;
    }
  }
  return sections;
}

function availableSkillName(line: string): string | undefined {
  const entry = line.slice(2);
  const description = entry.indexOf(": ");
  return normalizedClaudeSkillName(
    description < 0 ? entry : entry.slice(0, description),
  );
}
