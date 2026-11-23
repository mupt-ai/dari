import { expect, test } from "bun:test";

import { childToken, exchange } from "../link/client.js";
import { startStubGateway } from "./stub_gateway.js";

const STUB_MAIN = new URL("./stub_main.ts", import.meta.url).pathname;

// The stub as a process: its JSON line, read off stdout.
async function runStub(args: string[]) {
  const stub = Bun.spawn([process.execPath, STUB_MAIN, ...args], { stdout: "pipe", stderr: "pipe" });
  const reader = (stub.stdout as ReadableStream<Uint8Array>).getReader();
  let line = "";
  while (!line.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    line += new TextDecoder().decode(value);
  }
  return { stub, started: JSON.parse(line) as { baseUrl: string; controlUrl: string; app: { redirectUri: string } } };
}

test("models takes canonical ids, served on a child token, and refuses others with a clear error", async () => {
  await expect(startStubGateway({ models: ["gpt-6.1-sol"] })).rejects.toThrow(/canonical "provider\/model" ids.*gpt-6\.1-sol/);
  const gateway = await startStubGateway({ plans: ["openai_codex"], models: ["openai/gpt-6.1-sol"] });
  try {
    const { code, codeVerifier } = await gateway.connect();
    const { refreshToken } = await exchange({ ...gateway.app, code, codeVerifier });
    const child = await childToken({ ...gateway.app, refreshToken, models: [{ model: "openai/gpt-6.1-sol" }] });
    expect(child.accessToken).toBeString();
  } finally {
    await gateway.stop();
  }
});

test("the stub process takes --port 0, a loopback http redirect, and clients on /connect", async () => {
  const { stub, started } = await runStub([
    "--plans", "anthropic_claude_code", "--port", "0", "--redirect-uri", "http://127.0.0.1:3000/callback",
  ]);
  try {
    expect(new URL(started.baseUrl).port).not.toBe("0");
    expect(started.app.redirectUri).toBe("http://127.0.0.1:3000/callback");
    // A Claude Code plan shows only to an app acting as Claude Code: without
    // `clients` the page has nothing to approve, and says so briefly.
    const hidden = await fetch(`${started.controlUrl}/connect`, { method: "POST" });
    expect(hidden.status).toBe(400);
    const { error } = (await hidden.json()) as { error: string };
    expect(error).not.toContain("<");
    expect(error.length).toBeLessThan(400);
    const shown = await fetch(`${started.controlUrl}/connect`, { method: "POST", body: JSON.stringify({ clients: ["claude_code"] }) });
    expect(shown.status).toBe(200);
    expect(await shown.json()).toMatchObject({ code: expect.any(String), code_verifier: expect.any(String) });
    // Neither stand-in provider draws a startup warning.
    stub.kill();
    await stub.exited;
    const stderr = await new Response(stub.stderr as ReadableStream<Uint8Array>).text();
    expect(stderr).not.toContain("without credentials");
    expect(stderr).not.toContain("could not check");
  } finally {
    stub.kill();
    await stub.exited;
  }
});

test("the gateway exits with the process that started it, even one killed outright", async () => {
  const { stub, started } = await runStub(["--plans", "openai_codex"]);
  expect((await fetch(`${started.baseUrl}/v1/link/grant`)).status).toBe(401);
  stub.kill("SIGKILL");
  await stub.exited;
  let up = true;
  for (let attempt = 0; attempt < 100 && up; attempt += 1) {
    up = await fetch(`${started.baseUrl}/v1/link/grant`).then(() => true, () => false);
    if (up) await Bun.sleep(50);
  }
  expect(up).toBe(false);
});
