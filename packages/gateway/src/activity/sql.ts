/* SQL for Activity, written once for both databases it reads: the self-hosted
   gateway's SQLite and hosted Dari's Postgres. A query is a template of SQL
   text and bound values; `ActivityDb` compiles it for its dialect and runs
   it. Queries are written out in full, in SQL both databases accept.

   Select timestamps and money as text (`cast(x as text)`): Bun reads a
   Postgres timestamp as a `Date`, which drops microseconds, and a numeric
   as a string that can drop its scale. Read them with `readInstant` and
   `decimalText`. */

export type Dialect = "postgres" | "sqlite";

export type SqlValue = string | number | boolean | null;

/** A query or a piece of one: SQL text and the values bound into it. */
export class Sql {
  constructor(
    readonly strings: readonly string[],
    readonly values: readonly SqlValue[],
  ) {}
}

/**
 * Build SQL from a template. An interpolation becomes:
 * - another `Sql`: its text, inlined;
 * - a string, boolean, or null: a bound value;
 * - an integer: its digits (`limit ${n}`), so the planner sees the number;
 * - an array: its values, comma-separated, for `in (${ids})`. An empty array
 *   is `null`, which `in` never matches.
 */
export function sql(strings: TemplateStringsArray, ...args: Array<Sql | SqlValue | readonly SqlValue[]>): Sql {
  const parts: string[] = [strings[0]!];
  const values: SqlValue[] = [];
  const write = (text: string) => {
    parts[parts.length - 1] += text;
  };
  const add = (arg: Sql | SqlValue | readonly SqlValue[]): void => {
    if (arg instanceof Sql) {
      write(arg.strings[0]!);
      arg.values.forEach((value, index) => {
        values.push(value);
        parts.push(arg.strings[index + 1]!);
      });
    } else if (Array.isArray(arg)) {
      if (arg.length === 0) write("null");
      arg.forEach((item: SqlValue, index: number) => {
        if (index > 0) write(", ");
        add(item);
      });
    } else if (typeof arg === "number") {
      if (!Number.isSafeInteger(arg)) throw new Error(`Not an integer: ${arg}.`);
      write(String(arg));
    } else {
      values.push(arg as SqlValue);
      parts.push("");
    }
  };
  args.forEach((arg, index) => {
    add(arg);
    write(strings[index + 1]!);
  });
  return new Sql(parts, values);
}

/**
 * SQL text built at run time, such as a table alias or `asc`. Never pass it
 * anything a caller sent.
 */
export function raw(text: string): Sql {
  return new Sql([text], []);
}

export function join(parts: readonly Sql[], separator: string): Sql {
  if (parts.length === 0) return raw("");
  return parts.reduce((joined, part) => sql`${joined}${raw(separator)}${part}`);
}

/** Every condition, as one parenthesized condition; true when there are none. */
export function and(conditions: readonly Sql[]): Sql {
  return conditions.length === 0 ? sql`true` : sql`((${join(conditions, ") and (")}))`;
}

/** Any condition, as one parenthesized condition; false when there are none. */
export function or(conditions: readonly Sql[]): Sql {
  return conditions.length === 0 ? sql`false` : sql`((${join(conditions, ") or (")}))`;
}

/**
 * The pattern matching text that contains `query`, ignoring case, with `%`,
 * `_`, and `/` in the query matched literally. Use it as
 * `lower(x) like ${pattern} escape '/'`.
 */
export function likePattern(query: string): Sql {
  const escaped = query.replace(/[/%_]/g, (character) => `/${character}`);
  return sql`'%' || lower(${escaped}) || '%'`;
}

/** A database that answers Activity's queries. */
export type ActivityDb = {
  readonly dialect: Dialect;
  all<Row = Record<string, unknown>>(query: Sql): Promise<Row[]>;
};

export function compile(query: Sql, dialect: Dialect): { text: string; values: SqlValue[] } {
  let text = query.strings[0]!;
  for (let i = 1; i < query.strings.length; i += 1) {
    text += (dialect === "postgres" ? `$${i}` : "?") + query.strings[i]!;
  }
  const values = dialect === "sqlite"
    ? query.values.map((value) => (typeof value === "boolean" ? Number(value) : value))
    : [...query.values];
  return { text, values };
}

/** Postgres through Bun's client, which must be able to run `unsafe` queries. */
export function postgresActivityDb(client: {
  unsafe(text: string, values: SqlValue[]): Promise<unknown>;
}): ActivityDb {
  return {
    dialect: "postgres",
    async all<Row>(query: Sql) {
      const { text, values } = compile(query, "postgres");
      return [...((await client.unsafe(text, values)) as Row[])];
    },
  };
}

/** SQLite through `bun:sqlite`. */
export function sqliteActivityDb(database: {
  query(text: string): { all(...values: SqlValue[]): unknown[] };
}): ActivityDb {
  return {
    dialect: "sqlite",
    async all<Row>(query: Sql) {
      const { text, values } = compile(query, "sqlite");
      return database.query(text).all(...values) as Row[];
    },
  };
}
