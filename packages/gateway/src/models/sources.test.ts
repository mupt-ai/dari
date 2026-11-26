import { expect, test } from "bun:test";

import { candidatesFor, checkSources, shouldSpendReset, type PlanOption } from "./sources.js";

test("checkSources accepts an ordered list and refuses bad ones", () => {
  expect(checkSources(["key", "plan", "reset"])).toEqual({ sources: ["key", "plan", "reset"] });
  expect(checkSources([])).toEqual({ sources: [] });
  expect(checkSources("plan")).toEqual({ error: "Sources must be a list of plan, reset, key, and managed." });
  expect(checkSources(["plan", "credits"])).toEqual({ error: 'Unknown source "credits"; use plan, reset, key, or managed.' });
  expect(checkSources(["plan", "plan"])).toEqual({ error: "Source plan is listed twice." });
  expect(checkSources(["reset", "plan"])).toEqual({ error: "Source reset must come right after plan." });
  expect(checkSources(["plan", "key", "reset"])).toEqual({ error: "Source reset must come right after plan." });
});

test("candidatesFor follows the sources' order and skips what cannot serve", async () => {
  const plans: PlanOption<string>[] = [
    { servesClient: true, candidate: async () => "plan-a" },
    { servesClient: false, candidate: async () => "plan-other-client" },
    { servesClient: true, candidate: async () => null },
  ];
  const keys = { key: async () => "key", managed: async () => "managed" };
  expect(await candidatesFor(["plan", "reset", "key", "managed"], plans, keys)).toEqual(["plan-a", "key", "managed"]);
  expect(await candidatesFor(["managed", "plan"], plans, keys)).toEqual(["managed", "plan-a"]);
  expect(await candidatesFor(["plan"], plans, keys)).toEqual(["plan-a"]);
  expect(await candidatesFor(["key", "managed"], plans, { key: async () => null, managed: async () => null })).toEqual([]);
});

const now = new Date("2026-11-25T00:00:00Z");
const hours = (n: number) => new Date(now.getTime() + n * 3_600_000);

test("shouldSpendReset spends on a long wait or a reset about to expire", () => {
  const policy = { sources: ["plan", "reset"] as const, resetMinHours: 24, now };
  const banked = [{ expiresAt: null }];
  expect(shouldSpendReset({ ...policy, returnsAt: hours(30), resets: banked })).toBe(true);
  expect(shouldSpendReset({ ...policy, returnsAt: hours(2), resets: banked })).toBe(false);
  expect(shouldSpendReset({ ...policy, returnsAt: hours(2), resets: [{ expiresAt: hours(1) }] })).toBe(true);
  expect(shouldSpendReset({ ...policy, returnsAt: hours(2), resets: [{ expiresAt: hours(3) }] })).toBe(false);
  expect(shouldSpendReset({ ...policy, returnsAt: hours(30), resets: [] })).toBe(false);
  expect(shouldSpendReset({ ...policy, sources: ["plan", "key"], returnsAt: hours(30), resets: banked })).toBe(false);
});
