import { beforeEach, expect, test } from "bun:test";

import { bindTestPlatform } from "../test_support/platform.js";
import { stopServerForShutdown } from "./serve.js";

beforeEach(() => {
  bindTestPlatform();
});

test("a graceful stop that settles is the only stop call", async () => {
  const calls: boolean[] = [];

  await stopServerForShutdown(
    {
      async stop(force: boolean) {
        calls.push(force);
      },
    },
    50,
    5,
  );

  expect(calls).toEqual([false]);
});

test("a graceful stop that hangs escalates to one awaited force stop", async () => {
  const calls: boolean[] = [];
  let forceSettled = false;

  await stopServerForShutdown(
    {
      async stop(force: boolean) {
        calls.push(force);
        if (!force) return new Promise<void>(() => {});
        await Bun.sleep(5);
        forceSettled = true;
      },
    },
    5,
    50,
  );

  expect(calls).toEqual([false, true]);
  expect(forceSettled).toBe(true);
});

test("a failed graceful stop is reported and ends the stop sequence", async () => {
  const calls: boolean[] = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  const startedAtMs = performance.now();
  try {
    await stopServerForShutdown(
      {
        stop(force: boolean) {
          calls.push(force);
          if (!force) throw new Error("graceful stop failed");
          return new Promise<void>(() => {});
        },
      },
      5,
      5,
    );
  } finally {
    console.warn = originalWarn;
  }

  expect(calls).toEqual([false]);
  expect(performance.now() - startedAtMs).toBeLessThan(100);
});

test("a hung force stop cannot consume the drain budget", async () => {
  const calls: boolean[] = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  const startedAtMs = performance.now();
  try {
    await stopServerForShutdown(
      {
        stop(force: boolean) {
          calls.push(force);
          return new Promise<void>(() => {});
        },
      },
      5,
      5,
    );
  } finally {
    console.warn = originalWarn;
  }

  expect(calls).toEqual([false, true]);
  expect(performance.now() - startedAtMs).toBeLessThan(100);
});
