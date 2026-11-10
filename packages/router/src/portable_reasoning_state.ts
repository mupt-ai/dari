import { RouterFrameworkError } from "./framework_error.js";
import type { ProviderIdentity } from "./continuation_state.js";
import { isRecord } from "./types.js";

const PREFIX = "dari-ir-v1.";
const FAMILY_PREFIX = "dari-ir-";
const MAX_JSON_BYTES = 4 * 1024;
const MAX_ENCODED_CHARS = Math.ceil(MAX_JSON_BYTES / 3) * 4;

export type PortableReasoningState = {
  source?: ProviderIdentity;
  itemId?: string;
};

export function encodePortableReasoningState(state: PortableReasoningState): string {
  const source = state.source ? providerIdentity(state.source, "configuration") : undefined;
  const itemId = state.itemId ? boundedString(state.itemId, 512, "configuration", "item ID") : undefined;
  const payload = {
    v: 1,
    ...(source ? { source } : {}),
    ...(itemId ? { id: itemId } : {}),
  };
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES) {
    throw invalidPortableState(
      "configuration",
      "Portable reasoning state exceeds the encoded size limit.",
    );
  }
  return `${PREFIX}${Buffer.from(json, "utf8").toString("base64url")}`;
}

export function decodeUntrustedPortableReasoningState(value: string): PortableReasoningState | null {
  if (!value.startsWith(FAMILY_PREFIX)) return null;
  if (!value.startsWith(PREFIX)) {
    throw invalidPortableState(
      "invalid_request",
      "Portable reasoning state version is not supported.",
    );
  }

  const encoded = value.slice(PREFIX.length);
  if (!encoded || encoded.length > MAX_ENCODED_CHARS || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw invalidPortableState(
      "invalid_request",
      "Portable reasoning state encoding is invalid.",
    );
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length > MAX_JSON_BYTES || bytes.toString("base64url") !== encoded) {
    throw invalidPortableState(
      "invalid_request",
      "Portable reasoning state encoding is invalid.",
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalidPortableState(
      "invalid_request",
      "Portable reasoning state payload is invalid.",
    );
  }
  if (!isRecord(decoded) || decoded.v !== 1) {
    throw invalidPortableState(
      "invalid_request",
      "Portable reasoning state schema is invalid.",
    );
  }
  const keys = Object.keys(decoded);
  if (!keys.every((key) => key === "v" || key === "source" || key === "id")) {
    throw invalidPortableState(
      "invalid_request",
      "Portable reasoning state schema is invalid.",
    );
  }
  return {
    ...(decoded.source !== undefined
      ? { source: providerIdentity(decoded.source, "invalid_request") }
      : {}),
    ...(decoded.id !== undefined
      ? { itemId: boundedString(decoded.id, 512, "invalid_request", "item ID") }
      : {}),
  };
}

function providerIdentity(
  value: unknown,
  kind: "configuration" | "invalid_request",
): ProviderIdentity {
  if (!isRecord(value) || !hasExactKeys(value, ["provider", "api", "model"])) {
    throw invalidPortableState(kind, "Portable reasoning state source is invalid.");
  }
  return {
    provider: boundedString(value.provider, 128, kind, "provider"),
    api: boundedString(value.api, 128, kind, "API"),
    model: boundedString(value.model, 512, kind, "model"),
  };
}

function boundedString(
  value: unknown,
  maxLength: number,
  kind: "configuration" | "invalid_request",
  field: string,
): string {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw invalidPortableState(kind, `Portable reasoning state ${field} is invalid.`);
  }
  return value;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function invalidPortableState(
  kind: "configuration" | "invalid_request",
  message: string,
): RouterFrameworkError {
  return new RouterFrameworkError(
    kind,
    message,
    "invalid_provider_continuation_state",
  );
}
