import { agentSuite } from "./suite.ts";
import { CHATGPT_PLAN_TOKEN, ON_PLAN_GPT } from "./stack.ts";

// Pi has no subagents.
agentSuite({
  agent: "pi",
  harness: "pi",
  args: (prompt) => ["-p", prompt],
  onPlan: { model: ON_PLAN_GPT, token: CHATGPT_PLAN_TOKEN },
  mainClass: "main",
});
