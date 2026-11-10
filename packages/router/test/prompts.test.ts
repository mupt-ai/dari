import { expect, test } from "bun:test";

import {
  ANONYMOUS_ACTION_SYSTEM_PROMPT,
  ANONYMOUS_RULES_PROMPT,
  CUSTOM_RULES_PROMPT,
  SELECTOR_SYSTEM_PROMPT,
} from "../src/prompts.js";

test("selector prompts explain that missing benchmark scores are not negative evidence", () => {
  const guidance =
    "A missing benchmark score means that candidate pair was not evaluated on that benchmark; do not treat it as zero, failure, or negative evidence.";

  expect(SELECTOR_SYSTEM_PROMPT).toContain(guidance);
});

test("selector prompts define benchmark standing over scored candidate actions", () => {
  const namedGuidance =
    "Rank is each candidate action's standing among the scored candidate actions on that benchmark, and z_score uses that same candidate group.";

  expect(SELECTOR_SYSTEM_PROMPT).toContain(namedGuidance);
});

test("anonymous action prompt reads raw benchmark scores and missing ones", () => {
  expect(ANONYMOUS_ACTION_SYSTEM_PROMPT).toContain("Action blocks show raw benchmark scores");
  expect(ANONYMOUS_ACTION_SYSTEM_PROMPT).toContain("Missing scores mean unmeasured, NOT zero or failure.");
  expect(ANONYMOUS_ACTION_SYSTEM_PROMPT).not.toContain("Rank is");
  expect(ANONYMOUS_ACTION_SYSTEM_PROMPT).not.toContain("{{");
});

test("rule addenda define Auto, defaults, and rule priority over cost", () => {
  expect(CUSTOM_RULES_PROMPT).toContain("A null thinking_level means Auto");
  expect(CUSTOM_RULES_PROMPT).toContain("select default_target if it is set");
  expect(CUSTOM_RULES_PROMPT).toContain("A rule match is never traded away for cost");
  expect(ANONYMOUS_RULES_PROMPT).toContain("take priority over cost and benchmark scores");
  expect(ANONYMOUS_RULES_PROMPT).not.toContain("{{");
});
