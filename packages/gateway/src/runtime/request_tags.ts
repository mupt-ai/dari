import { HttpError } from "../http/errors.js";
import type { RequestTags } from "../platform/platform.js";

const TAGS_MAX_CHARS = 2048;
const TAGS_MAX_COUNT = 32;
const TAG_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const TAG_VALUE_MAX_CHARS = 256;

/**
 * Parse `X-Dari-Tags: run=r1,trial=3,setting=low` into attribution labels for
 * the platform's request and usage records. Malformed or oversized headers
 * are refused rather than silently dropped, so cost is never misattributed.
 */
export function requestTags(header: string | null): RequestTags {
  const tags: RequestTags = {};
  if (header === null || header.trim() === "") return tags;
  if (header.length > TAGS_MAX_CHARS) throw invalidTags(`X-Dari-Tags exceeds ${TAGS_MAX_CHARS} characters.`);
  const pairs = header.split(",");
  if (pairs.length > TAGS_MAX_COUNT) throw invalidTags(`X-Dari-Tags has more than ${TAGS_MAX_COUNT} tags.`);
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (separator < 0 || !TAG_KEY.test(key) || value.length > TAG_VALUE_MAX_CHARS) {
      throw invalidTags("X-Dari-Tags must be comma-separated key=value pairs.");
    }
    tags[key] = value;
  }
  return tags;
}

function invalidTags(message: string): HttpError {
  return new HttpError(400, message, "invalid_tags");
}
