import type {
  InteractionOutput,
  InteractionRequest,
} from "../../../interaction/types.js";
import { interactionToolInput } from "../../tools/input.js";
import {
  claudeSkillCapabilityId,
  claudeSystemSkillNames,
} from "./catalog.js";
import {
  normalizedAbsoluteSkillPath,
  skillPathSegments,
  type NormalizedSkillPath,
} from "../paths.js";
import type { SkillObservation } from "../observations.js";
import { readPathsFromShellCommand } from "../shell_file_reads.js";

const MAX_COMMAND_CHARS = 64 * 1024;
const SKILL_FILE_NAME = "SKILL.md";
const SKILLS_DIRECTORY_NAME = "skills";
const PRIMARY_WORKING_DIRECTORY_PREFIX = " - Primary working directory: ";
const UNSAFE_COMMAND_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/** Match model-emitted Claude Code `Read` calls to its trusted skill catalog. */
export function claudeFileReadObservations(
  request: InteractionRequest,
  output: InteractionOutput,
  limit: number,
): SkillObservation[] {
  if (
    limit <= 0
    || request.sourceProtocol !== "anthropic_messages"
  ) return [];

  const declaredTools = new Set(request.tools.flatMap((tool) =>
    tool.kind === "function" && tool.namespace === undefined
      ? [tool.name]
      : []
  ));
  if (!declaredTools.has("Read") && !declaredTools.has("Bash")) return [];

  const availableSkills = claudeSystemSkillNames(request);
  if (availableSkills.size === 0) return [];
  const workingDirectory = declaredTools.has("Bash")
    ? claudePrimaryWorkingDirectory(request)
    : undefined;

  const observedCapabilities = new Set<string>();
  const observations: SkillObservation[] = [];
  for (const item of output.items) {
    for (const read of claudeReadCalls(item, declaredTools, workingDirectory)) {
      const name = skillNameForReadPath(read.path, availableSkills);
      if (name === undefined) continue;
      const capabilityId = claudeSkillCapabilityId(name);
      if (observedCapabilities.has(capabilityId)) continue;
      observedCapabilities.add(capabilityId);
      observations.push({
        eventType: "skill_load",
        toolCallId: read.callId,
        capabilityId,
        observedName: name,
        evidenceSource: "skill_file_read",
      });
      if (observations.length === limit) return observations;
    }
  }
  return observations;
}

function claudeReadCalls(
  item: InteractionOutput["items"][number],
  declaredTools: ReadonlySet<string>,
  workingDirectory: NormalizedSkillPath | undefined,
): { callId: string; path: NormalizedSkillPath }[] {
  if (
    item.type !== "tool_call"
    || item.kind !== "function"
    || item.namespace !== undefined
    || !declaredTools.has(item.name)
  ) return [];
  const input = interactionToolInput(item);
  if (item.name === "Read") {
    const path = normalizedAbsoluteSkillPath(input?.file_path);
    return path === undefined ? [] : [{ callId: item.callId, path }];
  }
  if (item.name !== "Bash" || workingDirectory === undefined) return [];
  const command = input?.command;
  if (
    typeof command !== "string"
    || command.length === 0
    || command.length > MAX_COMMAND_CHARS
    || UNSAFE_COMMAND_CHARACTERS.test(command)
  ) return [];
  return readPathsFromShellCommand(
    {
      command,
      workdir: workingDirectory.value,
    },
    workingDirectory.platform,
  ).map((path) => ({ callId: item.callId, path }));
}

function claudePrimaryWorkingDirectory(
  request: InteractionRequest,
): NormalizedSkillPath | undefined {
  if (request.instructions === undefined) return undefined;
  const matches = request.instructions.split("\n").flatMap((line) =>
    line.startsWith(PRIMARY_WORKING_DIRECTORY_PREFIX)
      ? [line.slice(PRIMARY_WORKING_DIRECTORY_PREFIX.length)]
      : []
  );
  if (matches.length !== 1) return undefined;
  return normalizedAbsoluteSkillPath(matches[0]);
}

function skillNameForReadPath(
  path: NormalizedSkillPath,
  availableSkills: ReadonlySet<string>,
): string | undefined {
  const segments = skillPathSegments(path);
  const fileName = segments.at(-1);
  const directoryName = segments.at(-2);
  if (
    fileName === undefined
    || directoryName === undefined
    || normalizedPathPart(fileName, path) !== normalizedPathPart(SKILL_FILE_NAME, path)
    || !segments.slice(0, -2).some(
      (segment) =>
        normalizedPathPart(segment, path)
        === normalizedPathPart(SKILLS_DIRECTORY_NAME, path),
    )
  ) return undefined;

  let match: string | undefined;
  for (const name of availableSkills) {
    const separator = name.lastIndexOf(":");
    const pathName = separator < 0 ? name : name.slice(separator + 1);
    if (normalizedPathPart(pathName, path) !== normalizedPathPart(directoryName, path)) {
      continue;
    }
    if (match !== undefined) return undefined;
    match = name;
  }
  return match;
}

function normalizedPathPart(
  value: string,
  path: NormalizedSkillPath,
): string {
  const normalized = value.normalize("NFC");
  return path.platform === "windows" ? normalized.toLowerCase() : normalized;
}
