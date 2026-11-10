import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The entrypoint runs as its own process, so no other test file's module mocks
// reach it, and the bind address comes from its real startup log.
async function listeningHostname(extraEnv: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dari-gateway-listen-"));
  const configPath = join(dir, "dari-gateway.yaml");
  writeFileSync(configPath, "routers:\n  default:\n    models: [local/model-a]\n");
  const gateway = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
    env: {
      PATH: process.env.PATH ?? "",
      DARI_GATEWAY_KEYS: "gw-key",
      DARI_GATEWAY_CONFIG: configPath,
      DARI_GATEWAY_DB: join(dir, "gateway.db"),
      PORT: "0",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    const line = await firstLineContaining(gateway.stdout, "dari-gateway listening");
    const log = JSON.parse(line.slice(line.indexOf("{"))) as { hostname: string };
    return log.hostname;
  } finally {
    gateway.kill();
    await gateway.exited;
  }
}

async function firstLineContaining(stream: ReadableStream<Uint8Array>, marker: string): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`gateway exited before logging "${marker}"`);
    buffered += decoder.decode(value, { stream: true });
    const line = buffered.split("\n").find((candidate) => candidate.includes(marker));
    if (line !== undefined) {
      reader.releaseLock();
      return line;
    }
  }
}

test("listens on loopback by default", async () => {
  expect(await listeningHostname({})).toBe("127.0.0.1");
}, 30_000);

test("DARI_GATEWAY_HOST sets the bind address", async () => {
  expect(await listeningHostname({ DARI_GATEWAY_HOST: "0.0.0.0" })).toBe("0.0.0.0");
}, 30_000);
