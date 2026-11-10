import { posix, win32 } from "node:path";

const MAX_SKILL_PATH_CHARS = 16 * 1024;
const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

export type PathPlatform = "posix" | "windows";

export type NormalizedSkillPath = {
  platform: PathPlatform;
  value: string;
  key: string;
};

export function normalizedAbsoluteSkillPath(
  value: unknown,
): NormalizedSkillPath | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_SKILL_PATH_CHARS
    || UNSAFE_DISPLAY_CHARACTERS.test(value)
    || hasParentPathSegment(value)
  ) return undefined;
  if (posix.isAbsolute(value)) {
    const normalized = posix.normalize(value);
    return { platform: "posix", value: normalized, key: `posix:${normalized}` };
  }
  if (win32.isAbsolute(value)) {
    const normalized = win32.normalize(value);
    return {
      platform: "windows",
      value: normalized,
      key: `windows:${normalized.toLowerCase()}`,
    };
  }
  return undefined;
}

export function resolvedSkillPath(
  value: string,
  workdir: NormalizedSkillPath | undefined,
): NormalizedSkillPath | undefined {
  if (hasParentPathSegment(value) || /^[A-Za-z]:[^\\/]/u.test(value)) {
    return undefined;
  }
  const absolute = normalizedAbsoluteSkillPath(value);
  if (absolute !== undefined) return absolute;
  if (workdir === undefined) return undefined;
  const resolved = workdir.platform === "windows"
    ? win32.resolve(workdir.value, value)
    : posix.resolve(workdir.value, value);
  const normalized = normalizedAbsoluteSkillPath(resolved);
  return normalized?.platform === workdir.platform ? normalized : undefined;
}

export function joinedSkillPath(
  root: NormalizedSkillPath,
  suffix: string,
): NormalizedSkillPath | undefined {
  if (hasParentPathSegment(suffix)) return undefined;
  const joined = root.platform === "windows"
    ? win32.join(root.value, ...suffix.split("/"))
    : posix.join(root.value, suffix);
  const normalized = normalizedAbsoluteSkillPath(joined);
  return normalized?.platform === root.platform ? normalized : undefined;
}

export function skillPathBasename(path: NormalizedSkillPath): string {
  return path.platform === "windows"
    ? win32.basename(path.value)
    : posix.basename(path.value);
}

export function skillPathSegments(path: NormalizedSkillPath): string[] {
  const implementation = path.platform === "windows" ? win32 : posix;
  const root = implementation.parse(path.value).root;
  return path.value.slice(root.length).split(implementation.sep).filter(Boolean);
}

function hasParentPathSegment(value: string): boolean {
  return value.split(/[\\/]/u).includes("..");
}
