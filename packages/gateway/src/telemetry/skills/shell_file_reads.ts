import {
  normalizedAbsoluteSkillPath,
  resolvedSkillPath,
  type NormalizedSkillPath,
  type PathPlatform,
} from "./paths.js";
import {
  executableCommand,
  restrictedShellSegments,
  trustedExecutableName,
  type ShellOperator,
} from "./shell_words.js";

const MAX_SHELL_NESTING = 16;
const NO_VALUE_FLAGS = new Set<string>();
const BAT_VALUE_FLAGS = new Set([
  "--language",
  "--line-range",
  "--map-syntax",
  "--style",
  "--tabs",
  "--terminal-width",
  "--theme",
]);
const HEAD_TAIL_VALUE_FLAGS = new Set(["-c", "--bytes", "-n", "--lines"]);
const LESS_VALUE_FLAGS = new Set([
  "--LOG-FILE",
  "-j",
  "--jump-target",
  "--log-file",
  "-o",
  "-O",
  "-p",
  "--pattern",
  "-P",
  "--prompt",
  "--shift",
  "--tabs",
  "-x",
  "-y",
  "-z",
]);
const NL_VALUE_FLAGS = new Set([
  "--body-numbering",
  "--footer-numbering",
  "--header-numbering",
  "--join-blank-lines",
  "--number-format",
  "--number-separator",
  "--number-width",
  "--section-delimiter",
  "--starting-line-number",
  "-b",
  "-d",
  "-f",
  "-h",
  "-i",
  "-n",
  "-s",
  "-v",
  "-w",
]);
const AWK_VALUE_FLAGS = new Set(["-F", "-v"]);

export type ShellReadCommand = {
  command: string;
  workdir?: string;
};

/** Parse only direct, deterministic shell readers and return their resolved paths. */
export function readPathsFromShellCommand(
  input: ShellReadCommand,
  platform: PathPlatform,
  nesting = 0,
): NormalizedSkillPath[] {
  if (nesting > MAX_SHELL_NESTING) return [];
  const segments = restrictedShellSegments(input.command, platform);
  if (segments === undefined) return [];
  const normalizedWorkdir = normalizedAbsoluteSkillPath(input.workdir);
  let workdir = normalizedWorkdir?.platform === platform
    ? normalizedWorkdir
    : undefined;
  const observed: NormalizedSkillPath[] = [];
  let previousOperator: ShellOperator | null = null;
  let previousWasSupported = false;

  for (const segment of segments) {
    const command = executableCommand(segment.words);
    if (command === undefined) {
      previousOperator = segment.next;
      previousWasSupported = false;
      continue;
    }
    const executable = trustedExecutableName(command.executable, platform);
    if (executable === undefined) {
      previousOperator = segment.next;
      previousWasSupported = false;
      continue;
    }
    if (previousOperator === "||") return [];
    if (previousOperator === "&&" && !previousWasSupported) {
      previousOperator = segment.next;
      previousWasSupported = false;
      continue;
    }
    if (executable === "cd") {
      const nextWorkdir = cdTarget(command.args, workdir, platform);
      if (
        nextWorkdir !== undefined
        && (segment.next === "&&" || segment.next === ";" || segment.next === "\n")
      ) workdir = nextWorkdir;
      previousOperator = segment.next;
      previousWasSupported = nextWorkdir !== undefined;
      continue;
    }
    if (
      platform === "posix"
      && (executable === "bash" || executable === "zsh" || executable === "sh")
      && command.args.length >= 2
      && /^-[^-]*c[^-]*$/u.test(command.args[0])
    ) {
      observed.push(...readPathsFromShellCommand(
        {
          command: command.args[1],
          ...(workdir === undefined ? {} : { workdir: workdir.value }),
        },
        platform,
        nesting + 1,
      ));
      previousOperator = segment.next;
      previousWasSupported = false;
      continue;
    }
    const paths = readerPaths(executable, command.args, platform);
    if (paths === undefined) {
      previousOperator = segment.next;
      previousWasSupported = false;
      continue;
    }
    for (const path of paths) {
      const resolved = resolvedSkillPath(path, workdir);
      if (resolved?.platform === platform) observed.push(resolved);
    }
    previousOperator = segment.next;
    previousWasSupported = true;
  }
  return observed;
}

function readerPaths(
  executable: string,
  args: string[],
  platform: PathPlatform,
): string[] | undefined {
  switch (executable) {
    case "cat":
    case "more":
      return ordinaryFileOperands(args, NO_VALUE_FLAGS);
    case "bat":
    case "batcat":
      return ordinaryFileOperands(args, BAT_VALUE_FLAGS);
    case "head":
    case "tail":
      return ordinaryFileOperands(args, HEAD_TAIL_VALUE_FLAGS);
    case "less":
      return ordinaryFileOperands(args, LESS_VALUE_FLAGS);
    case "nl":
      return ordinaryFileOperands(args, NL_VALUE_FLAGS);
    case "sed":
      return sedFileOperands(args);
    case "awk":
      return ordinaryFileOperands(args, AWK_VALUE_FLAGS).slice(1);
    case "get-content":
    case "gc":
    case "type":
      return platform === "windows" ? powershellFileOperands(args) : [];
    default:
      return undefined;
  }
}

function ordinaryFileOperands(
  args: string[],
  valueFlags: ReadonlySet<string>,
): string[] {
  const files: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && valueFlags.has(argument)) {
      index += 1;
      continue;
    }
    if (!optionsEnded && argument.startsWith("-")) continue;
    files.push(argument);
  }
  return files;
}

function sedFileOperands(args: string[]): string[] {
  const files: string[] = [];
  let explicitProgram = false;
  let implicitProgramConsumed = false;
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && ["-e", "--expression", "-f", "--file"].includes(argument)) {
      explicitProgram = true;
      index += 1;
      continue;
    }
    if (!optionsEnded && (
      argument.startsWith("-e")
      || argument.startsWith("--expression=")
      || argument.startsWith("-f")
      || argument.startsWith("--file=")
    )) {
      explicitProgram = true;
      continue;
    }
    if (!optionsEnded && argument.startsWith("-")) continue;
    if (!explicitProgram && !implicitProgramConsumed) {
      implicitProgramConsumed = true;
      continue;
    }
    files.push(argument);
  }
  return files;
}

function powershellFileOperands(args: string[]): string[] {
  const files: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (/^-(?:Path|LiteralPath)$/iu.test(argument)) {
      const path = args[index + 1];
      if (path !== undefined) files.push(path);
      index += 1;
      continue;
    }
    if (!argument.startsWith("-")) files.push(argument);
  }
  return files;
}

function cdTarget(
  args: string[],
  workdir: NormalizedSkillPath | undefined,
  platform: PathPlatform,
): NormalizedSkillPath | undefined {
  const operands = args.filter(
    (argument) => argument !== "--" && !argument.startsWith("-"),
  );
  const target = operands.at(-1);
  const resolved = target === undefined
    ? undefined
    : resolvedSkillPath(target, workdir);
  return resolved?.platform === platform ? resolved : undefined;
}
