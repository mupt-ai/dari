const CAPABILITY_PREFIX = "codex:name:";
const MAX_CAPABILITY_ID_CHARS = 512;
const MAX_SKILL_NAME_CHARS = 512;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_:-]*$/u;
const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

export function codexSkillCapabilityId(name: string): string {
  return `${CAPABILITY_PREFIX}${name}`;
}

export function normalizedCodexSkillName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFC").trim();
  return normalized.length > 0
    && normalized.length <= MAX_SKILL_NAME_CHARS
    && normalized.length <= MAX_CAPABILITY_ID_CHARS - CAPABILITY_PREFIX.length
    && SKILL_NAME.test(normalized)
    && !UNSAFE_DISPLAY_CHARACTERS.test(normalized)
    ? normalized
    : undefined;
}
