import { HttpError } from "../../http/errors.js";

const MAX_ID_CHARS = 200;

export function boundedIdentity(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(
      400,
      `${field} must be a string.`,
      "invalid_request_error",
      field,
    );
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > MAX_ID_CHARS) {
    throw new HttpError(
      400,
      `${field} must not exceed ${MAX_ID_CHARS} characters.`,
      "invalid_request_error",
      field,
    );
  }
  return normalized;
}

export function uuidIdentity(value: unknown, field: string): string | undefined {
  const normalized = boundedIdentity(value, field);
  if (normalized === undefined) return undefined;
  const canonical = normalized.toLowerCase();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(canonical)) {
    throw new HttpError(
      400,
      `${field} must be a UUID.`,
      "invalid_request_error",
      field,
    );
  }
  return canonical;
}
