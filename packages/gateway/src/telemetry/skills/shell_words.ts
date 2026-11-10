import { posix, win32 } from "node:path";

import type { PathPlatform } from "./paths.js";

const MAX_COMMAND_TOKENS = 4_096;
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const POSIX_SHELL_WHITESPACE = /[\t\n\v\f\r ]/u;
const POSIX_CONTROL_COMMANDS = new Set([
  "!",
  "[[",
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "select",
  "then",
  "time",
  "until",
  "while",
  "{",
  "}",
]);
const TRUSTED_POSIX_EXECUTABLE_DIRECTORIES = new Set([
  "/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  "/usr/local/bin",
]);

export type ShellOperator = "&" | "&&" | "|" | "||" | ";" | "\n";

export type ShellSegment = {
  words: string[];
  next: ShellOperator | null;
};

export type ExecutableCommand = {
  executable: string;
  args: string[];
};

export function executableCommand(
  words: string[],
): ExecutableCommand | undefined {
  let index = 0;
  while (index < words.length && SHELL_ASSIGNMENT.test(words[index])) index += 1;
  if (words[index] === "env") {
    index += 1;
    while (
      index < words.length
      && (words[index].startsWith("-") || SHELL_ASSIGNMENT.test(words[index]))
    ) index += 1;
  }
  if (words[index] === "command" || words[index] === "builtin") {
    index += 1;
    while (index < words.length && words[index].startsWith("-")) index += 1;
  }
  const executable = words[index];
  return executable === undefined
    ? undefined
    : { executable, args: words.slice(index + 1) };
}

// This lexer recognizes only the shell structure needed to identify direct
// read commands. Unsupported substitutions and control flow fail closed.
export function restrictedShellSegments(
  command: string,
  platform: PathPlatform,
): ShellSegment[] | undefined {
  const powershell = platform === "windows";
  if ((!powershell && (command.includes("$(") || command.includes("`"))) || command.includes("\u0000")) {
    return undefined;
  }
  const segments: ShellSegment[] = [];
  let words: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | null = null;
  let tokenCount = 0;

  const flushWord = () => {
    if (!wordStarted) return;
    words.push(word);
    tokenCount += 1;
    word = "";
    wordStarted = false;
  };
  const flushSegment = (next: ShellOperator) => {
    flushWord();
    if (words.length > 0) segments.push({ words, next });
    words = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else if (powershell && character === "`") {
        index += 1;
        if (index >= command.length) return undefined;
        word += command[index];
      } else if (!powershell && character === "\\" && quote === '"') {
        const escaped = command[index + 1];
        if (escaped === undefined) return undefined;
        if (["$", "`", '"', "\\", "\n"].includes(escaped)) {
          index += 1;
          if (escaped !== "\n") word += escaped;
        } else {
          word += character;
        }
      } else {
        word += character;
      }
      wordStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      wordStarted = true;
      continue;
    }
    if ((!powershell && character === "\\") || (powershell && character === "`")) {
      index += 1;
      if (index >= command.length) return undefined;
      if (command[index] !== "\n") {
        word += command[index];
        wordStarted = true;
      }
      continue;
    }
    if (POSIX_SHELL_WHITESPACE.test(character)) {
      flushWord();
      if (character === "\n") flushSegment("\n");
      continue;
    }
    if (character === "#" && !wordStarted) {
      flushWord();
      while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
      continue;
    }
    if (character === ";" || character === "|" || character === "&") {
      const doubled = command[index + 1] === character;
      const operator = (doubled ? character + character : character) as ShellOperator;
      if ((character === "|" || character === "&") && doubled) index += 1;
      flushSegment(operator);
      continue;
    }
    if (
      character === "("
      || character === ")"
      || character === "<"
      || character === ">"
    ) return undefined;
    word += character;
    wordStarted = true;
  }
  if (quote !== null) return undefined;
  flushWord();
  if (words.length > 0) segments.push({ words, next: null });
  if (
    tokenCount > MAX_COMMAND_TOKENS
    || segments.length > MAX_COMMAND_TOKENS
    || (platform === "posix" && segments.some((segment) => {
      const parsed = executableCommand(segment.words);
      return parsed !== undefined
        && POSIX_CONTROL_COMMANDS.has(parsed.executable);
    }))
  ) return undefined;
  return segments;
}

export function trustedExecutableName(
  command: string,
  platform: PathPlatform,
): string | undefined {
  if (!command.includes("/") && !command.includes("\\")) {
    return command.toLowerCase();
  }
  if (platform === "windows") {
    if (!win32.isAbsolute(command)) return undefined;
    const normalized = win32.normalize(command);
    const directory = win32.dirname(normalized).toLowerCase();
    if (
      directory !== "c:\\windows\\system32"
      && directory !== "c:\\program files\\powershell\\7"
    ) return undefined;
    return win32.basename(normalized).replace(/\.exe$/iu, "").toLowerCase();
  }
  if (!posix.isAbsolute(command)) return undefined;
  const normalized = posix.normalize(command);
  if (!TRUSTED_POSIX_EXECUTABLE_DIRECTORIES.has(posix.dirname(normalized))) {
    return undefined;
  }
  return posix.basename(normalized).toLowerCase();
}
