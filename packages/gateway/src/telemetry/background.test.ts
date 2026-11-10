import { afterEach, expect, test } from "bun:test";

import { deferred } from "../test_support/deferred.js";
import {
  drainBackgroundTelemetry,
  drainBackgroundTelemetryFor,
  trackBackgroundTelemetry,
} from "./background.js";

afterEach(async () => {
  await drainBackgroundTelemetry();
});

test("waits for tracked telemetry to settle", async () => {
  const task = deferred<void>();
  trackBackgroundTelemetry(task.promise);
  let drained = false;
  const draining = drainBackgroundTelemetry().then(() => {
    drained = true;
  });

  await Promise.resolve();
  expect(drained).toBe(false);
  task.resolve();

  await draining;
  expect(drained).toBe(true);
});

test("continues draining telemetry added while a drain is in progress", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  trackBackgroundTelemetry(first.promise);
  const draining = drainBackgroundTelemetry();

  trackBackgroundTelemetry(second.promise);
  first.resolve();
  await Promise.resolve();

  let drained = false;
  void draining.then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);

  second.resolve();
  await draining;
});

test("bounded drain includes telemetry added while draining", async () => {
  const first = deferred<void>();
  const addedDuringDrain = deferred<void>();
  trackBackgroundTelemetry(first.promise);

  const draining = drainBackgroundTelemetryFor(1_000);
  trackBackgroundTelemetry(addedDuringDrain.promise);
  first.resolve();
  await Promise.resolve();

  let drained = false;
  void draining.then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);

  addedDuringDrain.resolve();
  expect(await draining).toBe(0);
});

test("bounded drain returns the hung task count when its deadline arrives", async () => {
  const task = deferred<void>();
  trackBackgroundTelemetry(task.promise);

  expect(await drainBackgroundTelemetryFor(10)).toBe(1);
  task.resolve();
});

test("rejected telemetry is removed without rejecting either drain", async () => {
  trackBackgroundTelemetry(Promise.reject(new Error("telemetry failed")));

  expect(await drainBackgroundTelemetryFor(1_000)).toBe(0);
  await expect(drainBackgroundTelemetry()).resolves.toBeUndefined();
});
