import { expect, test } from "bun:test";
import { join } from "node:path";

// The embedding cases drive the real Pi transport, which other test files
// replace with process-wide module mocks, so they run in their own process.
// The .cases.ts suffix keeps Bun from also running them in this one.
for (const cases of ["embedding.cases.ts", "meta_provider.cases.ts", "supplied_subscriptions.cases.ts", "session_pinning.cases.ts"]) {
  test(`${cases} pass in an isolated process`, async () => {
    const run = Bun.spawn(["bun", "test", `./${join("src", "http", cases)}`], {
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);
    expect({ exitCode, failures: exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, failures: "" });
  }, 30_000);
}
