import { agentSuite } from "./suite.ts";
import { CLAUDE_PLAN_TOKEN, ON_PLAN_CLAUDE } from "./stack.ts";

agentSuite({
  agent: "claude",
  harness: "claude_code",
  args: (prompt) => ["-p", prompt, "--dangerously-skip-permissions"],
  onPlan: { model: ON_PLAN_CLAUDE, token: CLAUDE_PLAN_TOKEN },
  mainClass: "main",
  subagentType: "general-purpose",
});
