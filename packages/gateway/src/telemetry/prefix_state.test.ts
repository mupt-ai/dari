import { expect, test } from "bun:test";

import { leaseCountdownForPrefix } from "./prefix_state.js";

test("lease countdown starts only when the granting turn served the leased pair", () => {
  const lease = {
    selectedModel: "openai/gpt-test",
    reasoningEffort: "medium" as const,
    reason: "Policy leased openai/gpt-test/medium for 10 turns.",
    leaseTurnsRemaining: 9,
  };
  const previous = {
    selectedModel: "fireworks/other",
    reasoningEffort: "off" as const,
    reason: "speculative",
  };

  // Non-speculative grant: the granting turn served the pair, countdown ran.
  expect(leaseCountdownForPrefix({ served: lease, next: null })).toBe(9);
  // Speculative kept the same pair: countdown ran.
  expect(leaseCountdownForPrefix({ served: lease, next: lease })).toBe(9);
  // Speculative switch served the previous pair: the commitment has not
  // started, so the granted turn is credited back.
  expect(leaseCountdownForPrefix({ served: previous, next: lease })).toBe(10);
  // Held turns carry their own countdown.
  expect(
    leaseCountdownForPrefix({
      served: { ...lease, leaseTurnsRemaining: 3 },
      next: null,
    }),
  ).toBe(3);
  // Per-turn decisions store nothing.
  expect(leaseCountdownForPrefix({ served: previous, next: null })).toBeNull();
});
