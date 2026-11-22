/* Values as Activity reads and writes them: instants with microseconds,
   exact decimals, and the column values each database returns. Responses
   format them the way Dari's API always has (Python's datetime and Decimal),
   so the dashboard and CLI read the same text from any gateway. */

import type { ActivityDb } from "./sql.js";

/** Microseconds since the Unix epoch, UTC. */
export type Instant = number;

const MICROS_PER_MS = 1000;
const MICROS_PER_SECOND = 1_000_000;

export function instantFromDate(date: Date): Instant {
  return date.getTime() * MICROS_PER_MS;
}

/**
 * Canonical text for an instant: `YYYY-MM-DDTHH:MM:SS.ffffffZ`. Instants are
 * bound and stored in this form, so stored text sorts in time order.
 */
export function canonicalInstant(instant: Instant): string {
  const micros = ((instant % MICROS_PER_SECOND) + MICROS_PER_SECOND) % MICROS_PER_SECOND;
  const seconds = (instant - micros) / MICROS_PER_SECOND;
  const base = new Date(seconds * 1000).toISOString().slice(0, 19);
  return `${base}.${String(micros).padStart(6, "0")}Z`;
}

/** An instant as Dari's API writes one: fractional seconds only when nonzero. */
export function formatInstant(instant: Instant): string {
  const text = canonicalInstant(instant);
  return text.endsWith(".000000Z") ? `${text.slice(0, 19)}Z` : text;
}

/** A timestamp column as either database returns it. */
export function readInstant(value: unknown): Instant {
  if (value instanceof Date) return instantFromDate(value);
  if (typeof value === "string") {
    const parsed = parseInstantText(value);
    if (parsed !== null && !parsed.naive) return parsed.instant;
  }
  throw new Error(`Unreadable timestamp ${JSON.stringify(value)}.`);
}

export function readOptionalInstant(value: unknown): Instant | null {
  return value === null || value === undefined ? null : readInstant(value);
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * Parse a datetime as Dari's API accepts one in a query: ISO 8601 (a date
 * alone is midnight), or Unix seconds (milliseconds above 2e10). `naive` is a
 * value without a UTC offset; its instant reads it as UTC. Null when it is
 * not a datetime.
 */
export function parseInstantText(text: string): { instant: Instant; naive: boolean } | null {
  const trimmed = text.trim();
  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    let seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return null;
    if (Math.abs(seconds) > 2e10) seconds /= 1000;
    return { instant: Math.round(seconds * MICROS_PER_SECOND), naive: false };
  }
  const match = DATE_TIME.exec(trimmed);
  if (match === null) return null;
  const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = "", zone] = match;
  const hasTime = match[4] !== undefined;
  const fields = [Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second)];
  const [y, mo, d, h, mi, s] = fields as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(ms);
  if (check.getUTCDate() !== d || check.getUTCMonth() !== mo - 1) return null;
  let instant = ms * MICROS_PER_MS + Number(fraction.padEnd(6, "0") || "0");
  if (zone === undefined || !hasTime) {
    return zone === undefined ? { instant, naive: true } : null;
  }
  if (zone !== "Z" && zone !== "z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const offsetMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || "0");
    if (offsetMinutes >= 24 * 60) return null;
    instant -= sign * offsetMinutes * 60 * MICROS_PER_SECOND;
  }
  return { instant, naive: false };
}

/* Exact decimals: a coefficient and a power-of-ten exponent, like Python's
   Decimal, which keeps trailing zeros (Postgres numeric sums keep their
   scale, and the API has always printed it). */

export type Decimal = { coefficient: bigint; exponent: number };

const DECIMAL = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

export function parseDecimal(value: string | number): Decimal {
  const text = typeof value === "number" ? String(value) : value.trim();
  const match = DECIMAL.exec(text);
  if (match === null || (match[2] === "" && (match[3] ?? "") === "")) {
    throw new Error(`Not a decimal: ${JSON.stringify(value)}.`);
  }
  const [, sign, whole = "", fraction = "", exponent = "0"] = match;
  const digits = `${whole}${fraction}` || "0";
  const coefficient = BigInt(digits) * (sign === "-" ? -1n : 1n);
  return { coefficient, exponent: Number(exponent) - fraction.length };
}

export function addDecimals(left: Decimal, right: Decimal): Decimal {
  const exponent = Math.min(left.exponent, right.exponent);
  return {
    coefficient: left.coefficient * 10n ** BigInt(left.exponent - exponent)
      + right.coefficient * 10n ** BigInt(right.exponent - exponent),
    exponent,
  };
}

export function subtractDecimals(left: Decimal, right: Decimal): Decimal {
  return addDecimals(left, { coefficient: -right.coefficient, exponent: right.exponent });
}

/** Python's `str(Decimal)`. */
export function formatDecimal(value: Decimal): string {
  const negative = value.coefficient < 0n;
  const coefficient = (negative ? -value.coefficient : value.coefficient).toString();
  const leftDigits = value.exponent + coefficient.length;
  const dotPlace = value.exponent <= 0 && leftDigits > -6 ? leftDigits : 1;
  let integer: string;
  let fraction: string;
  if (dotPlace <= 0) {
    integer = "0";
    fraction = `.${"0".repeat(-dotPlace)}${coefficient}`;
  } else if (dotPlace >= coefficient.length) {
    integer = coefficient + "0".repeat(dotPlace - coefficient.length);
    fraction = "";
  } else {
    integer = coefficient.slice(0, dotPlace);
    fraction = `.${coefficient.slice(dotPlace)}`;
  }
  const exponent = leftDigits === dotPlace
    ? ""
    : `E${leftDigits - dotPlace >= 0 ? "+" : ""}${leftDigits - dotPlace}`;
  return `${negative ? "-" : ""}${integer}${fraction}${exponent}`;
}

/** Python's `decimal_text`: a numeric column's value as API text, or null. */
export function decimalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return formatDecimal(parseDecimal(value as string | number));
}

/** Add the present values to zero; null when none is present. */
export function sumDecimalText(values: readonly unknown[]): string | null {
  let total: Decimal | null = null;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const parsed = parseDecimal(value as string | number);
    total = total === null ? addDecimals({ coefficient: 0n, exponent: 0 }, parsed) : addDecimals(total, parsed);
  }
  return total === null ? null : formatDecimal(total);
}

/* Column values as the two databases return them: Postgres counts and
   bigints arrive as text, SQLite booleans as 0 and 1, SQLite JSON as text. */

export function readInt(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

export function readOptionalInt(value: unknown): number | null {
  return value === null || value === undefined ? null : readInt(value);
}

export function readOptionalBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return value === true || value === 1 || value === "1" || value === "t" || value === "true";
}

export function readBool(value: unknown): boolean {
  return readOptionalBool(value) ?? false;
}

/** A JSON column: Postgres returns it parsed, SQLite as its text. */
export function readJson(db: ActivityDb, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  return db.dialect === "sqlite" && typeof value === "string" ? JSON.parse(value) : value;
}

export function readOptionalString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
