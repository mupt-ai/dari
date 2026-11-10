import { expect, test } from "bun:test";

import { decideCacheSwitch } from "../src/cache_switch_decision.js";

const WARM_INCUMBENT = {
  fixedTurnCostUsd: 1.0,
  outputCostPerMtok: 14,
};

test("prunes cheaper-tier switches that do not save more than the threshold", () => {
  expect(
    decideCacheSwitch({
      warmIncumbent: WARM_INCUMBENT,
      switchCandidate: { fixedTurnCostUsd: 0.95, outputCostPerMtok: 4.4 },
      minSwitchSavingsRatio: 0.1,
    })
  ).toEqual({
    action: "prune",
    reason: "insufficient_savings",
    fixedTurnCostUsd: 0.95,
    savingsRatio: expect.closeTo(0.05),
  });

  expect(
    decideCacheSwitch({
      warmIncumbent: WARM_INCUMBENT,
      switchCandidate: { fixedTurnCostUsd: 0.9, outputCostPerMtok: 4.4 },
      minSwitchSavingsRatio: 0.1,
    }).action
  ).toBe("prune");
});

test("keeps cheaper-tier switches only when fixed-turn savings exceed the threshold", () => {
  expect(
    decideCacheSwitch({
      warmIncumbent: WARM_INCUMBENT,
      switchCandidate: { fixedTurnCostUsd: 0.8, outputCostPerMtok: 4.4 },
      minSwitchSavingsRatio: 0.1,
    })
  ).toEqual({
    action: "keep",
    reason: "saves_more_than_threshold",
    fixedTurnCostUsd: 0.8,
    savingsRatio: expect.closeTo(0.2),
  });
});

test("keeps switches without comparable pricing", () => {
  expect(
    decideCacheSwitch({
      warmIncumbent: WARM_INCUMBENT,
      switchCandidate: { fixedTurnCostUsd: null, outputCostPerMtok: 4.4 },
      minSwitchSavingsRatio: 0.1,
    })
  ).toEqual({ action: "keep", reason: "unknown_switch_cost" });

  expect(
    decideCacheSwitch({
      warmIncumbent: WARM_INCUMBENT,
      switchCandidate: { fixedTurnCostUsd: 0.95, outputCostPerMtok: null },
      minSwitchSavingsRatio: 0.1,
    })
  ).toEqual({ action: "keep", reason: "unknown_switch_output_price" });
});

test("keeps same-or-higher output price switches as possible capability upgrades", () => {
  expect(
    decideCacheSwitch({
      warmIncumbent: WARM_INCUMBENT,
      switchCandidate: { fixedTurnCostUsd: 1.05, outputCostPerMtok: 14 },
      minSwitchSavingsRatio: 0.1,
    })
  ).toEqual({
    action: "keep",
    reason: "not_cheaper_output_tier",
    fixedTurnCostUsd: 1.05,
  });

  expect(
    decideCacheSwitch({
      warmIncumbent: WARM_INCUMBENT,
      switchCandidate: { fixedTurnCostUsd: 8.0, outputCostPerMtok: 150 },
      minSwitchSavingsRatio: 0.1,
    }).action
  ).toBe("keep");
});
