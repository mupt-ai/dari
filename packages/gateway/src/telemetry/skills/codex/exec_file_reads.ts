import type { InteractionOutput } from "../../../interaction/types.js";
import { interactionToolInput } from "../../tools/input.js";
import { readPathsFromShellCommand } from "../shell_file_reads.js";
import type { CatalogSkill, CodexSkillCatalog } from "./catalog.js";

const MAX_COMMAND_CHARS = 64 * 1024;
const MAX_SKILL_PATH_CHARS = 16 * 1024;
const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_COMMAND_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

export type CodexExecCommand = {
  callId: string;
  command: string;
  workdir?: string;
};

export function codexExecCommand(
  item: InteractionOutput["items"][number],
): CodexExecCommand | undefined {
  if (
    item.type !== "tool_call"
    || item.kind !== "function"
    || item.namespace !== undefined
    || item.name !== "exec_command"
  ) return undefined;
  const input = interactionToolInput(item);
  if (input === undefined) return undefined;
  const command = input.cmd;
  const workdir = input.workdir;
  if (
    typeof command !== "string"
    || command.length === 0
    || command.length > MAX_COMMAND_CHARS
    || UNSAFE_COMMAND_CHARACTERS.test(command)
    || (workdir !== undefined && (
      typeof workdir !== "string"
      || workdir.length === 0
      || workdir.length > MAX_SKILL_PATH_CHARS
      || UNSAFE_DISPLAY_CHARACTERS.test(workdir)
    ))
  ) return undefined;
  return workdir === undefined
    ? { callId: item.callId, command }
    : { callId: item.callId, command, workdir };
}

export function readSkillsFromCodexCommand(
  input: CodexExecCommand,
  catalog: CodexSkillCatalog,
): CatalogSkill[] {
  return readPathsFromShellCommand(input, catalog.platform).flatMap((path) => {
    const skill = catalog.byPath.get(path.key);
    return skill === undefined ? [] : [skill];
  });
}
