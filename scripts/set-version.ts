#!/usr/bin/env bun
// Sets one release version on every package, the way a release tag ships
// them: the CLI, gateway, and router are versioned together. The gateway's
// workspace dependency on the router becomes that exact published version.
// Usage: bun scripts/set-version.ts 1.2.3   (a leading "v" is accepted)
import { join, resolve } from "node:path";

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`usage: bun scripts/set-version.ts <semver>, got "${process.argv[2] ?? ""}"`);
  process.exit(1);
}
const root = resolve(import.meta.dir, "..");
for (const dir of ["packages/router", "packages/gateway"]) {
  const path = join(root, dir, "package.json");
  const manifest = await Bun.file(path).json();
  manifest.version = version;
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    if (typeof range === "string" && range.startsWith("workspace:")) manifest.dependencies[name] = version;
  }
  await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${manifest.name}@${version}`);
}
