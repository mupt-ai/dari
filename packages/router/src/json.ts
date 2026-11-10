// Small JSON-shape validators shared by modules that consume data across a
// serialization boundary (recorded routing states, selector inputs, policy
// completions). Errors read as `<label> <requirement>` so callers can pass
// precise field paths.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function jsonValue(value: unknown, label: string): JsonValue {
  if (value === undefined) throw new Error(`${label} is missing`);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`${label} is not JSON serializable`);
  return JSON.parse(serialized) as JsonValue;
}

export function jsonRecord(value: unknown, label: string): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, JsonValue>;
}

export function withoutKeys(
  value: Readonly<Record<string, JsonValue>>,
  keys: readonly string[],
): JsonObject {
  const omitted = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)));
}
