import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Non-Bun runtimes embed the gateway through its root entry, so nothing it
// reaches may touch Bun APIs; those live behind `./bun`.
test("the root entry reaches no Bun APIs", () => {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    expect({ file, bun: /\bBun\.|from "bun:/.test(source) }).toEqual({ file, bun: false });
    for (const [, specifier] of source.matchAll(/from "(\.{1,2}\/[^"]+)"/g)) {
      visit(resolveModule(dirname(file), specifier!));
    }
  };
  visit(join(import.meta.dir, "index.ts"));
  expect(seen.size).toBeGreaterThan(50);
});

function resolveModule(dir: string, specifier: string): string {
  const base = resolve(dir, specifier.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // Try the next layout.
    }
  }
  throw new Error(`Cannot resolve ${specifier} from ${dir}`);
}
