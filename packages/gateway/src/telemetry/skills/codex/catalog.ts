import type { InteractionRequest } from "../../../interaction/types.js";
import { normalizedCodexSkillName } from "./identity.js";
import {
  joinedSkillPath,
  normalizedAbsoluteSkillPath,
  skillPathBasename,
  type NormalizedSkillPath,
  type PathPlatform,
} from "../paths.js";

const MAX_CATALOG_ENTRIES = 2_000;
const SKILLS_OPEN = "<skills_instructions>";
const SKILLS_CLOSE = "</skills_instructions>";
const SKILL_ROOTS = "### Skill roots\n";
const SKILLS_LIST = "### Available skills\n";
const FILE_LOCATOR = " (file: ";
const SKILL_ROOT = /^- `(?<alias>r[0-9]+)` = `(?<path>[^`\n]+)`$/u;

export type CatalogSkill = {
  name: string;
  path: NormalizedSkillPath;
};

export type CodexSkillCatalog = {
  platform: PathPlatform;
  byPath: ReadonlyMap<string, CatalogSkill>;
};

export function codexFileSkillCatalog(
  request: InteractionRequest,
): CodexSkillCatalog | undefined {
  const instructionTexts = request.items.flatMap((item) => {
    if (
      item.type !== "message"
      || (item.role !== "developer" && item.role !== "system")
    ) return [];
    return item.content.flatMap((part) => part.type === "text" ? [part.text] : []);
  });
  if (request.instructions !== undefined) instructionTexts.push(request.instructions);

  let latestCatalog: CodexSkillCatalog | undefined;
  for (const instructionText of instructionTexts) {
    const blocks = skillInstructionBlocks(normalizedLineEndings(instructionText));
    if (blocks === undefined) {
      latestCatalog = undefined;
      continue;
    }
    for (const block of blocks) {
      const listStart = block.indexOf(SKILLS_LIST);
      const roots = listStart < 0
        ? undefined
        : catalogRoots(block.slice(0, listStart));
      latestCatalog = listStart < 0 || roots === undefined
        ? undefined
        : catalogEntries(
            block.slice(listStart + SKILLS_LIST.length).split("\n"),
            roots,
          );
    }
  }
  return latestCatalog;
}

function catalogRoots(
  blockPrefix: string,
): Map<string, NormalizedSkillPath> | undefined {
  const roots = new Map<string, NormalizedSkillPath>();
  const rootsStart = blockPrefix.indexOf(SKILL_ROOTS);
  if (rootsStart < 0) return roots;
  let platform: PathPlatform | undefined;
  for (const line of blockPrefix.slice(rootsStart + SKILL_ROOTS.length).split("\n")) {
    if (line.startsWith("### ")) break;
    const match = line.match(SKILL_ROOT);
    if (match?.groups === undefined) continue;
    const path = normalizedAbsoluteSkillPath(match.groups.path);
    if (
      path === undefined
      || roots.has(match.groups.alias)
      || (platform !== undefined && path.platform !== platform)
    ) return undefined;
    platform = path.platform;
    roots.set(match.groups.alias, path);
    if (roots.size > MAX_CATALOG_ENTRIES) return undefined;
  }
  return roots;
}

function catalogEntries(
  lines: string[],
  roots: ReadonlyMap<string, NormalizedSkillPath>,
): CodexSkillCatalog | undefined {
  const catalog = new Map<string, CatalogSkill>();
  const ambiguousPaths = new Set<string>();
  let entryCount = 0;
  let platform: PathPlatform | undefined;
  for (const line of lines) {
    if (line.startsWith("### ")) break;
    const skill = catalogSkill(line, roots);
    if (skill === undefined) continue;
    entryCount += 1;
    if (
      entryCount > MAX_CATALOG_ENTRIES
      || (platform !== undefined && skill.path.platform !== platform)
    ) return undefined;
    platform = skill.path.platform;
    if (ambiguousPaths.has(skill.path.key)) continue;
    const previous = catalog.get(skill.path.key);
    if (previous !== undefined && previous.name !== skill.name) {
      catalog.delete(skill.path.key);
      ambiguousPaths.add(skill.path.key);
    } else {
      catalog.set(skill.path.key, skill);
    }
  }
  return platform === undefined || catalog.size === 0
    ? undefined
    : { platform, byPath: catalog };
}

function catalogSkill(
  line: string,
  roots: ReadonlyMap<string, NormalizedSkillPath>,
): CatalogSkill | undefined {
  if (!line.startsWith("- ") || !line.endsWith(")")) return undefined;
  const nameEnd = line.indexOf(": ", 2);
  const locatorStart = line.lastIndexOf(FILE_LOCATOR);
  if (nameEnd < 0 || locatorStart <= nameEnd) return undefined;
  const name = normalizedCodexSkillName(line.slice(2, nameEnd));
  const path = catalogPath(
    line.slice(locatorStart + FILE_LOCATOR.length, -1),
    roots,
  );
  return name === undefined
      || path === undefined
      || skillPathBasename(path).toLowerCase() !== "skill.md"
    ? undefined
    : { name, path };
}

function catalogPath(
  locator: string,
  roots: ReadonlyMap<string, NormalizedSkillPath>,
): NormalizedSkillPath | undefined {
  const absolute = normalizedAbsoluteSkillPath(locator);
  if (absolute !== undefined) return absolute;
  const separator = locator.indexOf("/");
  if (separator <= 0) return undefined;
  const root = roots.get(locator.slice(0, separator));
  return root === undefined
    ? undefined
    : joinedSkillPath(root, locator.slice(separator + 1));
}

function normalizedLineEndings(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function skillInstructionBlocks(text: string): string[] | undefined {
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(SKILLS_OPEN, cursor);
    if (start < 0) break;
    const bodyStart = start + SKILLS_OPEN.length;
    const end = text.indexOf(SKILLS_CLOSE, bodyStart);
    if (end < 0) return undefined;
    blocks.push(text.slice(bodyStart, end));
    cursor = end + SKILLS_CLOSE.length;
  }
  return blocks;
}
