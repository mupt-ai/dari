import type {
  InteractionMessage,
  InteractionOutput,
  InteractionRequest,
} from "../../interaction/types.js";
import { interactionToolInput } from "../tools/input.js";
import type { SkillObservation } from "./observations.js";

const CAPABILITY_PREFIX = "unattributed:name:";
const MAX_CAPABILITY_ID_CHARS = 512;
const MAX_SKILL_NAME_CHARS = 64;
const MAX_SKILL_PATH_CHARS = 16 * 1024;
const PI_SKILL_CLOSE = "\n</skill>";
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const XML_ENTITY = /&(amp|lt|gt|quot|apos);/gu;
const INVALID_XML_ENTITY = /&(?!(?:amp|lt|gt|quot|apos);)/u;
const PI_SKILL_BLOCK = /(?:^|\n)  <skill>\n([\s\S]*?)\n  <\/skill>(?=\n|$)/gu;
const PI_SKILL_FIELDS = /^    <name>([^\n]*)<\/name>\n    <description>[\s\S]*<\/description>\n    <location>([^\n]*)<\/location>$/u;

/** Parse the exact expansion emitted by Pi for `/skill:name [arguments]`. */
export function piStyleExplicitSkillObservations(
  request: InteractionRequest,
  limit: number,
): SkillObservation[] {
  if (limit <= 0) return [];
  return trailingUserMessages(request)
    .flatMap((message) => {
      const textParts = message.content.filter((part) => part.type === "text");
      if (
        textParts.length !== 1
        || message.content.some(
          (part) => part.type !== "text" && part.type !== "image",
        )
      ) return [];
      const name = piStyleSkillName(textParts[0].text);
      return name === undefined
        ? []
        : [observation(name, "skill_use", "skill_command_expansion", null)];
    })
    .slice(0, limit);
}

/** Match a current model-emitted Pi `read` call to its exact skill catalog entry. */
export function piStyleAutomaticSkillObservations(
  request: InteractionRequest,
  output: InteractionOutput,
  limit: number,
): SkillObservation[] {
  if (
    limit <= 0
    || request.sourceProtocol !== "openai_chat"
    || !request.tools.some(
      (tool) =>
        tool.kind === "function"
        && tool.name === "read"
        && tool.namespace === undefined,
    )
  ) {
    return [];
  }

  const skillsByLocation = piStyleAvailableSkills(request);
  if (skillsByLocation.size === 0) return [];

  const observedCapabilities = new Set<string>();
  const observed: SkillObservation[] = [];
  for (const item of output.items) {
    const read = piSkillRead(item);
    if (read === undefined) continue;
    const name = skillsByLocation.get(read.path);
    if (name === undefined) continue;
    const skill = observation(name, "skill_load", "skill_file_read", read.toolCallId);
    if (observedCapabilities.has(skill.capabilityId)) continue;
    observedCapabilities.add(skill.capabilityId);
    observed.push(skill);
    if (observed.length === limit) break;
  }
  return observed;
}

function observation(
  name: string,
  eventType: SkillObservation["eventType"],
  evidenceSource: SkillObservation["evidenceSource"],
  toolCallId: string | null,
): SkillObservation {
  return {
    eventType,
    toolCallId,
    capabilityId: `${CAPABILITY_PREFIX}${name}`,
    observedName: name,
    evidenceSource,
  };
}

function piStyleAvailableSkills(
  request: InteractionRequest,
): Map<string, string> {
  const skills = new Map<string, string>();
  const ambiguousLocations = new Set<string>();
  for (const item of request.items) {
    if (
      item.type !== "message"
      || (item.role !== "system" && item.role !== "developer")
    ) {
      continue;
    }
    for (const part of item.content) {
      if (part.type !== "text") continue;
      for (const section of part.text.matchAll(
        /(?:^|\n)<available_skills>\n([\s\S]*?)\n<\/available_skills>(?=\n|$)/gu,
      )) {
        const body = section[1];
        if (body === undefined) continue;
        for (const block of body.matchAll(PI_SKILL_BLOCK)) {
          const fields = block[1]?.match(PI_SKILL_FIELDS);
          if (fields === null || fields === undefined) continue;
          const nameValue = decodePiXmlText(fields[1]);
          const location = normalizedSkillPath(decodePiXmlText(fields[2]));
          const name = nameValue === undefined
            ? undefined
            : normalizedSkillName(nameValue);
          if (
            name === undefined
            || location === undefined
            || ambiguousLocations.has(location)
          ) {
            continue;
          }
          const previous = skills.get(location);
          if (previous !== undefined && previous !== name) {
            skills.delete(location);
            ambiguousLocations.add(location);
          } else {
            skills.set(location, name);
          }
        }
      }
    }
  }
  return skills;
}

function piSkillRead(
  item: InteractionOutput["items"][number],
): { path: string; toolCallId: string } | undefined {
  if (
    item.type !== "tool_call"
    || item.kind !== "function"
    || item.namespace !== undefined
    || item.name !== "read"
  ) {
    return undefined;
  }
  const input = interactionToolInput(item);
  const path = input === undefined ? undefined : normalizedSkillPath(input.path);
  return path === undefined ? undefined : { path, toolCallId: item.callId };
}

function decodePiXmlText(value: string | undefined): string | undefined {
  if (value === undefined || INVALID_XML_ENTITY.test(value)) return undefined;
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  return value.replace(XML_ENTITY, (_entity, name: string) => entities[name] ?? "");
}

function normalizedSkillPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > 0
    && value.length <= MAX_SKILL_PATH_CHARS
    && !UNSAFE_DISPLAY_CHARACTERS.test(value)
    ? value
    : undefined;
}

function trailingUserMessages(
  request: InteractionRequest,
): InteractionMessage[] {
  let index = request.items.length - 1;
  while (index >= 0) {
    const item = request.items[index];
    if (
      item.type === "message"
      && (item.role === "system" || item.role === "developer")
    ) {
      index -= 1;
      continue;
    }
    break;
  }

  const messages: InteractionMessage[] = [];
  while (index >= 0) {
    const item = request.items[index];
    if (item.type !== "message" || item.role !== "user") break;
    messages.push(item);
    index -= 1;
  }
  return messages.reverse();
}

function piStyleSkillName(text: string): string | undefined {
  const namePrefix = '<skill name="';
  if (!text.startsWith(namePrefix)) return undefined;

  const nameEnd = text.indexOf('" location="', namePrefix.length);
  if (nameEnd < 0) return undefined;
  const locationStart = nameEnd + '" location="'.length;
  const locationEnd = text.indexOf('">\n', locationStart);
  if (locationEnd < 0) return undefined;

  const bodyStart = locationEnd + '">\n'.length;
  const bodyEnd = piStyleSkillBodyEnd(text, bodyStart);
  if (bodyEnd < 0) return undefined;

  const name = normalizedSkillName(text.slice(namePrefix.length, nameEnd));
  const location = text.slice(locationStart, locationEnd);
  const body = text.slice(bodyStart, bodyEnd);
  const referencesPrefix = "References are relative to ";
  const referencesEnd = body.indexOf(".\n\n", referencesPrefix.length);
  if (
    name === undefined
    || location.length === 0
    || location.length > MAX_SKILL_PATH_CHARS
    || UNSAFE_DISPLAY_CHARACTERS.test(location)
    || !body.startsWith(referencesPrefix)
    || referencesEnd < 0
    || body.slice(referencesEnd + ".\n\n".length).trim() === ""
  ) {
    return undefined;
  }
  return name;
}

function piStyleSkillBodyEnd(
  text: string,
  bodyStart: number,
): number {
  let lastNonWhitespace = text.length - 1;
  while (lastNonWhitespace >= 0 && /\s/u.test(text[lastNonWhitespace])) {
    lastNonWhitespace -= 1;
  }

  let candidate = text.indexOf(PI_SKILL_CLOSE, bodyStart);
  while (candidate >= 0) {
    const suffixStart = candidate + PI_SKILL_CLOSE.length;
    if (
      suffixStart === text.length
      || (
        text.startsWith("\n\n", suffixStart)
        && suffixStart + 2 <= lastNonWhitespace
      )
    ) {
      return candidate;
    }
    candidate = text.indexOf(PI_SKILL_CLOSE, suffixStart);
  }
  return -1;
}

function normalizedSkillName(value: string): string | undefined {
  const normalized = value.normalize("NFC").trim();
  return normalized.length > 0
    && normalized.length <= MAX_SKILL_NAME_CHARS
    && normalized.length <= MAX_CAPABILITY_ID_CHARS - CAPABILITY_PREFIX.length
    && SKILL_NAME.test(normalized)
    && !UNSAFE_DISPLAY_CHARACTERS.test(normalized)
    ? normalized
    : undefined;
}
