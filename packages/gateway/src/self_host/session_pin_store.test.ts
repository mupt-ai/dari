import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { SessionPinStore } from "./session_pin_store.js";

test("stores one pin per router and key, replacing it on rewrite", () => {
  const store = new SessionPinStore(new Database(":memory:"));
  const key = { routerId: "default", pinKey: "hconv_main" };
  expect(store.read(key)).toBeNull();

  store.write({ ...key, model: "anthropic/claude-sonnet-5-5", reasoningEffort: "high" });
  store.write({ routerId: "other", pinKey: "hconv_main", model: "openai/gpt-5.5", reasoningEffort: "low" });
  expect(store.read(key)).toEqual({ model: "anthropic/claude-sonnet-5-5", reasoningEffort: "high" });

  store.write({ ...key, model: "openai/gpt-5.5", reasoningEffort: "medium" });
  expect(store.read(key)).toEqual({ model: "openai/gpt-5.5", reasoningEffort: "medium" });
});

test("drops pins idle past retention", () => {
  const store = new SessionPinStore(new Database(":memory:"));
  const stale = { routerId: "default", pinKey: "hconv_old" };
  store.write({ ...stale, model: "a/b", reasoningEffort: "off" }, new Date("2026-01-01T00:00:00Z"));
  store.write(
    { routerId: "default", pinKey: "hconv_new", model: "a/b", reasoningEffort: "off" },
    new Date("2026-03-01T00:00:00Z"),
  );
  expect(store.read(stale)).toBeNull();
});

test("serving a pin keeps it past the retention window", () => {
  const store = new SessionPinStore(new Database(":memory:"));
  const key = { routerId: "default", pinKey: "hconv_active" };
  store.write({ ...key, model: "a/b", reasoningEffort: "off" }, new Date("2026-01-01T00:00:00Z"));
  // Read daily-ish for 40 days; each read past a day refreshes the pin.
  for (let day = 2; day <= 40; day += 2) {
    expect(store.read(key, new Date(Date.UTC(2026, 0, day)))).toEqual({ model: "a/b", reasoningEffort: "off" });
  }
  // Unused for longer than retention, it is no longer served.
  expect(store.read(key, new Date("2026-04-01T00:00:00Z"))).toBeNull();
});
