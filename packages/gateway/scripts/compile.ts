#!/usr/bin/env bun
// Compiles the self-hosted gateway into standalone binaries, one per platform,
// packaged the way the Dari CLI installs them:
//   release/dari-gateway_<version>_<macOS|linux>_<x86_64|arm64>.tar.gz
//   release/dari-gateway_<version>_checksums.txt
// Usage: bun scripts/compile.ts [--current]   (--current builds only this machine's target)

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const out = join(root, "release");
const version: string = (await Bun.file(join(root, "package.json")).json()).version;

const targets = [
  { bun: "bun-darwin-arm64", os: "macOS", arch: "arm64" },
  { bun: "bun-darwin-x64", os: "macOS", arch: "x86_64" },
  { bun: "bun-linux-arm64", os: "linux", arch: "arm64" },
  { bun: "bun-linux-x64", os: "linux", arch: "x86_64" },
];
const current = `bun-${process.platform}-${process.arch}`;
const selected = process.argv.includes("--current") ? targets.filter((t) => t.bun === current) : targets;

// The router reads its prompt files next to its own module at import time.
// Importing them as files embeds them at /$bunfs/root/prompts/, which is where
// the bundled router looks.
const promptsDir = join(dirname(Bun.resolveSync("@mupt-ai/dari-router", root)), "prompts");
const entry = join(root, "release", ".entry.ts");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(
  entry,
  [
    ...readdirSync(promptsDir).map((name, i) =>
      `import prompt${i} from ${JSON.stringify(join(promptsDir, name))} with { type: "file" };`),
    `void [${readdirSync(promptsDir).map((_, i) => `prompt${i}`).join(", ")}];`,
    `const { runSelfHostedGateway } = await import(${JSON.stringify(join(root, "src/self_host/main.ts"))});`,
    "await runSelfHostedGateway();",
  ].join("\n"),
);

const checksums: string[] = [];
for (const target of selected) {
  const dir = join(out, target.bun);
  mkdirSync(dir);
  const result = await Bun.build({
    entrypoints: [entry],
    compile: { target: target.bun as Bun.Build.Target, outfile: join(dir, "dari-gateway") },
    naming: { asset: "prompts/[name].[ext]" },
    minify: true,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const archive = `dari-gateway_${version}_${target.os}_${target.arch}.tar.gz`;
  const tar = Bun.spawnSync(["tar", "-czf", join(out, archive), "-C", dir, "dari-gateway"]);
  if (tar.exitCode !== 0) throw new Error(`tar ${archive}: ${tar.stderr.toString()}`);
  rmSync(dir, { recursive: true });
  const sum = createHash("sha256").update(await Bun.file(join(out, archive)).bytes()).digest("hex");
  checksums.push(`${sum}  ${archive}`);
  console.log(`built ${archive}`);
}
rmSync(entry);
writeFileSync(join(out, `dari-gateway_${version}_checksums.txt`), `${checksums.join("\n")}\n`);
