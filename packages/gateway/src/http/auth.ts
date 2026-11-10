import { timingSafeEqual } from "node:crypto";

import { HttpError } from "./errors.js";

export function bearerToken(headers: Headers): string {
  const value = headers.get("authorization") ?? "";
  const [scheme, token] = value.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    throw new HttpError(401, "Missing or invalid API key.", "authentication_error");
  }
  return publicRoutingToken(token);
}

export function anthropicToken(headers: Headers): string {
  const authorization = headers.get("authorization");
  if (authorization) return bearerToken(headers);
  const apiKey = headers.get("x-api-key");
  if (!apiKey) {
    throw new HttpError(401, "Missing or invalid API key.", "authentication_error");
  }
  return publicRoutingToken(apiKey);
}

function publicRoutingToken(token: string): string {
  const internalToken = process.env.DARI_ROUTING_INTERNAL_TOKEN;
  if (internalToken && matchesInternalToken(token, internalToken)) {
    throw new HttpError(
      401,
      "Internal routing credentials cannot authorize public inference.",
      "authentication_error",
    );
  }
  return token;
}

function matchesInternalToken(token: string, internalToken: string): boolean {
  // Compare byte lengths, not character counts: timingSafeEqual throws on
  // buffers of different sizes, and a multi-byte character can match the
  // secret's character count without matching its byte length.
  const candidate = Buffer.from(token);
  const expected = Buffer.from(internalToken);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
