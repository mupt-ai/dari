/* Query parameters as Dari's API has always validated them: a parameter that
   cannot be read fails the request with 422 and a FastAPI-shaped `detail`
   list naming every bad parameter, before any other check runs. */

import { HttpError } from "../http/errors.js";
import { parseInstantText, type Instant } from "./values.js";

type Issue = { type: string; loc: [string, string]; msg: string; input?: unknown };

/** An Activity error: `{"detail": ...}` with its status, as the API answers. */
export function activityError(status: number, detail: unknown): HttpError {
  return new HttpError(status, typeof detail === "string" ? detail : "Invalid request.", "activity_error", undefined, undefined, { detail });
}

export function badRequest(message: string): HttpError {
  return activityError(400, message);
}

export function notFound(message: string): HttpError {
  return activityError(404, message);
}

export class Params {
  private readonly issues: Issue[] = [];

  constructor(private readonly search: URLSearchParams) {}

  private last(name: string): string | undefined {
    return this.search.getAll(name).at(-1);
  }

  private fail(name: string, type: string, msg: string, input?: unknown): undefined {
    this.issues.push({ type, loc: ["query", name], msg, ...(input === undefined ? {} : { input }) });
    return undefined;
  }

  /** A required parameter's raw text. */
  private required(name: string): string | undefined {
    const value = this.last(name);
    if (value === undefined) this.fail(name, "missing", "Field required");
    return value;
  }

  string(name: string, options: { minLength?: number; maxLength?: number } = {}): string | undefined {
    const value = this.last(name);
    if (value === undefined) return undefined;
    if (options.minLength !== undefined && value.length < options.minLength) {
      return this.fail(name, "string_too_short", `String should have at least ${options.minLength} character${options.minLength === 1 ? "" : "s"}`, value);
    }
    if (options.maxLength !== undefined && value.length > options.maxLength) {
      return this.fail(name, "string_too_long", `String should have at most ${options.maxLength} characters`, value);
    }
    return value;
  }

  strings(name: string): string[] {
    return this.search.getAll(name);
  }

  int(name: string, options: { default?: number; ge?: number; le?: number } = {}): number {
    const text = options.default === undefined ? this.required(name) : this.last(name);
    if (text === undefined) return options.default ?? 0;
    // Pydantic also reads a float string with a zero fraction, such as "3600.0".
    if (!/^\s*[+-]?\d+(\.0*)?\s*$/.test(text)) {
      this.fail(name, "int_parsing", "Input should be a valid integer, unable to parse string as an integer", text);
      return 0;
    }
    const value = Number(text);
    if (options.ge !== undefined && value < options.ge) {
      this.fail(name, "greater_than_equal", `Input should be greater than or equal to ${options.ge}`, text);
    } else if (options.le !== undefined && value > options.le) {
      this.fail(name, "less_than_equal", `Input should be less than or equal to ${options.le}`, text);
    }
    return value;
  }

  literal<T extends string>(name: string, values: readonly T[]): T | undefined;
  literal<T extends string>(name: string, values: readonly T[], fallback: T): T;
  literal<T extends string>(name: string, values: readonly T[], fallback?: T): T | undefined {
    const value = this.last(name);
    if (value === undefined) return fallback;
    if (!(values as readonly string[]).includes(value)) {
      const expected = values.map((v) => `'${v}'`);
      const list = expected.length > 1 ? `${expected.slice(0, -1).join(", ")} or ${expected.at(-1)}` : expected[0];
      this.fail(name, "literal_error", `Input should be ${list}`, value);
      return fallback;
    }
    return value as T;
  }

  /** Fail with 422 when a required parameter is absent; read it with another method too. */
  requirePresent(name: string): void {
    this.required(name);
  }

  /** A repeated literal parameter; null when absent. Each bad item fails. */
  literals<T extends string>(name: string, values: readonly T[]): T[] | null {
    const items = this.search.getAll(name);
    if (items.length === 0) return null;
    for (const item of items) {
      if (!(values as readonly string[]).includes(item)) this.fail(name, "literal_error", "Input should be one of the allowed values", item);
    }
    return items as T[];
  }

  /** A boolean, read the way pydantic reads one from a query. */
  bool(name: string, fallback: boolean): boolean {
    const value = this.last(name);
    if (value === undefined) return fallback;
    const text = value.trim().toLowerCase();
    if (["1", "on", "t", "true", "y", "yes"].includes(text)) return true;
    if (["0", "off", "f", "false", "n", "no"].includes(text)) return false;
    this.fail(name, "bool_parsing", "Input should be a valid boolean, unable to interpret input", value);
    return fallback;
  }

  /** A required datetime; `naive` when it has no UTC offset. */
  instant(name: string): { instant: Instant; naive: boolean } {
    const text = this.required(name);
    if (text === undefined) return { instant: 0, naive: false };
    const parsed = parseInstantText(text);
    if (parsed === null) {
      this.fail(name, "datetime_from_date_parsing", "Input should be a valid datetime or date", text);
      return { instant: 0, naive: false };
    }
    return parsed;
  }

  /** Fail with 422 when any parameter could not be read. */
  done(): void {
    if (this.issues.length > 0) {
      throw new HttpError(422, "Request validation failed", "activity_error", undefined, undefined, {
        detail: "Request validation failed",
        errors: this.issues,
      });
    }
  }
}
