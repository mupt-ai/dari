import { expect, test } from "bun:test";

import { DONE } from "./model.ts";
import { agentSuite, expectAnswer } from "./suite.ts";
import { CHATGPT_PLAN_TOKEN, launch, ON_PLAN_GPT } from "./stack.ts";

agentSuite({
  agent: "opencode",
  harness: "opencode",
  args: (prompt) => ["run", prompt],
  onPlan: { model: ON_PLAN_GPT, token: CHATGPT_PLAN_TOKEN },
  mainClass: "main",
  subagentType: "general",
});

// OpenCode does not mark its requests; the plugin `dari opencode` installs does.
test.concurrent("opencode's session title is background work, not a turn", async () => {
  const session = await launch("opencode", ["run", "name this session"], { model: ON_PLAN_GPT });
  expectAnswer(session, DONE);
  const titles = session.activity.filter((step) => step.agentType === "title");
  expect(titles).toHaveLength(1);
  expect(titles[0]!.requestClass).toBe("auxiliary");
  // Background work never goes to the selector: the turn alone was routed.
  expect(session.activity.filter((step) => step.model === ON_PLAN_GPT).map((step) => step.requestClass)).toEqual(["main"]);
}, 180_000);
